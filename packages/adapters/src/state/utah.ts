/**
 * Utah statewide adapters — UGRC (Utah Geospatial Resource Center).
 *
 * UGRC publishes most of its statewide layers as ArcGIS REST services
 * under `https://services.arcgis.com/<org>/...` (no API key required
 * for the public endpoints we hit). We expose three:
 *
 *   - `ugrc:dem`            — statewide generalized 200ft elevation
 *                             contour polygons (point-in-polygon sample).
 *   - `ugrc:parcels`        — the statewide unified parcel layer.
 *   - `ugrc:address-points` — the statewide address point layer.
 *
 * All three gate on `jurisdiction.stateKey === "utah"` so a Texas parcel
 * skips them with a `no-coverage` outcome rather than burning a network
 * call to find out the polygon doesn't intersect.
 */

import { arcgisPointQuery } from "../arcgis";
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

/**
 * UGRC layer endpoints. These are the canonical publicly-documented
 * Feature Services per the UGRC catalog. Adapters import the URL from
 * here so a future endpoint move is a one-line change.
 */
const UGRC_ENDPOINTS = {
  // `ugrc:dem` resolves to UGRC's statewide generalized 200ft
  // elevation-contour polygon layer. The prior URL pointed at a
  // `Utah_Elevation_Contours` FeatureServer that does not exist on the
  // UGRC ArcGIS org — every run 400'd with ArcGIS "Invalid URL"
  // (QA-03 / WSA.4, 2026-05-20). `ContoursGeneralized200Ft` is the
  // published statewide product; its layer 0 is polygon bands, so a
  // parcel point reliably intersects exactly one elevation band.
  dem: "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/ContoursGeneralized200Ft/FeatureServer/0",
  parcels:
    "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer/0",
  addressPoints:
    "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahAddressPoints/FeatureServer/0",
} as const;

/**
 * Freshness windows for the UGRC (Utah) adapters, in whole months.
 * Surfaced via {@link evaluateStateSnapshotFreshness} so the Site
 * Context tab can render the same "snapshot is N months old" amber
 * badge on stale state-tier rows that Task #222 added on the federal
 * tier.
 *
 *   - `dem` (24mo): the statewide generalized contour layer is
 *     rebuilt only when UGRC reprocesses its base DEM; elevation at a
 *     point is stable, so the snapshot is only stale once the contour
 *     product itself has been republished. 24 months matches that
 *     cadence. Mirrors the USGS NED window for the same reason.
 *   - `parcels` (12mo): the statewide Unified Parcel layer aggregates
 *     county pushes on a roughly quarterly cadence; 12 months keeps
 *     the badge tight enough that a year-old read prompts a re-run
 *     without firing on the routine quarterly republish.
 *   - `addressPoints` (12mo): same cadence as parcels (UGRC pulls
 *     address points from the same county feeds). A stale read here
 *     is lower-stakes for a building review, but auditors expect the
 *     same window across the UGRC bundle.
 */
export const UGRC_DEM_FRESHNESS_THRESHOLD_MONTHS = 24;
export const UGRC_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 12;
export const UGRC_ADDRESS_POINTS_FRESHNESS_THRESHOLD_MONTHS = 12;

function utahApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey === "utah";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const utahDemAdapter: Adapter = {
  adapterKey: "ugrc:dem",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "ugrc-dem",
  provider: "Utah Geospatial Resource Center (UGRC)",
  jurisdictionGate: { state: "utah" },
  // P1-3 — UGRC's ArcGIS Online statewide feeds answer slower than the
  // 15s runner default; widen this adapter's budget so a slow-but-
  // healthy query (and its retry ladder) is not cut off as a `timeout`.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
  appliesTo: utahApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: UGRC_ENDPOINTS.dem,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      // P1-1 — return the elevation-band polygon geometry so the Site
      // Context map can draw the band the parcel sits in. Layer 0 is
      // polygon bands, so this is a single ring, not a heavy payload.
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    // The DEM layer can return zero contours for a point that falls in
    // the gaps between contour intervals — that's *not* a "no coverage"
    // verdict (the parcel is still in Utah), so we still emit a
    // briefing-source row carrying the empty result. The briefing engine
    // can decide whether to call out the gap.
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "elevation-contours",
        featureCount: result.features.length,
        features: result.features,
      },
    };
  },
};

export const utahParcelsAdapter: Adapter = {
  adapterKey: "ugrc:parcels",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "ugrc-parcels",
  provider: "Utah Geospatial Resource Center (UGRC)",
  jurisdictionGate: { state: "utah" },
  // P1-3 — UGRC's ArcGIS Online statewide feeds answer slower than the
  // 15s runner default; widen this adapter's budget so a slow-but-
  // healthy query (and its retry ladder) is not cut off as a `timeout`.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
  appliesTo: utahApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: UGRC_ENDPOINTS.parcels,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      // A point in Utah that returns zero parcels almost always means
      // the lat/lng landed in a public-land polygon (BLM / National
      // Forest) where the statewide parcel layer has no coverage. We
      // still emit a row but tag the payload so the briefing engine can
      // surface "this lot is on public land" rather than a blank.
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: { kind: "parcel", parcel: null, note: "no-parcel-at-point" },
        note: "Lat/lng did not intersect any parcel polygon (likely public land).",
      };
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

export const utahAddressPointsAdapter: Adapter = {
  adapterKey: "ugrc:address-points",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "ugrc-address-points",
  provider: "Utah Geospatial Resource Center (UGRC)",
  jurisdictionGate: { state: "utah" },
  // P1-3 — UGRC's ArcGIS Online statewide feeds answer slower than the
  // 15s runner default; widen this adapter's budget so a slow-but-
  // healthy query (and its retry ladder) is not cut off as a `timeout`.
  timeoutMs: SLOW_UPSTREAM_TIMEOUT_MS,
  appliesTo: utahApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: UGRC_ENDPOINTS.addressPoints,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      // Address points rarely intersect a single lat/lng directly. We
      // surface this as a deterministic-but-recorded gap rather than
      // an outright failure — DA-PI-3's briefing engine can decide
      // whether to broaden to the nearest neighbor.
      throw new AdapterRunError(
        "no-coverage",
        "No UGRC address point at this lat/lng.",
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
        kind: "address-point",
        feature: result.features[0],
      },
    };
  },
};
