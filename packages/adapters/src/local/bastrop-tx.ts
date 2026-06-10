/**
 * Bastrop, TX local adapters — re-keyed from SmartCity OS for the DA
 * tenant context per locked decision #2 ("re-key the SmartCity OS
 * Bastrop adapters for the DA tenant context — do not import from the
 * SmartCity OS package; copy/adapt so DA owns the source").
 *
 * Bastrop County GIS publishes parcels and zoning through the county's
 * ArcGIS server. Flood data comes from the Bastrop County floodplain
 * map service (separate FeatureServer). Three adapters this sprint:
 *
 *   - `bastrop-tx:parcels`
 *   - `bastrop-tx:zoning`
 *   - `bastrop-tx:floodplain`
 *
 * Roads intentionally NOT included here. Decision (DA-PI-4 / V1-5,
 * 2026-05-02): stay with the OSM-direct path. Bastrop's road network in
 * the SmartCity OS pilot was sourced via OSM directly (the city's GIS
 * roads layer was not in active use); the Edwards Aquifer Contributing
 * zone (state tier) plus floodplain (this layer) cover the regulatory
 * inputs the briefing engine needs first. Adding a Bastrop roads
 * adapter is net-new maintenance burden for a jurisdiction whose road
 * data is already adequately served by OSM — revisit only if OSM proves
 * insufficient under real architect use.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const BASTROP_ENDPOINTS = {
  parcels:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Cadastral/Parcels/MapServer/0",
  zoning:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/LandUse/Zoning/MapServer/0",
  floodplain:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Hazards/Floodplain/MapServer/0",
} as const;

/**
 * Freshness windows for the Bastrop County, TX adapters, in whole
 * months. Surfaced via {@link evaluateLocalSnapshotFreshness} so the
 * Site Context tab renders the same amber stale badge on local-tier
 * rows that Task #222 added on the federal tier.
 *
 * Same rationale as the other counties: parcels and zoning stay on a
 * tight 6-month window because a council-driven amendment can change
 * the answer overnight. Floodplain is a county republish of FEMA
 * NFHL inputs and follows the FEMA cadence more closely, so it
 * matches the FEMA NFHL window (12 months).
 *
 *   - `parcels` (6mo): appraisal-district updates as recordings clear.
 *   - `zoning` (6mo): commissioners court can amend a district at any
 *     meeting; 6 months keeps the badge responsive.
 *   - `floodplain` (12mo): county republish derives from FEMA NFHL,
 *     which follows a multi-year LOMR cycle. 12 months mirrors the
 *     federal FEMA NFHL window.
 */
export const BASTROP_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 6;
export const BASTROP_ZONING_FRESHNESS_THRESHOLD_MONTHS = 6;
export const BASTROP_FLOODPLAIN_FRESHNESS_THRESHOLD_MONTHS = 12;

function bastropApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.localKey === "bastrop-tx";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const bastropParcelsAdapter: Adapter = {
  adapterKey: "bastrop-tx:parcels",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-parcels",
  provider: "Bastrop County, TX GIS",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.parcels,
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
        "No Bastrop County parcel polygon at this lat/lng.",
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

export const bastropZoningAdapter: Adapter = {
  adapterKey: "bastrop-tx:zoning",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-zoning",
  provider: "Bastrop County, TX GIS",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.zoning,
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
        "Lat/lng did not intersect a Bastrop County zoning polygon.",
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

export const bastropFloodAdapter: Adapter = {
  adapterKey: "bastrop-tx:floodplain",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-floodplain",
  provider: "Bastrop County, TX GIS (FEMA-derived floodplain)",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.floodplain,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "floodplain",
        // Empty features list = parcel is outside the mapped floodplain;
        // we still emit a row so the briefing engine can attribute "no
        // floodplain risk" to a cited source.
        inMappedFloodplain: result.features.length > 0,
        features: result.features,
      },
    };
  },
};
