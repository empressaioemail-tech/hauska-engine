/**
 * Lemhi County, ID (Salmon) local adapters.
 *
 * Lemhi County's GIS is hosted by an arc-gis-online org (the county
 * does not run its own ArcGIS server in 2026); endpoints are documented
 * via the county's open data portal. Three layers ship in this sprint:
 *
 *   - `lemhi-county-id:parcels`
 *   - `lemhi-county-id:zoning`
 *   - `lemhi-county-id:roads`
 *
 * Same OSM-fallback convention for roads as Grand County.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const LEMHI_ENDPOINTS = {
  parcels:
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Lemhi_County_Parcels/FeatureServer/0",
  zoning:
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Lemhi_County_Zoning/FeatureServer/0",
  roads:
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Lemhi_County_Roads/FeatureServer/0",
} as const;

const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Freshness windows for the Lemhi County, ID (Salmon) adapters, in
 * whole months. Surfaced via {@link evaluateLocalSnapshotFreshness}
 * so the Site Context tab renders the same amber stale badge on
 * local-tier rows that Task #222 added on the federal tier.
 *
 * Same rationale as the Grand County windows: ordinance-driven local
 * data is the highest-impact tier for staleness, so the windows are
 * tight (6 months) for parcels + zoning. Roads stay at the looser
 * 12-month window because a stale roads read is a much smaller
 * audit risk and the OSM fallback covers gaps.
 *
 *   - `parcels` (6mo): assessor updates parcels as recordings clear.
 *   - `zoning` (6mo): board of commissioners can amend a district at
 *     any meeting; 6 months keeps the badge responsive.
 *   - `roads` (12mo): county road inventory changes slowly.
 */
export const LEMHI_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 6;
export const LEMHI_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS = 6;
export const LEMHI_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS = 12;

function lemhiApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.localKey === "lemhi-county-id";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const lemhiCountyParcelsAdapter: Adapter = {
  adapterKey: "lemhi-county-id:parcels",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "lemhi-county-id-parcels",
  provider: "Lemhi County, ID GIS",
  jurisdictionGate: { local: "lemhi-county-id" },
  appliesTo: lemhiApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: LEMHI_ENDPOINTS.parcels,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Lemhi County parcel polygon at this lat/lng.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: { kind: "parcel", parcel: result.features[0] },
    };
  },
};

export const lemhiCountyZoningAdapter: Adapter = {
  adapterKey: "lemhi-county-id:zoning",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "lemhi-county-id-zoning",
  provider: "Lemhi County, ID GIS",
  jurisdictionGate: { local: "lemhi-county-id" },
  appliesTo: lemhiApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: LEMHI_ENDPOINTS.zoning,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Lat/lng did not intersect a Lemhi County zoning polygon.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: { kind: "zoning", zoning: result.features[0] },
    };
  },
};

export const lemhiCountyRoadsAdapter: Adapter = {
  adapterKey: "lemhi-county-id:roads",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "lemhi-county-id-roads",
  provider: "Lemhi County, ID GIS / OpenStreetMap (fallback)",
  jurisdictionGate: { local: "lemhi-county-id" },
  appliesTo: lemhiApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    try {
      const result = await arcgisPointQuery({
        serviceUrl: LEMHI_ENDPOINTS.roads,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        outFields: "*",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
      });
      if (result.features.length > 0) {
        return {
          adapterKey: this.adapterKey,
          tier: this.tier,
          layerKind: this.layerKind,
          sourceKind: this.sourceKind,
          provider: "Lemhi County, ID GIS",
          snapshotDate: nowIso(),
          payload: {
            kind: "roads",
            source: "county-gis",
            features: result.features,
          },
        };
      }
    } catch (err) {
      if (!(err instanceof AdapterRunError)) throw err;
    }
    return await runOsmRoadsFallback(ctx, this);
  },
};

async function runOsmRoadsFallback(
  ctx: AdapterContext,
  adapter: Adapter,
): Promise<AdapterResult> {
  const fetchFn = ctx.fetchImpl ?? fetch;
  const radius = 100;
  const query = `[out:json][timeout:10];way(around:${radius},${ctx.parcel.latitude},${ctx.parcel.longitude})[highway];out body geom 50;`;
  let res: Response;
  try {
    res = await fetchFn(OSM_OVERPASS_URL, {
      method: "POST",
      body: query,
      headers: { "Content-Type": "text/plain" },
      signal: ctx.signal,
    });
  } catch (err) {
    throw new AdapterRunError(
      "network-error",
      `OSM Overpass request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `OSM Overpass returned HTTP ${res.status}`,
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
