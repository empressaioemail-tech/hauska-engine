/**
 * Adapter runner — fans out a set of adapters against an engagement's
 * parcel context, isolates per-adapter failures (Spec 51 §4 / locked
 * decision #6), and returns one outcome per adapter.
 *
 * The runner does NOT touch the database. Persistence happens in the
 * `routes/generateLayers` route which translates the runner's outcomes
 * into `briefing_sources` rows. Keeping IO out of the runner keeps it
 * trivially testable and lets the same code path drive a future "dry
 * run" preview UI without writing rows.
 *
 * Optional caching (Task #180): callers may pass a {@link
 * AdapterResultCache} + {@link AdapterCachePredicate} so federal
 * lookups (FEMA NFHL, USGS EPQS, EPA EJScreen, FCC broadband) skip the
 * network on a re-run within the cache's TTL. The cache is consulted
 * before `appliesTo` would have caused a network call, and a successful
 * run is written back through. Cache failures are best-effort — they
 * never fail the run; the underlying adapter is still invoked.
 */

import {
  type Adapter,
  type AdapterContext,
  type AdapterError,
  type AdapterRunOutcome,
  type UpstreamFreshness,
  AdapterRunError,
} from "./types";
import {
  toCacheKey,
  type AdapterCachePredicate,
  type AdapterResultCache,
} from "./cache";
import { DEFAULT_ADAPTER_TIMEOUT_MS } from "./timeouts";

export interface RunAdaptersInput {
  adapters: ReadonlyArray<Adapter>;
  context: AdapterContext;
  /**
   * Optional result cache. When set, the runner consults it before
   * invoking any adapter for which {@link cachePredicate} returns true,
   * and writes successful runs back through. See `cache.ts` for the
   * key shape and failure-isolation contract.
   */
  cache?: AdapterResultCache;
  /**
   * Decides which adapters are cacheable. Defaults to federal tier
   * only. Ignored when {@link cache} is undefined.
   */
  cachePredicate?: AdapterCachePredicate;
  /**
   * Bypass the cache lookup for this run — every cacheable adapter is
   * re-fetched live, but successful results are still written back
   * through `cache.put` so subsequent runs (without `forceRefresh`)
   * can hit the freshly-warmed entry. Task #204 wires this through
   * `?forceRefresh=true` on the generate-layers route so an architect
   * can manually punch through the cache when they suspect upstream
   * data has shifted.
   */
  forceRefresh?: boolean;
}

export async function runAdapters(
  input: RunAdaptersInput,
): Promise<AdapterRunOutcome[]> {
  const { adapters, context, cache, cachePredicate, forceRefresh } = input;
  // Filter first so the per-adapter timeout doesn't fire on adapters
  // that are gated out before they ever touch the network.
  const applicable = adapters.filter((a) => a.appliesTo(context));
  // Adapters that aren't applicable still appear in the outcome list as
  // `no-coverage` so the UI can render a complete tier table — Empressa
  // wants to see "we tried this layer but it doesn't cover this parcel"
  // rather than silently dropping the row.
  const skipped: AdapterRunOutcome[] = adapters
    .filter((a) => !a.appliesTo(context))
    .map((a) => ({
      adapterKey: a.adapterKey,
      tier: a.tier,
      layerKind: a.layerKind,
      status: "no-coverage" as const,
      error: {
        code: "no-coverage",
        message: `${a.adapterKey} not applicable for this jurisdiction.`,
      },
    }));
  // Run applicable adapters in parallel — they hit different upstream
  // services so there's no rate-limit concern, and the user-facing
  // "Generate Layers" call should be as snappy as the slowest adapter.
  const ran = await Promise.all(
    applicable.map((adapter) =>
      runOne(adapter, context, cache, cachePredicate, forceRefresh ?? false),
    ),
  );
  return [...ran, ...skipped];
}

async function runOne(
  adapter: Adapter,
  context: AdapterContext,
  cache: AdapterResultCache | undefined,
  cachePredicate: AdapterCachePredicate | undefined,
  forceRefresh: boolean,
): Promise<AdapterRunOutcome> {
  // Cache lookup — only when the adapter is cacheable AND the
  // coordinates are finite (NaN coordinates produce a deterministic
  // miss; the runner already documents that no-coords engagements
  // surface as `no-coverage` per-adapter outcomes). The cache contract
  // says implementations never throw, but we wrap defensively so a
  // misbehaving cache cannot break the runner.
  //
  // When `forceRefresh` is true we still compute the cache key so we
  // can `put` the fresh result back, but skip the `get` entirely so
  // the live upstream is consulted regardless of TTL.
  const cacheKey =
    cache && (cachePredicate ?? defaultCachePredicate)(adapter)
      ? toCacheKey(
          adapter.adapterKey,
          context.parcel.latitude,
          context.parcel.longitude,
        )
      : null;
  if (cache && cacheKey && !forceRefresh) {
    try {
      const hit = await cache.get(cacheKey);
      if (hit) {
        // Task #227 — ask the adapter (when it implements the hook)
        // whether the cached snapshot still tracks what the upstream
        // would return now. The check is best-effort: a thrown error
        // or a hook that doesn't exist both collapse to "no verdict
        // attached", which the FE renders as the existing "cached
        // <n>h ago" pill rather than the stale-warning variant.
        const upstreamFreshness = await checkUpstreamFreshness(
          adapter,
          context,
          hit.cachedAt,
        );
        return {
          adapterKey: adapter.adapterKey,
          tier: adapter.tier,
          layerKind: adapter.layerKind,
          status: "ok",
          result: hit.result,
          fromCache: true,
          cachedAt: hit.cachedAt.toISOString(),
          upstreamFreshness,
        };
      }
    } catch {
      // Best-effort cache — fall through to a live run.
    }
  }

  // Per-adapter timeout: max(runner default, adapter override) so a
  // longer caller-provided budget still wins and adapters can only
  // widen, never tighten, the per-call window.
  const baseTimeoutMs = context.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const timeoutMs =
    typeof adapter.timeoutMs === "number" && adapter.timeoutMs > baseTimeoutMs
      ? adapter.timeoutMs
      : baseTimeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Plumb the caller's signal through too — if the request handler
  // aborts (client disconnect / route timeout), every in-flight adapter
  // sees it.
  const externalSignal = context.signal;
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener("abort", () => ac.abort());
  }

  try {
    const result = await adapter.run({ ...context, signal: ac.signal });
    if (cache && cacheKey) {
      try {
        await cache.put(cacheKey, result);
      } catch {
        // Non-fatal — the row was still produced.
      }
    }
    return {
      adapterKey: adapter.adapterKey,
      tier: adapter.tier,
      layerKind: adapter.layerKind,
      status: "ok",
      result,
      fromCache: false,
      cachedAt: null,
      // Live runs are by definition the source of truth — there's no
      // stale cache to compare against, so the freshness verdict is
      // always null (not "fresh"; the FE branches on null to mean
      // "this row didn't go through the cache path").
      upstreamFreshness: null,
    };
  } catch (err) {
    const error = toAdapterError(err, ac.signal.aborted, timeoutMs);
    // Normalize: an adapter that ran but determined the parcel is not
    // covered by the upstream feed (throws AdapterRunError with
    // code="no-coverage") is semantically the same outcome as an
    // adapter the runner skipped because `appliesTo` returned false —
    // both translate to a `no-coverage` status on the wire so the UI
    // can render a single neutral pill instead of a misleading
    // "failed" badge.
    const status: "no-coverage" | "failed" =
      error.code === "no-coverage" ? "no-coverage" : "failed";
    return {
      adapterKey: adapter.adapterKey,
      tier: adapter.tier,
      layerKind: adapter.layerKind,
      status,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

const defaultCachePredicate: AdapterCachePredicate = (a) =>
  a.tier === "federal";

/**
 * Call the adapter's optional freshness hook (Task #227) without
 * letting a bad implementation break the cache-hit return path. The
 * runner serves the cached row regardless of the verdict — the
 * verdict is metadata the FE renders on top — so any throw or
 * malformed return collapses to an `unknown` status.
 */
async function checkUpstreamFreshness(
  adapter: Adapter,
  ctx: AdapterContext,
  cachedAt: Date,
): Promise<UpstreamFreshness | null> {
  if (typeof adapter.getUpstreamFreshness !== "function") return null;
  try {
    const verdict = await adapter.getUpstreamFreshness({ ctx, cachedAt });
    if (
      !verdict ||
      typeof verdict !== "object" ||
      typeof verdict.status !== "string" ||
      (verdict.status !== "fresh" &&
        verdict.status !== "stale" &&
        verdict.status !== "unknown")
    ) {
      return { status: "unknown", reason: "Freshness hook returned a malformed verdict." };
    }
    return {
      status: verdict.status,
      reason: typeof verdict.reason === "string" ? verdict.reason : null,
    };
  } catch (err) {
    return {
      status: "unknown",
      reason:
        err instanceof Error && err.message
          ? `Freshness check failed: ${err.message}`
          : "Freshness check failed.",
    };
  }
}

function toAdapterError(
  err: unknown,
  aborted: boolean,
  timeoutMs: number,
): AdapterError {
  if (err instanceof AdapterRunError) {
    return { code: err.code, message: err.message };
  }
  // AbortError shows up as a DOMException with name="AbortError" when
  // we cancel via the controller. Translate to a stable `timeout` code
  // so the UI can render "this layer timed out — retry".
  if (
    aborted ||
    (err instanceof Error && err.name === "AbortError") ||
    (err instanceof Error && /aborted/i.test(err.message))
  ) {
    return {
      code: "timeout",
      message: `Adapter exceeded ${timeoutMs}ms and was cancelled. Use Force refresh to retry.`,
    };
  }
  if (err instanceof Error) {
    // Best-effort categorization — anything that looks like a fetch
    // failure becomes `network-error`, everything else is `unknown`.
    const looksLikeFetch =
      err.name === "TypeError" || /fetch|network|ENOTFOUND|ECONN/i.test(err.message);
    const baseMsg = err.message || "Adapter run failed";
    // Avoid double-suffixing when an inner adapter (e.g. via
    // fetchWithRetry) has already appended the call-to-action.
    const message = /Force refresh/i.test(baseMsg)
      ? baseMsg
      : looksLikeFetch
        ? `${baseMsg} Use Force refresh to retry.`
        : baseMsg;
    return {
      code: looksLikeFetch ? "network-error" : "unknown",
      message,
    };
  }
  return { code: "unknown", message: "Adapter run failed (non-Error throw)" };
}
