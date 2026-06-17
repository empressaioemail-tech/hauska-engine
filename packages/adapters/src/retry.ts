/**
 * Shared retry helper for adapter HTTP calls.
 *
 * Retries only transient upstream failures: HTTP 408/429/5xx and
 * network resets / unattributed AbortErrors. Hard 4xx responses are
 * returned on the first try. Caller-driven aborts propagate
 * immediately as `timeout`.
 */
import { AdapterRunError } from "./types";

/** HTTP statuses we treat as transient and retryable. */
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 502, 503, 504,
]);

export interface FetchWithRetryOptions {
  /** Hard cap on attempts (initial try + retries). Default: 3. */
  maxAttempts?: number;
  /** Base delay between retries in ms (jittered). Default: 250. */
  baseDelayMs?: number;
  /** Max delay between retries in ms. Default: 2_000. */
  maxDelayMs?: number;
  /** Caller's abort signal — if it fires we bail immediately. */
  signal?: AbortSignal;
  /** Injected fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Injected sleep (for tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Friendly upstream label used in failure messages. */
  upstreamLabel?: string;
  /**
   * QA-22 reopen follow-on. When `true`, a final-attempt fetch throw
   * (DNS failure / TLS reject / ECONNREFUSED / ECONNRESET / aborted
   * by network reset / etc.) no longer throws `AdapterRunError(
   * "network-error", …)` from this helper; instead the helper returns
   * a synthetic 599-status response with the {@link
   * FetchWithRetryResult.throwExcerpt} field populated. The caller's
   * existing `!res.ok` branch then composes its own failure pill that
   * names the underlying network failure mode (e.g. `Network error:
   * ENOTFOUND getaddrinfo gis.grandcountyutah.net`) — the operator
   * can tell apart DNS-vs-TLS-vs-firewall failures from the row pill
   * alone, without needing Cloud Run log access.
   *
   * Off by default so callers that don't opt in keep the existing
   * "request failed after N attempts: <message>" wording. Transient
   * throws still retry exactly as before; only the *final-attempt*
   * throw behaviour changes (return-with-throwExcerpt vs. throw).
   *
   * Wired on by arcgis.ts / epa-ejscreen.ts / fcc-broadband.ts —
   * the three call sites that back the QA-22-affected adapters
   * (epa:ejscreen, fcc:broadband, grand-county-ut:parcels,
   * grand-county-ut:zoning). Other adapters (USGS NED, FEMA NFHL,
   * the state/* lookups, the OSM Overpass roads fallback) keep the
   * legacy throw posture until a separate dispatch widens the
   * adoption.
   */
  captureThrowsAsResult?: boolean;
}

/**
 * Returned by {@link fetchWithRetry} on success. Carries the final
 * `Response` plus the count of attempts taken so callers can include
 * it in their on-failure error message ("retried N times").
 */
export interface FetchWithRetryResult {
  response: Response;
  attempts: number;
  /**
   * First ~{@link BODY_EXCERPT_MAX_CHARS} characters of the response
   * body, populated only when the returned `response.ok` is false
   * (i.e. the caller will throw an `AdapterRunError` with this excerpt
   * appended so the failure pill carries the upstream's actual error
   * message — "Service is down for maintenance", an ArcGIS in-band
   * error envelope, a Cloudflare interstitial, etc).
   *
   * Populated for both transient-status retry exhaustion (the
   * captured body is from the final attempt) and for the hard-4xx
   * single-attempt path. Absent when the body read itself threw or
   * the response stream was already consumed (in which case the
   * caller's existing "HTTP X after N attempts" message stands
   * unchanged).
   *
   * The body read consumes the response stream, so callers MUST NOT
   * `await response.json()` / `.text()` themselves on a non-OK
   * response — they should read this field instead.
   *
   * QA-22 reopen: added so an operator triaging a layer-generation
   * failure can see *why* the upstream rejected the call without
   * needing Cloud Run log access for every triage iteration.
   */
  bodyExcerpt?: string;
  /**
   * Compact one-line summary of a fetch *throw* (DNS failure, TLS
   * reject, ECONNREFUSED, ECONNRESET, etc). Format: `<cause.code>
   * <cause.syscall> <cause.host|address:port>` when those fields
   * are present on `err.cause` (node:undici's standard shape), or
   * `<err.name>: <err.message>` as a fallback when no cause
   * structure is attached.
   *
   * Populated only when {@link FetchWithRetryOptions.captureThrowsAsResult}
   * is set AND a fetch attempt threw (the final attempt for
   * transient throws, any attempt for non-transient ones). When
   * populated, the helper synthesizes a 599-status response so the
   * caller's `!res.ok` branch fires; the caller is expected to
   * branch on this field and produce a failure pill that names the
   * underlying network failure mode (vs. the bare "fetch failed"
   * the legacy throw posture surfaces).
   *
   * Mutually exclusive with `bodyExcerpt` in practice (the 599
   * synthesis happens before any body would be read), but no
   * structural invariant — a future contributor could populate
   * both without violating the type.
   *
   * QA-22 reopen follow-on: PR #88's bodyExcerpt path doesn't
   * trigger for fetch-throw failures (no response object exists);
   * this field closes that gap so the operator can tell apart DNS-
   * vs-TLS-vs-firewall failures from the row pill alone.
   */
  throwExcerpt?: string;
}

/**
 * Cap on the response-body excerpt captured for the failure-message
 * path. Sized so the excerpt fits comfortably inside one log line and
 * one FE failure pill — generous enough to include an ArcGIS error
 * envelope's `message` field and a typical service-unavailable HTML
 * heading without bloating the layer-failure row payload.
 */
export const BODY_EXCERPT_MAX_CHARS = 256;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isCallerAbort(signal: AbortSignal | undefined): boolean {
  return Boolean(signal && signal.aborted);
}

/** Heuristic for "this fetch failure looks like a network reset / blip". */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg) return false;
  // node:undici surfaces resets as a TypeError with cause.code = "..."
  // and message "fetch failed" / "terminated"; the broader regex below
  // catches the codes that bubble up directly too.
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|terminated|fetch failed|socket hang up|network|ENETUNREACH/i.test(
    msg,
  );
}

/** Heuristic: the only safe time to treat an "aborted" throw as
 *  retryable is when the caller's own signal did NOT trigger it.
 *  Anything aborted by us must propagate immediately. */
function isUnattributedAbort(err: unknown, callerAborted: boolean): boolean {
  if (callerAborted) return false;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && /This operation was aborted/i.test(err.message))
    return true;
  return false;
}

/**
 * Read up to {@link BODY_EXCERPT_MAX_CHARS} of a response body for
 * inclusion in the caller's failure message. Returns `undefined` when
 * the body read throws (already consumed, network reset mid-read,
 * unusable transport) — the caller falls back to the bare
 * "HTTP X after N attempts" wording it had before.
 *
 * Collapses runs of whitespace so the excerpt remains compact when
 * the upstream returned a pretty-printed HTML error page; preserves
 * the visible characters so an ArcGIS error envelope's `message`
 * field stays readable.
 */
/**
 * Compact one-line summary of a fetch-throw `Error` for use in a
 * failure pill. Returns `undefined` when the throw carries no useful
 * structure (so the caller falls back to whatever message it had
 * before — generally the bare `err.message`).
 *
 * node:undici surfaces network failures as a `TypeError` whose
 * `cause` is a node `Error` with `{ code, errno, syscall, address,
 * port, host }` populated. We surface the cause-side fields when
 * present because they are what the operator needs to choose the
 * mitigation (DNS resolver pinning vs. NAT egress IP allocation vs.
 * CA bundle injection vs. TLS version pin); the outer `err.message`
 * is usually a useless "fetch failed" or "terminated".
 *
 * Fallback when no cause structure attached: `<err.name>: <err.message>`.
 * Capped at {@link BODY_EXCERPT_MAX_CHARS} so a pathological case
 * cannot bloat the failure pill.
 *
 * QA-22 reopen follow-on.
 */
export function readThrowExcerpt(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;

  const cause = (err as { cause?: unknown }).cause;
  const causeObj =
    cause && typeof cause === "object" ? (cause as Record<string, unknown>) : null;

  const parts: string[] = [];

  // Cause.code is the operator's primary triage signal (ENOTFOUND
  // vs CERT_HAS_EXPIRED vs ECONNREFUSED → completely different
  // mitigation paths). Always lead with it when present.
  const code = causeObj?.code;
  if (typeof code === "string" && code.length > 0) parts.push(code);

  // syscall (`getaddrinfo`, `connect`, `read`) disambiguates DNS-vs-
  // TCP-vs-stream failures inside the same code family.
  const syscall = causeObj?.syscall;
  if (typeof syscall === "string" && syscall.length > 0) parts.push(syscall);

  // Hostname (TLS SNI / DNS lookup target) and the resolved address /
  // port. Prefer hostname when both are present; fall back to
  // address[:port] for ECONNREFUSED-style codes that may carry only
  // the resolved tuple.
  const host = causeObj?.host ?? causeObj?.hostname;
  if (typeof host === "string" && host.length > 0) {
    parts.push(host);
  } else {
    const address = causeObj?.address;
    if (typeof address === "string" && address.length > 0) {
      const port = causeObj?.port;
      parts.push(
        typeof port === "number" || (typeof port === "string" && port.length > 0)
          ? `${address}:${port}`
          : address,
      );
    }
  }

  if (parts.length > 0) {
    const joined = parts.join(" ");
    return joined.length > BODY_EXCERPT_MAX_CHARS
      ? `${joined.slice(0, BODY_EXCERPT_MAX_CHARS)}…`
      : joined;
  }

  // Fall back to the outer error shape when nothing useful sits on
  // `cause` (e.g. a hand-thrown Error from a test fake, or a
  // non-undici fetch path that doesn't follow the cause convention).
  const fallback = `${err.name || "Error"}: ${err.message || "(no message)"}`;
  return fallback.length > BODY_EXCERPT_MAX_CHARS
    ? `${fallback.slice(0, BODY_EXCERPT_MAX_CHARS)}…`
    : fallback;
}

/**
 * Synthesize a 599-status response carrying no body. Returned by
 * {@link fetchWithRetry} when a fetch attempt throws and the caller
 * opted in to `captureThrowsAsResult` — the synthetic response
 * collapses the throw-path failure into the same `!res.ok` branch
 * the caller already has for HTTP non-OK responses, letting the
 * caller compose its failure message off the `throwExcerpt` field.
 *
 * 599 is intentionally outside the standard HTTP range so a downstream
 * `if (res.status === 504)`-style branch can't accidentally treat it
 * as a real gateway timeout.
 */
function synthesizeThrowResponse(): Response {
  return new Response("", {
    status: 599,
    statusText: "Network Error (no upstream response)",
  });
}

async function readBodyExcerpt(res: Response): Promise<string | undefined> {
  try {
    const raw = await res.text();
    if (!raw) return undefined;
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    return collapsed.length > BODY_EXCERPT_MAX_CHARS
      ? `${collapsed.slice(0, BODY_EXCERPT_MAX_CHARS)}…`
      : collapsed;
  } catch {
    return undefined;
  }
}

function jitteredBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  // Exponential: base * 2^(attempt-1), capped at maxMs, with +/- 25%
  // jitter so a thundering herd of adapters do not all retry at the
  // same instant.
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const cap = Math.min(exp, maxMs);
  const jitter = cap * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cap + jitter));
}

/**
 * Drop-in `fetch` replacement that retries transient failures with
 * exponential backoff + jitter. Returns the `Response` for a successful
 * (or terminally-failed) attempt; the caller is responsible for
 * checking `response.ok` for non-transient HTTP errors (e.g. 400, 404).
 *
 * On final give-up after exhausting retries, throws an
 * {@link AdapterRunError} whose message names the upstream + retry
 * count so the on-screen failure pill is actionable. The error code is
 * one of `network-error`, `timeout`, or `upstream-error` so existing
 * FE branching keeps working.
 */
export async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  opts: FetchWithRetryOptions = {},
): Promise<FetchWithRetryResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.baseDelayMs ?? 250;
  const maxMs = opts.maxDelayMs ?? 2_000;
  const label = opts.upstreamLabel ?? "Upstream";

  // Forward the caller's signal into every attempt so the per-adapter
  // timeout in the runner wins — we never retry past a caller abort.
  const reqInit: RequestInit = { ...init, signal: opts.signal ?? init?.signal };

  let lastTransientStatus: number | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCallerAbort(opts.signal)) {
      throw new AdapterRunError(
        "timeout",
        `${label} did not respond in time — the request exceeded its time budget before attempt ${attempt} could start. Use Force refresh to retry.`,
      );
    }
    let res: Response;
    try {
      res = await fetchFn(input, reqInit);
    } catch (err) {
      // Caller aborted mid-flight: surface as timeout, no retry.
      // Wins over `captureThrowsAsResult` because the abort is a
      // semantic "the budget elapsed" signal, not a network failure
      // class — the operator wants to see "did not respond in time",
      // not "Network error: AbortError".
      if (isCallerAbort(opts.signal)) {
        throw new AdapterRunError(
          "timeout",
          `${label} did not respond in time — the request exceeded its time budget during attempt ${attempt}. Use Force refresh to retry.`,
        );
      }
      const transient =
        isTransientNetworkError(err) || isUnattributedAbort(err, false);
      if (transient && attempt < maxAttempts) {
        // Retry — same backoff posture as today; the throw-capture
        // path only kicks in on the final attempt (or a non-transient
        // throw on any attempt) so transient blips still self-heal.
        lastNetworkError = err;
        await sleep(jitteredBackoff(attempt, baseMs, maxMs));
        continue;
      }
      // QA-22 reopen follow-on — final-attempt or non-transient
      // throw. When the caller opted in via `captureThrowsAsResult`,
      // collapse the throw into the same `!res.ok` branch the caller
      // uses for HTTP non-OK responses: synthesize a 599 response and
      // attach a `throwExcerpt` summary so the caller can compose a
      // failure pill that names the underlying network failure mode.
      // Callers that didn't opt in keep the legacy throw posture
      // unchanged, preserving the existing wording for the OSM
      // Overpass / USGS NED / FEMA NFHL / state-tier call sites.
      if (opts.captureThrowsAsResult) {
        return {
          response: synthesizeThrowResponse(),
          attempts: attempt,
          throwExcerpt: readThrowExcerpt(err),
        };
      }
      throw new AdapterRunError(
        "network-error",
        `${label} request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${err instanceof Error ? err.message : String(err)}. Use Force refresh to retry.`,
      );
    }
    // Retryable HTTP statuses → backoff + try again.
    if (TRANSIENT_STATUS_CODES.has(res.status)) {
      lastTransientStatus = res.status;
      if (attempt === maxAttempts) {
        // Final attempt failed with a transient status — capture the
        // body excerpt before returning so the caller's failure
        // message can carry the upstream's actual error text. Body
        // read replaces the previous drain (we no longer need the
        // socket — the request is over).
        return {
          response: res,
          attempts: attempt,
          bodyExcerpt: await readBodyExcerpt(res),
        };
      }
      // Drain the body so the connection can be reused.
      try {
        await res.text();
      } catch {
        // ignore — we're just freeing the socket.
      }
      await sleep(jitteredBackoff(attempt, baseMs, maxMs));
      continue;
    }
    // Non-transient response (2xx success or hard 4xx). When the hard
    // status is non-OK (400/401/403/404/422/…), capture the body
    // excerpt up-front so the adapter's `!res.ok` branch can include
    // it in the failure message without a second body read (which
    // would throw — the stream is single-shot).
    if (!res.ok) {
      return {
        response: res,
        attempts: attempt,
        bodyExcerpt: await readBodyExcerpt(res),
      };
    }
    return { response: res, attempts: attempt };
  }
  // Unreachable — the loop returns or throws on every iteration. The
  // explicit throw keeps TypeScript happy and gives a sane crash if
  // the loop logic is ever broken.
  throw new AdapterRunError(
    "upstream-error",
    `${label} retry loop exited unexpectedly (last status ${lastTransientStatus ?? "n/a"}, lastErr ${lastNetworkError ? String(lastNetworkError) : "n/a"}). Use Force refresh to retry.`,
  );
}
