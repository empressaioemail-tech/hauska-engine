/**
 * Grand County, UT (Moab) local adapters.
 *
 * Grand County publishes parcels, zoning, and roads through its own
 * ArcGIS server at `https://gis.grandcountyutah.net/server/rest/services/Public/...`
 * (re-rooted from the legacy `/arcgis/...` tree). All calls go
 * through {@link fetchWithRetry} so a single county-GIS hiccup
 * (HTTP 408/429/5xx or a fetch reset) is retried before we surface
 * the row as failed.
 *
 * Roads adapter falls back to OpenStreetMap's Overpass API when the
 * primary endpoint returns nothing or fails — per locked decision #2
 * ("fall back to OSM if county GIS isn't usable").
 *
 * Three adapters:
 *   - `grand-county-ut:parcels`
 *   - `grand-county-ut:zoning`
 *   - `grand-county-ut:roads` (with OSM fallback)
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { fetchWithRetry } from "../retry";
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";

/**
 * Grand County GIS — service URLs as published in the county's REST
 * directory at https://gis.grandcountyutah.net/server/rest/services .
 * Each entry points at the layer index that backs the spatial query
 * (the `/0` layer of the corresponding feature service).
 */
const GRAND_COUNTY_ENDPOINTS = {
  parcels:
    "https://gis.grandcountyutah.net/server/rest/services/Public/Parcels/MapServer/0",
  zoning:
    "https://gis.grandcountyutah.net/server/rest/services/Public/Zoning/MapServer/0",
  roads:
    "https://gis.grandcountyutah.net/server/rest/services/Public/Roads/MapServer/0",
} as const;

const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OSM_OVERPASS_LABEL = "OSM Overpass";

/**
 * Identifying User-Agent for upstream calls.
 *
 * OSM Overpass (and several of the other public broker endpoints we
 * hit) front their servers with Apache, which returns `HTTP 406 Not
 * Acceptable` for requests with a missing or unrecognized
 * `User-Agent`. Node 20+'s built-in `fetch` does not always set one,
 * so the runner-level call started 406-ing in production after the
 * Task #490 redeploy. Per OSM Overpass etiquette, identify the app
 * (and a contact path) so operators can rate-limit politely instead
 * of blocking the whole request.
 */
const ADAPTER_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

/**
 * Per-adapter timeout override (ms) for the Grand County roads
 * adapter. Sized to cover two full Overpass attempts at the
 * server-side `[timeout:25]` plus backoff between them:
 *   25s (attempt 1, e.g. HTTP 408 at the upstream timeout)
 *   + ~2s backoff
 *   + 25s (attempt 2)
 *   ≈ 52s worst case, with headroom.
 * Pairs with `OVERPASS_MAX_ATTEMPTS = 2` below — together the two
 * constants keep the runner budget and retry policy mathematically
 * consistent so a slow first failure can still complete the retry.
 */
const GRAND_COUNTY_ROADS_TIMEOUT_MS = 60_000;

/** Overpass server-side `[timeout:N]` directive in seconds. */
const OVERPASS_QL_TIMEOUT_SEC = 25;

/**
 * Max Overpass attempts (initial + retries). Capped at 2 so the
 * worst-case wall time fits inside {@link GRAND_COUNTY_ROADS_TIMEOUT_MS}
 * — 3 attempts of 25s each would blow the runner budget.
 */
const OVERPASS_MAX_ATTEMPTS = 2;

/**
 * Freshness windows for the Grand County, UT (Moab) adapters, in
 * whole months. Surfaced via {@link evaluateLocalSnapshotFreshness}
 * so the Site Context tab renders the same amber stale badge on
 * local-tier rows that Task #222 added on the federal tier.
 *
 * Local-tier windows are intentionally tighter than federal/state
 * because (per the Task #254 brief) ordinance-driven local zoning
 * data can flip a setback overnight on a single council vote — a
 * stale read here has the highest reviewer-impact of any tier.
 *
 *   - `parcels` (6mo): the county updates parcels on roughly a
 *     monthly cadence as recordings clear; 6 months keeps the badge
 *     responsive without firing on a routine quarterly read.
 *   - `zoning` (6mo): the council can adopt an ordinance amending a
 *     district at any meeting. 6 months matches typical "annual
 *     review of the code" frequency a reviewer would expect — a
 *     half-year-old read is the boundary at which "you should
 *     re-pull this" is the right reviewer instinct.
 *   - `roads` (12mo): roads change much more slowly than zoning, and
 *     the OSM Overpass fallback gives us a mostly-current secondary
 *     when the county GIS lags. 12 months matches the cadence at
 *     which county road inventories typically refresh.
 */
export const GRAND_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 6;
export const GRAND_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS = 6;
export const GRAND_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS = 12;

/**
 * DEPRECATED AS BASELINE per Cortex prop-intel SCOPE B
 * (2026-05-23). These Grand County, UT adapters used to be the
 * sole parcel + zoning source for Moab-area engagements. After
 * SCOPE B, Regrid (`regrid:parcels` + `regrid:zoning`) is the
 * national baseline and fires for EVERY geocoded engagement.
 *
 * The per-county adapters in this file are now opportunistic
 * ENRICHMENT layers that fire ONLY when the engagement's
 * jurisdiction carries `partnerCity: true`. Grand County, UT is
 * NOT currently a Hauska substrate partner city (Bastrop, TX is
 * the canonical partner; see `doc_repo/_decisions/2026-05-23_
 * partnership_first_scoping.md`), so on a default engagement
 * these adapters return `no-coverage` and Regrid is the sole
 * authoritative source.
 *
 * The adapters are kept in tree (not deleted) because:
 *   1. If Grand County onboards as a partner city, flipping
 *      `partnerCity = true` in the engagement jurisdiction
 *      record re-activates them as enrichment with no other code
 *      change.
 *   2. The Grand County GIS firewall recon work (QA-22 SCOPE C)
 *      may yet enable direct egress through a Cloud Run VPC +
 *      NAT, at which point these are the live integration.
 *   3. The OSM-fallback roads adapter is genuinely useful even
 *      without partner status — but the `partnerCity` gate
 *      applies to all three uniformly here for simplicity;
 *      revisit if a real customer-zero case needs roads-only
 *      without parcel/zoning.
 *
 * Re-enabling as baseline: drop the `partnerCity` clause in
 * {@link grandCountyApplies} and document the rationale.
 */
function grandCountyApplies(ctx: AdapterContext): boolean {
  return (
    ctx.jurisdiction.localKey === "grand-county-ut" &&
    ctx.jurisdiction.partnerCity === true
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export const grandCountyParcelsAdapter: Adapter = {
  adapterKey: "grand-county-ut:parcels",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-parcels",
  provider: "Grand County, UT GIS",
  jurisdictionGate: { local: "grand-county-ut" },
  // QA-22 — the Grand County county ArcGIS server routinely answers
  // slower than the 15s runner default; widen this adapter's budget so
  // a slow-but-healthy parcels query is not cut off as a `timeout`.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: GRAND_COUNTY_ENDPOINTS.parcels,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "Grand County, UT GIS parcels",
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Grand County parcel polygon at this lat/lng.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "parcel",
        parcel: result.features[0],
      },
    };
  },
};

export const grandCountyZoningAdapter: Adapter = {
  adapterKey: "grand-county-ut:zoning",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-zoning",
  provider: "Grand County, UT GIS",
  jurisdictionGate: { local: "grand-county-ut" },
  // QA-22 — the Grand County county ArcGIS server routinely answers
  // slower than the 15s runner default; widen this adapter's budget so
  // a slow-but-healthy zoning query is not cut off as a `timeout`.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: GRAND_COUNTY_ENDPOINTS.zoning,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "Grand County, UT GIS zoning",
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Lat/lng did not intersect a Grand County zoning polygon.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "zoning",
        zoning: result.features[0],
      },
    };
  },
};

export const grandCountyRoadsAdapter: Adapter = {
  adapterKey: "grand-county-ut:roads",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-roads",
  provider: "Grand County, UT GIS / OpenStreetMap (fallback)",
  jurisdictionGate: { local: "grand-county-ut" },
  // Widen the runner's per-adapter timeout for this adapter only —
  // Overpass needs more than the 15s default to reply (see
  // GRAND_COUNTY_ROADS_TIMEOUT_MS docstring).
  timeoutMs: GRAND_COUNTY_ROADS_TIMEOUT_MS,
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    // Try the county GIS first.
    try {
      const result = await arcgisPointQuery({
        serviceUrl: GRAND_COUNTY_ENDPOINTS.roads,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        outFields: "*",
        // P1-1 — return the road polyline geometry so the Site Context
        // map can draw the road centerlines as polylines.
        returnGeometry: true,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: "Grand County, UT GIS roads",
      });
      if (result.features.length > 0) {
        return {
          adapterKey: this.adapterKey,
          tier: this.tier,
          layerKind: this.layerKind,
          sourceKind: this.sourceKind,
          provider: "Grand County, UT GIS",
          snapshotDate: nowIso(),
          payload: { kind: "roads", source: "county-gis", features: result.features },
        };
      }
      // County returned ok but zero features — fall through to OSM.
    } catch (err) {
      // County GIS unavailable — record reason and fall through to OSM.
      // Anything not an AdapterRunError indicates a programming error
      // we shouldn't swallow.
      if (!(err instanceof AdapterRunError)) throw err;
    }
    return await runOsmRoadsFallback(ctx, this);
  },
};

/**
 * Overpass roads fallback. Exported only for unit tests so the retry
 * + timeout behaviour can be exercised directly without going through
 * the county-GIS-fails-first ladder. Production callers use the
 * adapter's `run()` instead.
 */
export async function runOsmRoadsFallback(
  ctx: AdapterContext,
  adapter: Adapter,
): Promise<AdapterResult> {
  // The runner enforces this adapter's per-call budget via
  // `Adapter.timeoutMs` (`GRAND_COUNTY_ROADS_TIMEOUT_MS`), sized to
  // cover Overpass's own `[timeout:25]` directive plus one retry.
  // Forward the runner's signal verbatim so a caller-driven cancel
  // still wins and we don't double-cap with a tighter local deadline.
  const radius = 100;
  const query = `[out:json][timeout:${OVERPASS_QL_TIMEOUT_SEC}];way(around:${radius},${ctx.parcel.latitude},${ctx.parcel.longitude})[highway];out body geom 50;`;
  const { response: res, attempts } = await fetchWithRetry(
    OSM_OVERPASS_URL,
    {
      method: "POST",
      body: query,
      // Apache (Overpass's front door) returns HTTP 406 for requests
      // without a recognized `User-Agent` and without a permissive
      // `Accept`. Spelling both out fixes the production 406 and is
      // standard Overpass etiquette (UA identifies the app + contact).
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": ADAPTER_USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
      signal: ctx.signal,
    },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: OSM_OVERPASS_LABEL,
      maxAttempts: OVERPASS_MAX_ATTEMPTS,
    },
  );
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `OSM Overpass returned HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `OSM Overpass response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const elements = (json as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) {
    throw new AdapterRunError(
      "parse-error",
      "OSM Overpass response missing `elements` array",
    );
  }
  return {
    adapterKey: adapter.adapterKey,
    tier: adapter.tier,
    layerKind: adapter.layerKind,
    sourceKind: adapter.sourceKind,
    provider: "OpenStreetMap (Overpass fallback)",
    snapshotDate: nowIso(),
    payload: { kind: "roads", source: "osm", radiusMeters: radius, elements },
    note: "County GIS roads layer unavailable; fell back to OpenStreetMap Overpass.",
  };
}
