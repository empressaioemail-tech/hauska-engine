/**
 * FCC Broadband Data Collection (BDC) — federal broadband-availability
 * adapter.
 *
 * **Gated off by default as of 2026-05-23 (QA-22 SCOPE B closeout).**
 * PR #96's structured logging + the workstation curl recon in session
 * `doc_repo/_sessions/2026-05-23_qa22_fcc_recon_cc-agent-C.md`
 * confirmed the endpoint
 * `https://broadbandmap.fcc.gov/nbm/map/api/published/location/availability`
 * is Akamai-WAF-gated: server RSTs at ~19s or holds 60s with zero
 * bytes for any client UA (adapter UA, browser UA, even the FCC
 * homepage HEAD). PR #94's 90s timeout + 15-min cache fix can't help
 * because no successful response ever arrives.
 *
 * The binding is kept imported + exported so:
 *   - the FCC-specific unit tests in `federalAdapters.test.ts` keep
 *     running (they don't depend on registry membership);
 *   - an operator can flip the gate back via `FCC_ENABLED=true` on
 *     the Cloud Run service env if a future use case re-emerges
 *     (e.g. FCC ships a non-WAF-fronted programmatic endpoint, or
 *     we move to the BDC bulk-download CSV path) — no code redeploy
 *     required, just a service-config push.
 *
 * Registration is gated in {@link isFccEnabled} +
 * {@link FEDERAL_ADAPTERS} in `lib/adapters/src/registry.ts`. With
 * the gate off, `runAdapters(...)` produces zero outcomes for
 * `fcc:broadband` and the per-source pill in the Site Context tab
 * renders nothing (not even `no-coverage`).
 *
 * Uses the documented BDC v2 "availability at coordinate" JSON
 * endpoint, which accepts a lat/lng and returns one row per
 * fixed-broadband provider serving the BDC fabric location. The call
 * goes through {@link fetchWithRetry} so a transient FCC blip is
 * retried before we surface a row as failed. Output payload shape is
 * unchanged from prior revisions so downstream readers keep working.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { fetchWithRetry } from "../retry";
import { CACHE_COORDINATE_PRECISION } from "../cache";

/**
 * BDC v2 published JSON endpoint. Documented at
 * https://broadbandmap.fcc.gov/data-download/nationwide-data — the
 * "location availability" lookup.
 */
const FCC_BDC_AVAILABILITY_ENDPOINT =
  "https://broadbandmap.fcc.gov/nbm/map/api/published/location/availability";
const FCC_BROADBAND_LABEL = "FCC National Broadband Map";

/**
 * Per-adapter timeout floor for `fcc:broadband`. QA-22 upstream-probe
 * dispatch (2026-05-23) raised this from `SLOW_UPSTREAM_TIMEOUT_MS`
 * (45s) to **90s** for this adapter only — the FCC BDC v2 endpoint
 * routinely answers slower than the shared 45s floor on the canary
 * Musgrave / Redd engagements (cortex-api-00020-85n pill:
 * `did not respond in time during attempt 1`). The hostname is valid
 * and `broadbandmap.fcc.gov` loads in browser; the upstream is
 * legitimately slow, not unreachable.
 *
 * UGRC / EPA / Grand County intentionally NOT raised — each of those
 * has a different failure mode (per QA-22 throw-path capture) and a
 * blanket bump would hide DNS / firewall / TLS classes behind a
 * `timeout` pill that no longer reflects the actual root cause.
 */
const FCC_BROADBAND_TIMEOUT_MS = 90_000;

/**
 * In-memory result cache for `fcc:broadband` only. Sits in front of
 * the existing 24h Postgres-backed `adapter_response_cache` (federal
 * tier, see `artifacts/api-server/src/lib/adapterCache.ts`); the
 * shorter window catches the operator-reload case where the same
 * engagement's Generate Layers runs twice within the same minute,
 * before the Postgres cache row has been committed and read back, or
 * when the runner is invoked without a backing Postgres cache (tests,
 * scripts).
 *
 * Key shape mirrors {@link CACHE_COORDINATE_PRECISION} — coordinates
 * rounded to 5 decimal places (~1.1m at the equator) so a parcel that
 * geocodes to slightly different coordinates on a re-run still hits
 * the cache. Same precision the Postgres cache uses, so an in-memory
 * hit and a Postgres hit are interchangeable for the same parcel.
 *
 * Module-scoped — one Map per process. Generate Layers is a route
 * handler, so this lives as long as the api-server instance. Bounded
 * by the natural cardinality of cached parcels × 15min (small in
 * practice — single-tenant deployment).
 */
const FCC_BROADBAND_INMEM_TTL_MS = 15 * 60 * 1000;

interface FccInMemEntry {
  result: AdapterResult;
  expiresAt: number;
}

const fccInMemCache: Map<string, FccInMemEntry> = new Map();

function fccCacheKey(latitude: number, longitude: number): string {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  const lat = Math.round(latitude * factor) / factor;
  const lng = Math.round(longitude * factor) / factor;
  return `${lat},${lng}`;
}

/**
 * Read a non-expired entry. Mutates the cache on expiry so a stale
 * row does not accumulate memory forever; the next caller for the
 * same key takes the live path and re-fills.
 */
function fccCacheGet(key: string, now: number): AdapterResult | null {
  const entry = fccInMemCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    fccInMemCache.delete(key);
    return null;
  }
  return entry.result;
}

function fccCachePut(key: string, result: AdapterResult, now: number): void {
  fccInMemCache.set(key, {
    result,
    expiresAt: now + FCC_BROADBAND_INMEM_TTL_MS,
  });
}

/**
 * Test-only — clear the module-scoped cache so a fresh test case
 * does not see a hit from a previous test in the same vitest worker.
 * Exported instead of being implicit via `vi.resetModules()` because
 * the adapter is a singleton object, not a factory, so module reset
 * would also drop the adapter binding the test asserts against.
 */
export function __resetFccInMemCacheForTests(): void {
  fccInMemCache.clear();
}

/**
 * QA-22 SCOPE B follow-up (2026-05-23, dispatch
 * `2026-05-23_cc-agent-C_qa22_fcc_recon`) — structured per-request
 * log lines so the next operator triage round can read the actual
 * FCC failure mode straight off Cloud Run logs.
 *
 * Cloud Run's logs explorer auto-parses JSON-formatted stdout/stderr
 * lines as structured entries, so a plain `console.info` / `console.warn`
 * with a stringified field bag lands as a filterable record without
 * dragging a logger dependency into the adapters package (which has
 * stayed IO-free apart from the injected `fetch`). Field naming
 * mirrors the pino-style shape used by `ifcIngest.ts`'s
 * `ifc ingest: complete` log line (PR #87 / QA-33 diagnostic
 * logging), so operators don't have to learn two filter idioms.
 *
 * Emits three events:
 *   - `fcc:broadband request start` (info) — outbound request URL,
 *     coordinates, configured timeout.
 *   - `fcc:broadband request ok` (info) — wall-clock duration,
 *     attempt count, response size, provider count.
 *   - `fcc:broadband request failed` (warn) — error class
 *     (timeout / network / status / parse), wall-clock duration,
 *     and either the throw excerpt (no response) or the body
 *     excerpt (non-OK response) that PR #92 / PR #88 already
 *     capture.
 *
 * Out of scope for this dispatch: making the EPA / Grand County
 * adapters emit the same shape. The dispatch is FCC-only.
 */
type FccLogLevel = "info" | "warn";
type FccLogFields = Record<string, unknown>;

function fccLogEvent(
  level: FccLogLevel,
  msg: string,
  fields: FccLogFields,
): void {
  // Tee through `console.warn` for failures so Cloud Run renders them
  // at the same severity an operator filters on; everything else lands
  // on `console.info` (severity INFO in Cloud Run's logs explorer).
  const out = { level, msg, adapter_key: "fcc:broadband", ...fields };
  let line: string;
  try {
    line = JSON.stringify(out);
  } catch {
    // Field bag carries something non-serializable (a circular ref or
    // a Symbol). Fall back to a string-message-only entry so we still
    // get a log line for the event; the operator can re-run the trace
    // with the bad field removed if it ever comes up.
    line = JSON.stringify({ level, msg, adapter_key: "fcc:broadband" });
  }
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * Identifying User-Agent for the FCC NBM call. Several public broker
 * endpoints (Apache-fronted) 406 requests without a recognized UA;
 * spelling one out keeps the production call from tripping that gate.
 */
const FCC_BROADBAND_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

/**
 * Freshness window for the FCC National Broadband Map snapshot.
 *
 * The Broadband DATA Collection (BDC, post-Form 477) publishes new
 * fabric versions every six months (June + December filing windows),
 * and ISP deployment churn between filings can move a parcel from
 * "no fixed broadband" to gigabit fiber. 6 months keeps the warning
 * aligned with the publishing cadence — anything older than one BDC
 * cycle is the auditable sweet spot for "you should re-run this".
 */
export const FCC_BROADBAND_FRESHNESS_THRESHOLD_MONTHS = 6;

function federalApplies(ctx: AdapterContext): boolean {
  // PL-04: federal adapters apply nationwide whenever the engagement is
  // geocoded. See fema-nfhl.ts for the decoupling rationale.
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

interface FccProviderRow {
  provider: string | null;
  technologyCode: number | null;
  maxAdvertisedDownstreamMbps: number | null;
  maxAdvertisedUpstreamMbps: number | null;
  isResidential: boolean | null;
}

/** Coerce a number from either a number or stringified-number field. */
function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Translate one BDC availability row (or one ArcGIS feature attribute
 * bag, kept for backward-compat with any cached envelopes still in
 * the ArcGIS shape) into the normalized provider record the briefing
 * engine consumes.
 *
 * BDC v2 ships fields like `brand_name`, `technology` /
 * `technology_code`, `max_advertised_download_speed`,
 * `max_advertised_upload_speed`, and `low_latency`. The legacy ArcGIS
 * shape used `BrandName`, `TechCode`, `MaxAdDown`, `MaxAdUp`,
 * `LowLatency`, `Residential`. We accept both so a partial rollout
 * (or a cached row from before this task landed) keeps decoding.
 */
function toProviderRow(attrs: Record<string, unknown>): FccProviderRow {
  const provider =
    pickString(attrs.brand_name) ??
    pickString(attrs.BrandName) ??
    pickString(attrs.provider_name);
  const technologyCode =
    pickNumber(attrs.technology_code) ??
    pickNumber(attrs.TechCode) ??
    pickNumber(attrs.technology);
  const down =
    pickNumber(attrs.max_advertised_download_speed) ??
    pickNumber(attrs.MaxAdDown) ??
    pickNumber(attrs.max_down);
  const up =
    pickNumber(attrs.max_advertised_upload_speed) ??
    pickNumber(attrs.MaxAdUp) ??
    pickNumber(attrs.max_up);
  let isResidential: boolean | null = null;
  if (typeof attrs.low_latency === "boolean") isResidential = attrs.low_latency;
  else if (typeof attrs.LowLatency === "boolean") isResidential = attrs.LowLatency;
  else if (typeof attrs.Residential === "number") isResidential = attrs.Residential === 1;
  else if (typeof attrs.residential === "number") isResidential = attrs.residential === 1;
  return {
    provider,
    technologyCode,
    maxAdvertisedDownstreamMbps: down,
    maxAdvertisedUpstreamMbps: up,
    isResidential,
  };
}

/**
 * Walk the BDC envelope's nested shapes and return the flat list of
 * provider attribute bags. BDC v2 returns `{ data: [...] }` for the
 * primary contract; we also accept `{ providers: [...] }` and the
 * legacy ArcGIS `{ features: [{ attributes: {...} }] }` envelope so
 * cached rows and any future contract shifts both decode.
 */
function extractProviderAttrs(
  envelope: unknown,
): Record<string, unknown>[] {
  if (!envelope || typeof envelope !== "object") return [];
  const env = envelope as {
    data?: unknown;
    providers?: unknown;
    features?: unknown;
  };
  if (Array.isArray(env.data)) {
    return env.data.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object",
    );
  }
  if (Array.isArray(env.providers)) {
    return env.providers.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object",
    );
  }
  if (Array.isArray(env.features)) {
    return env.features
      .map((f) => (f as { attributes?: unknown }).attributes)
      .filter(
        (a): a is Record<string, unknown> =>
          Boolean(a) && typeof a === "object",
      );
  }
  return [];
}

export const fccBroadbandAdapter: Adapter = {
  adapterKey: "fcc:broadband",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "fcc-broadband-availability",
  provider: "FCC National Broadband Map",
  jurisdictionGate: {},
  // QA-22 upstream-probe (2026-05-23) — see FCC_BROADBAND_TIMEOUT_MS
  // for the 45s → 90s rationale. The other QA-22-affected adapters
  // (EPA / Grand County) intentionally stay at the shared
  // SLOW_UPSTREAM_TIMEOUT_MS because their failure modes (DNS, TCP
  // connect-timeout from Cloud Run egress) wouldn't be helped by a
  // longer budget.
  timeoutMs: FCC_BROADBAND_TIMEOUT_MS,
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    // QA-22 upstream-probe — in-memory cache check before the live
    // call. See FCC_BROADBAND_INMEM_TTL_MS comment for the why
    // (catches the operator-reload-within-15min case + tests/scripts
    // without a Postgres cache).
    const now = Date.now();
    const key = fccCacheKey(ctx.parcel.latitude, ctx.parcel.longitude);
    const cached = fccCacheGet(key, now);
    if (cached) {
      // Re-stamp `snapshotDate` to "now" so downstream freshness
      // calculations don't treat the cached row as older than the
      // current process actually believes it is. The provider /
      // payload contract is unchanged.
      return { ...cached, snapshotDate: nowIso() };
    }

    const url = new URL(FCC_BDC_AVAILABILITY_ENDPOINT);
    url.searchParams.set("lat", String(ctx.parcel.latitude));
    url.searchParams.set("lng", String(ctx.parcel.longitude));
    const urlString = url.toString();

    // QA-22 SCOPE B follow-up — request-start log so operators can
    // correlate the request id Cloud Run assigns to the adapter call
    // with the eventual `request ok` / `request failed` event in the
    // same span. The full URL is logged (including lat/lng query
    // params) so a triage filter `jsonPayload.msg="fcc:broadband
    // request start"` returns the exact URL the adapter built.
    fccLogEvent("info", "fcc:broadband request start", {
      url: urlString,
      lat: ctx.parcel.latitude,
      lng: ctx.parcel.longitude,
      timeout_ms: FCC_BROADBAND_TIMEOUT_MS,
    });
    const startedAtMs = Date.now();

    const {
      response: res,
      attempts,
      bodyExcerpt,
      throwExcerpt,
    } = await fetchWithRetry(
      urlString,
      {
        signal: ctx.signal,
        // Apache front doors (and the FCC NBM tile server in particular)
        // 406 requests without a recognized `User-Agent`. Spell both UA
        // and Accept out so Node fetch's defaults don't trigger that gate.
        headers: {
          "User-Agent": FCC_BROADBAND_USER_AGENT,
          Accept: "application/json, */*;q=0.1",
        },
      },
      {
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: FCC_BROADBAND_LABEL,
        // QA-22 reopen follow-on — collapse fetch-throws (DNS / TLS /
        // ECONNREFUSED / ECONNRESET / timeout) into the `!res.ok`
        // branch below so the pill can name the actual network
        // failure mode. cortex-api-00020-85n showed FCC's BDC v2
        // endpoint failing with "did not respond in time" (no
        // retries) — operator can't tell whether that's a real
        // upstream slowness or an aborted-by-firewall connect.
        captureThrowsAsResult: true,
      },
    );
    if (!res.ok) {
      const durationMs = Date.now() - startedAtMs;
      if (throwExcerpt) {
        // The request never got a response back — DNS resolution, TLS
        // handshake, connection establishment, or stream read failed
        // before the BDC endpoint's HTTP layer answered.
        // `throwExcerpt` names the underlying failure mode so the
        // operator can pick the mitigation off the pill alone.
        fccLogEvent("warn", "fcc:broadband request failed", {
          url: urlString,
          // `network` covers caller-abort-translated-to-timeout too —
          // PR #92's `captureThrowsAsResult` rolls aborted-by-runner
          // into the throw path with a useful throwExcerpt. The
          // operator can disambiguate by inspecting `throw_excerpt`
          // (which carries the cause code from undici).
          error_type: "network",
          attempts,
          duration_ms: durationMs,
          throw_excerpt: throwExcerpt,
        });
        throw new AdapterRunError(
          "network-error",
          `FCC National Broadband Map did not get a response after ${attempts} attempt${attempts === 1 ? "" : "s"}. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
        );
      }
      // QA-22 reopen: append the upstream body excerpt so a non-OK
      // from the FCC BDC v2 endpoint surfaces its actual response
      // (envelope error, HTML error page, empty body) in the layer-
      // failure pill — operators don't need Cloud Run access to tell
      // schema drift from transient flakiness.
      fccLogEvent("warn", "fcc:broadband request failed", {
        url: urlString,
        error_type: "status",
        http_status: res.status,
        attempts,
        duration_ms: durationMs,
        body_excerpt: bodyExcerpt,
      });
      const suffix = bodyExcerpt ? ` Upstream response: ${bodyExcerpt}` : "";
      throw new AdapterRunError(
        "upstream-error",
        `FCC National Broadband Map responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.${suffix} Use Force refresh to retry.`,
      );
    }
    // Capture the response wire size *before* `res.json()` consumes
    // the stream, via the Content-Length header when the upstream
    // populates it. Falls back to `undefined` when absent so the
    // log entry doesn't claim a misleading zero.
    const contentLengthRaw = res.headers.get("content-length");
    const responseSizeBytes =
      contentLengthRaw && /^\d+$/.test(contentLengthRaw)
        ? Number(contentLengthRaw)
        : undefined;
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      fccLogEvent("warn", "fcc:broadband request failed", {
        url: urlString,
        error_type: "parse",
        http_status: res.status,
        attempts,
        duration_ms: durationMs,
        // The body has already been consumed (or attempted) at this
        // point, so we surface the parse error's own message rather
        // than re-reading the stream.
        parse_error_message:
          err instanceof Error ? err.message : String(err),
      });
      throw new AdapterRunError(
        "parse-error",
        `FCC NBM response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const durationMs = Date.now() - startedAtMs;
    const rows = extractProviderAttrs(json);
    if (rows.length === 0) {
      const emptyResult: AdapterResult = {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "broadband-availability",
          providerCount: 0,
          fastestDownstreamMbps: null,
          fastestUpstreamMbps: null,
          providers: [],
        },
        note: "FCC reports no fixed-broadband deployment at this location.",
      };
      // Cache the empty result too — a parcel with no fixed-broadband
      // deployment is a stable answer for the 15-minute window, and
      // re-hitting FCC cold for the same null answer is exactly what
      // the cache is for.
      fccCachePut(key, emptyResult, now);
      fccLogEvent("info", "fcc:broadband request ok", {
        url: urlString,
        http_status: res.status,
        attempts,
        duration_ms: durationMs,
        response_size_bytes: responseSizeBytes,
        provider_count: 0,
      });
      return emptyResult;
    }
    const providers = rows.map(toProviderRow);
    const downs = providers
      .map((p) => p.maxAdvertisedDownstreamMbps)
      .filter((n): n is number => typeof n === "number");
    const ups = providers
      .map((p) => p.maxAdvertisedUpstreamMbps)
      .filter((n): n is number => typeof n === "number");
    const populatedResult: AdapterResult = {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "broadband-availability",
        providerCount: providers.length,
        fastestDownstreamMbps: downs.length > 0 ? Math.max(...downs) : null,
        fastestUpstreamMbps: ups.length > 0 ? Math.max(...ups) : null,
        providers,
      },
    };
    fccCachePut(key, populatedResult, now);
    fccLogEvent("info", "fcc:broadband request ok", {
      url: urlString,
      http_status: res.status,
      attempts,
      duration_ms: durationMs,
      response_size_bytes: responseSizeBytes,
      provider_count: providers.length,
    });
    return populatedResult;
  },
};
