/**
 * Regrid — national parcel + zoning baseline adapter pair.
 *
 * Cortex prop-intel SCOPE B (2026-05-23). Settled by the
 * Partnership-first scoping decision
 * (`doc_repo/_decisions/2026-05-23_partnership_first_scoping.md`):
 * Cortex product-baseline data sourcing is OUT of scope for the
 * Partnership-first commitment, so a commercial public-records
 * aggregator is the right pattern for national parcel + zoning
 * coverage. cc-agent-C2 and cc-agent-C both ran SCOPE A vendor
 * evaluations and convergently picked Regrid over ATTOM and
 * CoreLogic on schema fit (standardized zoning_type / zoning_subtype),
 * rolling monthly refresh cadence, and self-serve pricing.
 *
 * Two adapters, one upstream call
 * --------------------------------
 * Regrid's `/api/v2/parcels/point` endpoint returns both parcel
 * geometry + properties AND zoning (when the account tier supports
 * it) in a single response. We expose two adapter objects —
 * `regrid:parcels` and `regrid:zoning` — to mirror the existing per-
 * layer Site Context tab pills (one row per layer-kind), but they
 * share a process-local in-memory dedup cache keyed by lat/lng. The
 * first adapter to run for a given parcel makes the upstream call;
 * the second adapter awaits the same in-flight Promise. Net cost:
 * one upstream call per engagement, two briefing-source rows.
 *
 * Trial-token coverage gate
 * --------------------------
 * Regrid's trial token is restricted to 7 counties (UT not among
 * them on the operator's current plan as of 2026-05-23). The
 * endpoint returns HTTP 200 with an error envelope when the trial
 * token hits an out-of-coverage lat/lng. The adapter surfaces this
 * as a `no-coverage` verdict (NOT a hard `upstream-error`) so the
 * per-row pill reads cleanly. Operator is upgrading to a paid plan
 * after this integration ships.
 *
 * Tier
 * ----
 * `tier: "federal"` rather than introducing a new `"national"` tier
 * — the dispatch allows either, and reusing `"federal"` avoids a
 * cross-cutting diff into `lib/site-context/src/client/SiteMap.tsx`
 * (TIER_STYLES + TIER_LABELS) and `lib/site-context/src/client/
 * overlays.ts` (SiteMapOverlayTier). The operator-visible source
 * attribution lives at `source_kind = "national-aggregator"`, which
 * IS a new value and IS surfaced on the wire. UI cleanup to a real
 * "national" tier can land in a follow-on with the rest of the
 * tier-rendering work if the UX surface flags it as confusing.
 *
 * Cache
 * -----
 * Inherits the existing 24h Postgres `adapter_response_cache` (federal
 * tier is cached by the runner's default predicate) + the 15-min
 * in-memory dedup added here. Both adapters share the in-memory
 * dedup; the Postgres cache stores one row per adapter_key (so two
 * rows after a successful run — parcels and zoning), which is fine
 * because the upstream cost is already paid by the in-memory dedup.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { CACHE_COORDINATE_PRECISION } from "../cache";

/** Regrid Parcel API v2 — point lookup endpoint per the OpenAPI spec. */
const REGRID_POINT_ENDPOINT = "https://app.regrid.com/api/v2/parcels/point";

const REGRID_PROVIDER_LABEL = "Regrid";

/**
 * In-memory dedup TTL (ms). Matches `fcc:broadband`'s 15-min window —
 * long enough to coalesce the operator-reload case where the same
 * engagement's Generate Layers runs twice in quick succession, short
 * enough that the Postgres-backed 24h cache is the real long-term
 * caching layer.
 */
const REGRID_INMEM_TTL_MS = 15 * 60 * 1000;

/**
 * Default per-adapter timeout floor (ms). Regrid is a hosted
 * commercial API with predictable p95 ~ 1-2s on point queries; 30s
 * is conservative-with-headroom for occasional slowness or a transient
 * network hiccup retried inside `fetchWithRetry`. Smaller than the
 * SLOW_UPSTREAM_TIMEOUT_MS budget (45s) the local-county GIS feeds
 * carry because Regrid does NOT have the ArcGIS slow-feed pathology.
 */
const REGRID_TIMEOUT_MS = 30_000;

/** Identifying UA. Same convention as the other federal/local adapters. */
const REGRID_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

/**
 * Freshness window for the Regrid snapshot, in months.
 *
 * Regrid's `ll_last_refresh` carries the county-specific data
 * acquisition date. Coverage is rebuilt on a rolling monthly cadence
 * per county, so 6 months is the operationally-conservative threshold
 * for "you should re-pull this" — anything older than two refresh
 * cycles is the audit boundary that should prompt a Force refresh.
 * Tighter than ATTOM's quarterly cadence by design.
 */
export const REGRID_FRESHNESS_THRESHOLD_MONTHS = 6;

/**
 * Structured per-request logging mirroring PR #96's `fccLogEvent`
 * pattern on fcc-broadband.ts. JSON-stringified `{level, msg,
 * adapter_key, ...fields}` lines on `console.info` / `console.warn`
 * so Cloud Run's logs explorer auto-parses them as structured
 * entries; the `adapter_key` field is stamped per-adapter so a
 * filter like `jsonPayload.adapter_key="regrid:parcels"` pulls one
 * adapter's trace cleanly.
 *
 * Three events emitted per upstream call:
 *   - `regrid request start` (info) — full URL (with token redacted),
 *     lat/lng, configured timeout.
 *   - `regrid request ok` (info) — wall-clock duration, response
 *     size (Content-Length when populated), parcel count, zoning
 *     count.
 *   - `regrid request failed` (warn) — error class
 *     (`network` / `status` / `parse` / `out-of-coverage` for the
 *     trial-token coverage gate), wall-clock duration, body / throw
 *     excerpt where available.
 *
 * Defensive against non-serializable field values — falls back to a
 * level+msg-only entry rather than throwing inside the adapter's hot
 * path.
 */
type RegridLogLevel = "info" | "warn";
type RegridLogFields = Record<string, unknown>;

function regridLogEvent(
  level: RegridLogLevel,
  msg: string,
  adapterKey: string,
  fields: RegridLogFields,
): void {
  const out = { level, msg, adapter_key: adapterKey, ...fields };
  let line: string;
  try {
    line = JSON.stringify(out);
  } catch {
    line = JSON.stringify({ level, msg, adapter_key: adapterKey });
  }
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * Redact the API token query parameter so it doesn't end up in log
 * lines. The endpoint URL otherwise reads identically for triage.
 */
function redactToken(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) {
      u.searchParams.set("token", "<redacted>");
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** GeoJSON Feature returned by the Regrid `/parcels/point` endpoint. */
export interface RegridGeoJsonFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: {
    headline?: string;
    path?: string;
    fields?: Record<string, unknown>;
    [k: string]: unknown;
  };
  id?: number | string;
}

/** Top-level envelope of `/parcels/point` per the OpenAPI spec. */
export interface RegridPointResponse {
  parcels?: {
    type: "FeatureCollection";
    features: RegridGeoJsonFeature[];
  };
  zoning?: {
    type: "FeatureCollection";
    features: RegridGeoJsonFeature[];
  };
  /**
   * Error envelope shape used by the trial-token coverage gate AND
   * other vendor-side errors. Field names mirror what the docs +
   * operator observation surface; we treat the presence of either
   * `error` or `errors` as the "no data" signal and translate to
   * `no-coverage` when the message indicates the trial restriction.
   */
  error?: string | { message?: string; code?: string };
  errors?: ReadonlyArray<unknown>;
}

interface RegridDedupEntry {
  /**
   * Either a settled value or the in-flight Promise. We always store
   * a Promise so the dedup code path is the same for cache-hit
   * (already-settled Promise re-yielded) and cache-miss-in-flight
   * (the live Promise both adapters await). Once settled, the
   * `expiresAt` ticks the entry into a re-fetch on next call.
   */
  promise: Promise<RegridPointResponse>;
  expiresAt: number;
}

/**
 * Module-scoped dedup map. One entry per `${lat},${lng}` rounded to
 * `CACHE_COORDINATE_PRECISION` decimals. Bounded by the natural
 * cardinality of cached parcels × 15min — small in practice for the
 * single-tenant Cortex deployment.
 */
const regridDedup: Map<string, RegridDedupEntry> = new Map();

function regridDedupKey(latitude: number, longitude: number): string {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  const lat = Math.round(latitude * factor) / factor;
  const lng = Math.round(longitude * factor) / factor;
  return `${lat},${lng}`;
}

/**
 * Test-only — clear the dedup map so a fresh test case doesn't see
 * an entry from a previous test in the same vitest worker. Exported
 * (not implicit via `vi.resetModules()`) because the adapter objects
 * are singletons; module reset would also drop the adapter bindings.
 */
export function __resetRegridDedupForTests(): void {
  regridDedup.clear();
}

/**
 * Detect the trial-token "out of coverage" envelope. Returns true
 * when the response shape indicates the lookup hit an out-of-trial
 * county and the operator hasn't upgraded. Heuristic — the docs do
 * not nail the exact error code, so we check for empty features +
 * an error message that hints at the coverage gate.
 */
function isTrialOutOfCoverage(response: RegridPointResponse): boolean {
  const parcelsEmpty =
    !response.parcels?.features || response.parcels.features.length === 0;
  if (!parcelsEmpty) return false;
  // Empty parcels alone could mean a legitimate ocean / lake / unparceled
  // tract; the error-envelope hint disambiguates.
  if (typeof response.error === "string") {
    const msg = response.error.toLowerCase();
    if (
      msg.includes("trial") ||
      msg.includes("coverage") ||
      msg.includes("restricted") ||
      msg.includes("unauthorized")
    ) {
      return true;
    }
  }
  if (typeof response.error === "object" && response.error !== null) {
    const errObj = response.error as { message?: unknown; code?: unknown };
    const msg =
      typeof errObj.message === "string" ? errObj.message.toLowerCase() : "";
    if (
      msg.includes("trial") ||
      msg.includes("coverage") ||
      msg.includes("restricted") ||
      msg.includes("unauthorized")
    ) {
      return true;
    }
  }
  return false;
}

function readApiKey(): string {
  const key = process.env.REGRID_API_KEY;
  if (!key || key.length === 0) {
    throw new AdapterRunError(
      "upstream-error",
      "REGRID_API_KEY is not configured on this Cortex deployment. Cloud Run secret missing or not mounted on the runtime service account.",
    );
  }
  return key;
}

interface FetchRegridPointArgs {
  latitude: number;
  longitude: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  timeoutMs: number;
}

/**
 * Get-or-fetch the Regrid `/parcels/point` envelope for a given
 * lat/lng, deduplicating concurrent + repeat callers within the
 * {@link REGRID_INMEM_TTL_MS} window. The `parcels:` + `zoning:`
 * adapters call through this so one upstream request serves both.
 *
 * Errors throw out of the Promise; the `regridDedup` entry is dropped
 * so the next caller re-fetches rather than re-yielding a rejected
 * Promise. Successful results stay cached until expiry.
 */
async function getOrFetchRegridPoint(
  args: FetchRegridPointArgs,
): Promise<RegridPointResponse> {
  const {
    latitude,
    longitude,
    fetchImpl,
    signal,
    adapterKeyForLog,
    timeoutMs,
  } = args;
  const key = regridDedupKey(latitude, longitude);
  const now = Date.now();
  const existing = regridDedup.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }
  const apiKey = readApiKey();
  const url = new URL(REGRID_POINT_ENDPOINT);
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("return_zoning", "true");
  url.searchParams.set("return_geometry", "true");
  url.searchParams.set("limit", "1");
  url.searchParams.set("token", apiKey);
  const urlString = url.toString();
  const fetcher: typeof fetch = fetchImpl ?? fetch;

  regridLogEvent("info", "regrid request start", adapterKeyForLog, {
    url: redactToken(urlString),
    lat: latitude,
    lng: longitude,
    timeout_ms: timeoutMs,
  });
  const startedAtMs = Date.now();

  const promise = (async (): Promise<RegridPointResponse> => {
    let res: Response;
    try {
      res = await fetcher(urlString, {
        signal,
        headers: {
          "User-Agent": REGRID_USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const throwExcerpt =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      regridLogEvent("warn", "regrid request failed", adapterKeyForLog, {
        error_class: "network",
        duration_ms: durationMs,
        throw_excerpt: throwExcerpt,
      });
      throw new AdapterRunError(
        "network-error",
        `Regrid did not get a response. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
      );
    }

    if (!res.ok) {
      const durationMs = Date.now() - startedAtMs;
      let bodyExcerpt = "";
      try {
        const text = await res.text();
        bodyExcerpt = text.slice(0, 256);
      } catch {
        /* swallow */
      }
      regridLogEvent("warn", "regrid request failed", adapterKeyForLog, {
        error_class: "status",
        http_status: res.status,
        duration_ms: durationMs,
        body_excerpt: bodyExcerpt,
      });
      // 401/403 typically means the API key is rejected (revoked /
      // misconfigured). Surface as a hard `upstream-error` so the
      // operator notices in the pill; do NOT collapse to no-coverage.
      throw new AdapterRunError(
        "upstream-error",
        `Regrid responded with HTTP ${res.status}.${
          bodyExcerpt ? ` Upstream response: ${bodyExcerpt}` : ""
        } Use Force refresh to retry.`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const message = err instanceof Error ? err.message : String(err);
      regridLogEvent("warn", "regrid request failed", adapterKeyForLog, {
        error_class: "parse",
        duration_ms: durationMs,
        parse_error: message,
      });
      throw new AdapterRunError(
        "parse-error",
        `Regrid response was not JSON: ${message}`,
      );
    }

    if (!json || typeof json !== "object") {
      throw new AdapterRunError(
        "parse-error",
        "Regrid response was not a JSON object.",
      );
    }
    const response = json as RegridPointResponse;
    const durationMs = Date.now() - startedAtMs;
    const parcelCount = response.parcels?.features?.length ?? 0;
    const zoningCount = response.zoning?.features?.length ?? 0;
    const contentLength = Number(res.headers.get("content-length"));
    regridLogEvent("info", "regrid request ok", adapterKeyForLog, {
      duration_ms: durationMs,
      response_size_bytes: Number.isFinite(contentLength)
        ? contentLength
        : undefined,
      parcel_count: parcelCount,
      zoning_count: zoningCount,
    });
    return response;
  })();

  // Wire the in-flight Promise into the dedup map BEFORE awaiting so a
  // concurrent caller for the same key sees the in-flight promise
  // rather than firing a second request. On rejection, evict so the
  // next caller retries cleanly.
  regridDedup.set(key, { promise, expiresAt: now + REGRID_INMEM_TTL_MS });
  promise.catch(() => {
    const entry = regridDedup.get(key);
    if (entry && entry.promise === promise) {
      regridDedup.delete(key);
    }
  });
  return promise;
}

/** `appliesTo` predicate — Regrid is nationwide so any geocoded engagement qualifies. */
function regridApplies(ctx: AdapterContext): boolean {
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Pull a stable ISO date from `ll_last_refresh` on the first parcel's
 * fields, falling back to the current time. Regrid's
 * `ll_last_refresh` is the county-specific data acquisition date
 * (per the schema doc) — the right value for `briefing_sources.
 * snapshot_date`.
 */
function snapshotDateFromFeatures(
  features: ReadonlyArray<RegridGeoJsonFeature>,
): string {
  const fields = features[0]?.properties?.fields;
  if (fields && typeof fields === "object") {
    const raw =
      (fields as Record<string, unknown>)["ll_last_refresh"] ??
      (fields as Record<string, unknown>)["ll_updated_at"];
    if (typeof raw === "string" && raw.length > 0) {
      // Normalise to ISO8601 — Regrid emits YYYY-MM-DD; `new Date()`
      // parses that as UTC midnight which is the conservative reading.
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return nowIso();
}

/**
 * Extract a `Regrid (via <source-county>)` provider label when the
 * first parcel's fields surface a county; otherwise the plain
 * provider label. Mirrors the SCOPE A recommendation for
 * provider-attribution.
 */
function providerLabelFromFeatures(
  features: ReadonlyArray<RegridGeoJsonFeature>,
): string {
  const fields = features[0]?.properties?.fields;
  if (fields && typeof fields === "object") {
    const county = (fields as Record<string, unknown>)["county"];
    if (typeof county === "string" && county.length > 0) {
      return `${REGRID_PROVIDER_LABEL} (via ${county})`;
    }
  }
  return REGRID_PROVIDER_LABEL;
}

/**
 * `regrid:parcels` — parcel polygon + properties layer.
 *
 * Emits `briefing_sources.payload` shaped as `{ kind: "parcel",
 * parcel: <GeoJSON Feature> }`. Downstream consumers (overlays.ts
 * extended in this PR; the briefing engine's LLM prompt) read
 * `payload.parcel.geometry` directly.
 */
export const regridParcelsAdapter: Adapter = {
  adapterKey: "regrid:parcels",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "regrid-parcel",
  provider: REGRID_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: REGRID_TIMEOUT_MS,
  appliesTo: regridApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const response = await getOrFetchRegridPoint({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      timeoutMs: REGRID_TIMEOUT_MS,
    });
    // Trial-token out-of-coverage envelope: HTTP 200 + empty parcels
    // + an error string hinting at the trial gate. Surface as
    // no-coverage (deterministic gate) NOT upstream-error.
    if (isTrialOutOfCoverage(response)) {
      regridLogEvent("warn", "regrid request failed", this.adapterKey, {
        error_class: "out-of-coverage",
        reason:
          "Trial token restricted to 7 counties; this lat/lng is outside the trial coverage. Upgrade the Regrid plan to widen.",
      });
      throw new AdapterRunError(
        "no-coverage",
        "Regrid trial token does not cover this lat/lng. Upgrade the Regrid plan to enable nationwide coverage.",
      );
    }
    const features = response.parcels?.features ?? [];
    if (features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Regrid returned no parcel polygon at this lat/lng.",
      );
    }
    const feature = features[0]!;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabelFromFeatures(features),
      snapshotDate: snapshotDateFromFeatures(features),
      payload: {
        kind: "parcel",
        parcel: feature,
      },
    };
  },
};

/**
 * `regrid:zoning` — standardized + jurisdiction-specific zoning
 * fields for the parcel.
 *
 * Emits `briefing_sources.payload` shaped as `{ kind: "zoning",
 * zoning: <GeoJSON Feature> }` when Regrid returns zoning data for
 * the parcel; emits `no-coverage` when the zoning array is empty
 * (e.g. unincorporated tracts that Regrid hasn't standardized
 * zoning_type for yet) without failing the parcel adapter.
 */
export const regridZoningAdapter: Adapter = {
  adapterKey: "regrid:zoning",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "regrid-zoning",
  provider: REGRID_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: REGRID_TIMEOUT_MS,
  appliesTo: regridApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const response = await getOrFetchRegridPoint({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      timeoutMs: REGRID_TIMEOUT_MS,
    });
    if (isTrialOutOfCoverage(response)) {
      throw new AdapterRunError(
        "no-coverage",
        "Regrid trial token does not cover this lat/lng. Upgrade the Regrid plan to enable nationwide coverage.",
      );
    }
    const zoningFeatures = response.zoning?.features ?? [];
    if (zoningFeatures.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Regrid returned no zoning record at this lat/lng (the parcel may sit in an unzoned tract or in a county Regrid hasn't standardized zoning_type for yet).",
      );
    }
    const feature = zoningFeatures[0]!;
    // Reuse the parcel-side snapshotDate when available — zoning is
    // refreshed alongside parcels in Regrid's pipeline, so the
    // parcel's `ll_last_refresh` is the right cite for zoning too.
    const parcelFeatures = response.parcels?.features ?? [];
    const snapshotDate =
      parcelFeatures.length > 0
        ? snapshotDateFromFeatures(parcelFeatures)
        : snapshotDateFromFeatures(zoningFeatures);
    const provider =
      parcelFeatures.length > 0
        ? providerLabelFromFeatures(parcelFeatures)
        : REGRID_PROVIDER_LABEL;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider,
      snapshotDate,
      payload: {
        kind: "zoning",
        zoning: feature,
      },
    };
  },
};
