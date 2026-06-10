/**
 * Shared types for state, local, and (future) federal adapters.
 *
 * An *adapter* is a producer that — given a parcel context — fetches one
 * cited overlay layer from a public GIS endpoint (or returns a deterministic
 * "no coverage" verdict) and emits a `briefing-source` row. The api-server's
 * generate-layers route runs an adapter set, isolates per-adapter failures
 * (Spec 51 §4 / DA-PI-2 contract), and writes the successful results into
 * `briefing_sources` keyed by `<jurisdiction-key>:<source-name>`.
 *
 * Drift note (DA-PI-4 recon): DA-PI-2's federal adapter precedent does not
 * exist in this room, so the contract defined here is the canonical one
 * DA-PI-2 should mirror when it lands. The shape mirrors the brief's
 * locked decision #1 ("common interface identical to federal adapters from
 * DA-PI-2") so the downstream wire shape is stable across tiers.
 *
 * Locked decision #3: each adapter's `adapterKey` is the
 * `<jurisdiction-key>:<source-name>` slug (e.g. `ugrc:dem`,
 * `grand-county-ut:zoning`). The runner packs this into the existing
 * `briefing_sources.provider` column rather than introducing a dedicated
 * `adapter` column — DA-PI-3's briefing engine already reads `provider` as
 * the source-attribution pointer, so no schema migration is required.
 */

/**
 * Tier classification matches the Site Context tab's grouping
 * (federal / state / local). Stored on the adapter so the runner can
 * group results without a per-adapter switch in the UI.
 */
export type AdapterTier = "federal" | "state" | "local";

/**
 * Wire-compatible producer flavor written to `briefing_sources.source_kind`.
 * `manual-upload` and `federal-adapter` are pre-existing values; the
 * DA-PI-4 sprint added `state-adapter` and `local-adapter`; the
 * Cortex prop-intel SCOPE B (2026-05-23) adds `national-aggregator`
 * for Regrid and any future national public-records aggregator that
 * is neither a federal agency direct-publish (USGS / FEMA / FCC / EPA)
 * nor a per-jurisdiction GIS feed.
 */
export type AdapterSourceKind =
  | "federal-adapter"
  | "state-adapter"
  | "local-adapter"
  | "national-aggregator";

/**
 * Minimal parcel descriptor an adapter needs to decide coverage and run a
 * lookup. Sourced from the engagement's geocode (lat/lng) plus the
 * resolved jurisdiction key. Address is optional — county GIS endpoints
 * sometimes accept address strings as a fallback when lat/lng misses a
 * polygon by a few feet.
 */
export interface AdapterParcelContext {
  latitude: number;
  longitude: number;
  address?: string | null;
}

/**
 * Resolved jurisdiction context — what state and (when applicable) what
 * county/city the engagement's parcel falls in. Both fields use the same
 * stable lowercase slug convention as `@workspace/codes` jurisdictions
 * (e.g. `utah`, `grand-county-ut`).
 *
 * `partnerCity` — Cortex prop-intel SCOPE B (2026-05-23). True when the
 * engagement's local jurisdiction has signed up as a Hauska substrate
 * partner city (Bastrop, TX today; more in follow-on). Gates the
 * per-county GIS adapters as opportunistic ENRICHMENT layers — for
 * non-partner jurisdictions the per-county adapters are skipped
 * entirely and Regrid (the national aggregator) is the sole baseline.
 * For partner cities, both fire: the per-county adapter as enrichment,
 * Regrid as baseline.
 *
 * Default is `false` / `undefined`. The api-server route that builds
 * the AdapterContext is responsible for stamping the flag from the
 * engagement record's partner-city marker (or from a hard-coded list
 * until a `partner_city` column lands).
 */
export interface AdapterJurisdiction {
  stateKey: AdapterStateKey | null;
  localKey: AdapterLocalKey | null;
  partnerCity?: boolean;
}

/** Stable slug per pilot state covered by DA-PI-4. */
export type AdapterStateKey = "utah" | "idaho" | "texas";

/** Stable slug per pilot local jurisdiction covered by DA-PI-4. */
export type AdapterLocalKey =
  | "grand-county-ut"
  | "lemhi-county-id"
  | "bastrop-tx";

/**
 * Runtime context passed to every adapter. `fetchImpl` is dependency-
 * injected so unit tests can hand-stub the network without touching the
 * upstream services. `signal` is forwarded into `fetch` so the runner
 * can cancel an in-flight adapter when the caller aborts.
 */
export interface AdapterContext {
  parcel: AdapterParcelContext;
  jurisdiction: AdapterJurisdiction;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Per-adapter network timeout (ms). Defaults to 15s in the runner —
   * adapters typically respond in <1s, so a hard cap here protects the
   * "Generate Layers" button from a single slow upstream stalling the
   * whole batch.
   */
  timeoutMs?: number;
}

/**
 * Successful adapter output. The runner persists this directly onto a
 * `briefing_sources` insert — the field names line up with the column
 * names so the route is a near-1:1 copy.
 */
export interface AdapterResult {
  /** Stable jurisdiction-key:source-name slug. Mirrors `provider`. */
  adapterKey: string;
  /** "federal" | "state" | "local" — for UI tier grouping. */
  tier: AdapterTier;
  /** `briefing_sources.layer_kind` slug. */
  layerKind: string;
  /** `briefing_sources.source_kind`. */
  sourceKind: AdapterSourceKind;
  /** Human-readable provider label, e.g. "Utah Geospatial Resource Center". */
  provider: string;
  /** Effective date for the upstream feed (ISO8601). */
  snapshotDate: string;
  /** Structured payload — what the briefing engine reads at resolution time. */
  payload: Record<string, unknown>;
  /** Optional free-text note (e.g. "fell back to OSM after county GIS 503"). */
  note?: string | null;
}

/** Failure verdict — adapter ran but the upstream said no / errored. */
export interface AdapterError {
  /** Stable error code; `no-coverage` is the deterministic "this adapter doesn't apply" verdict. */
  code:
    | "no-coverage"
    | "network-error"
    | "upstream-error"
    | "parse-error"
    | "timeout"
    | "unknown";
  /** Short human-readable blurb the UI surfaces in the per-source pill. */
  message: string;
}

/**
 * Verdict returned by an adapter's optional `getUpstreamFreshness`
 * hook (Task #227). The runner asks this question only on cache hits
 * — for live runs the result is by definition fresh and the field is
 * never populated. Status semantics:
 *
 *   - `fresh`   — upstream confirms the cached snapshot still tracks
 *                 what the feed would return now.
 *   - `stale`   — upstream has published a newer revision since the
 *                 cache was written; the architect should consider a
 *                 "Force refresh" before trusting this row.
 *   - `unknown` — the freshness check couldn't run (network blip,
 *                 metadata missing, parse error). Treated as a soft
 *                 signal — the UI surfaces it without escalating to a
 *                 full warning.
 *
 * `reason` is a short, human-readable phrase the FE folds into the
 * pill's tooltip so the architect can tell whether the warning is
 * "the layer was edited 3h ago" vs "we couldn't reach the upstream
 * metadata endpoint" without opening the dev tools.
 */
export type UpstreamFreshnessStatus = "fresh" | "stale" | "unknown";

export interface UpstreamFreshness {
  status: UpstreamFreshnessStatus;
  reason?: string | null;
}

/**
 * One adapter's run outcome. Either `result` (success) or `error`
 * (deterministic failure) is set; never both. The runner returns an
 * array of these — per-source failure isolation per locked decision #6.
 *
 * `fromCache` / `cachedAt` (Task #204): set on `status="ok"` outcomes
 * that were replayed from {@link AdapterResultCache} rather than
 * re-fetched live. `fromCache` defaults to `false` for live runs and
 * for non-`ok` statuses; `cachedAt` is the ISO8601 timestamp of when
 * the cache row was originally written so the UI can render a
 * "cached <n>h ago" pill without re-deriving the age elsewhere.
 *
 * `upstreamFreshness` (Task #227): set when a cache hit's adapter
 * exposes the {@link Adapter.getUpstreamFreshness} hook and the
 * runner was able to call it. `null`/absent for live runs, for
 * non-`ok` statuses, and for cache hits whose adapter does not
 * implement the hook. The Site Context tab uses the verdict to flip
 * the existing "cached <n>h ago" pill to a "cache may be stale"
 * variant when the upstream feed has likely moved.
 */
export interface AdapterRunOutcome {
  adapterKey: string;
  tier: AdapterTier;
  layerKind: string;
  status: "ok" | "no-coverage" | "failed";
  result?: AdapterResult;
  error?: AdapterError;
  /** True when this outcome's `result` was replayed from the cache. */
  fromCache?: boolean;
  /** ISO8601 cache write time when {@link fromCache} is true; otherwise null. */
  cachedAt?: string | null;
  /**
   * Upstream freshness verdict for cache-hit outcomes whose adapter
   * implements {@link Adapter.getUpstreamFreshness}. Null/absent for
   * live runs and for cache hits where the hook is not implemented.
   */
  upstreamFreshness?: UpstreamFreshness | null;
}

/**
 * Adapter contract. `appliesTo` is a synchronous pre-flight check the
 * runner uses to skip adapters whose jurisdiction doesn't match the
 * engagement (e.g. don't run the Utah DEM adapter for an Idaho parcel)
 * — that lets the runner short-circuit without a network call.
 */
export interface Adapter {
  /** Stable `<jurisdiction-key>:<source-name>` slug per locked decision #3. */
  readonly adapterKey: string;
  readonly tier: AdapterTier;
  readonly sourceKind: AdapterSourceKind;
  /** `briefing_sources.layer_kind` slug. */
  readonly layerKind: string;
  /** Human-readable provider label written to `briefing_sources.provider_label`. */
  readonly provider: string;
  /** State / local key this adapter is gated to. */
  readonly jurisdictionGate: {
    state?: AdapterStateKey;
    local?: AdapterLocalKey;
  };
  appliesTo(ctx: AdapterContext): boolean;
  /**
   * Optional adapter-specific timeout floor (ms). The runner takes
   * `max(adapter.timeoutMs, context.timeoutMs)` so known-slow
   * upstreams (e.g. OSM Overpass with its server-side `[timeout:25]`
   * directive) can widen the per-adapter budget past the runner
   * default. Leave unset for the common case.
   */
  readonly timeoutMs?: number;
  /**
   * Run the adapter. Throws `AdapterRunError` for handled failure modes
   * — the runner translates the throw into an {@link AdapterRunOutcome}
   * with `status: "failed"`. Anything else propagates so the runner can
   * mark it `unknown` without losing the trace.
   */
  run(ctx: AdapterContext): Promise<AdapterResult>;
  /**
   * Optional cheap "is the cached snapshot still current?" check
   * (Task #227). The runner calls this only on cache hits and only
   * when defined; live runs skip it because a fresh fetch is by
   * definition the source of truth.
   *
   * Implementations should be cheap relative to {@link run} — a HEAD
   * request, an ETag conditional GET, or a metadata-endpoint round-
   * trip — because the whole point of consulting the cache was to
   * avoid the expensive call. Anything that throws is collapsed by
   * the runner to an `unknown` verdict, so implementations don't
   * need their own error wrapping.
   *
   * `cachedAt` is the timestamp of the cached row the runner is
   * about to serve — implementations compare it against the
   * upstream's "last published" signal to decide between `fresh`
   * and `stale`.
   */
  getUpstreamFreshness?(args: {
    ctx: AdapterContext;
    cachedAt: Date;
  }): Promise<UpstreamFreshness>;
}

/**
 * Tagged error adapters throw to signal a deterministic failure mode the
 * runner should record on the briefing rather than letting bubble up as
 * an unhandled 500. Mirrors the convention used by
 * `@workspace/codes-sources` (its TocFetchError) so the registry layer
 * can treat both alike.
 */
export class AdapterRunError extends Error {
  readonly code: AdapterError["code"];
  constructor(code: AdapterError["code"], message: string) {
    super(message);
    this.name = "AdapterRunError";
    this.code = code;
  }
}
