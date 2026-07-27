/**
 * Bastrop, TX local adapters (COMPLETE-BASTROP C2 / S-06 / H3).
 *
 * CODE LINEAGE ONLY: this module was historically copied from a
 * SmartCity OS pilot package so DA owned the source. SmartCity is NOT
 * a live data provider for these adapters and must not be read as one.
 *
 * Live county GIS on `maps.co.bastrop.tx.us` today:
 *   - `bastrop-tx:parcels`     — Cadastral_BP parcels (live)
 *   - `bastrop-tx:floodplain`  — FEMA flood hazard areas (live)
 *   - `bastrop-tx:zoning`      — DEAD-EXPECTED. County LandUse/Zoning
 *     retired with gis.bastropcountytx.gov; no county zoning replacement.
 *     Live city Place Type districts come from AGOL
 *     `zoning-agol:bastrop-city-tx` /
 *     Zoning_Place_Type/FeatureServer/0 (PlaceTypeClass), stamped via
 *     txgio + Tier-1 bake — NOT this adapter.
 *
 * Roads stay OSM-direct (DA-PI-4 / V1-5, 2026-05-02).
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

/**
 * Host migration (2026-07-13): the county decommissioned
 * `gis.bastropcountytx.gov` (DNS ENOTFOUND) and republished its GIS
 * on `maps.co.bastrop.tx.us`. Replacement services live-verified via
 * the new server's REST catalog:
 *
 *   - parcels    → Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0
 *                  (BCAD parcels; prop_id, file_as_name, situs_*,
 *                  land_val/imprv_val/market; native SR 2277)
 *   - floodplain → Emergency_Management/FEMA_Flood_Hazard_Areas/MapServer/0
 *                  (FEMA DFIRM-derived flood hazard areas; fld_zone,
 *                  zone_subty, sfha_tf)
 *   - zoning     → NO replacement exists on the new host. The old
 *                  LandUse/Zoning service was retired with the host and
 *                  the new catalog publishes no county zoning layer
 *                  (nearest analog, Planning/PlannedDevelopment, is PD
 *                  districts — a different dataset). See
 *                  {@link bastropZoningAdapter}.
 */
const BASTROP_ENDPOINTS = {
  parcels:
    "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0",
  floodplain:
    "https://maps.co.bastrop.tx.us/server/rest/services/Emergency_Management/FEMA_Flood_Hazard_Areas/MapServer/0",
} as const;

/**
 * Freshness windows for the Bastrop County, TX adapters, in whole
 * months. Surfaced via {@link evaluateLocalSnapshotFreshness} so the
 * Site Context tab renders the same amber stale badge on local-tier
 * rows that Task #222 added on the federal tier.
 *
 * Freshness windows (parcels live; zoning threshold retained only for
 * registry symmetry — the zoning adapter is dead-expected and never
 * returns a snapshotDate from a live feed):
 *
 *   - `parcels` (6mo): appraisal-district updates as recordings clear.
 *   - `zoning` (6mo): unused while dead-expected; city Place Type
 *     freshness is owned by the AGOL stamp path, not this adapter.
 *   - `floodplain` (12mo): county republish derives from FEMA NFHL.
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
  // Honest label: this adapter is NOT a live county zoning GIS feed.
  provider:
    "dead-expected (county LandUse/Zoning retired; use zoning-agol:bastrop-city-tx)",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(): Promise<AdapterResult> {
    // DEAD-EXPECTED (COMPLETE-BASTROP C2 / S-06): county LandUse/Zoning
    // retired with gis.bastropcountytx.gov; maps.co.bastrop.tx.us has no
    // county zoning replacement (enumerated 2026-07-13). Live city Place
    // Type districts are sourced from AGOL zoning-agol:bastrop-city-tx
    // (Zoning_Place_Type / PlaceTypeClass), not this adapter.
    throw new AdapterRunError(
      "dead-expected",
      "bastrop-tx:zoning is dead-expected — county LandUse/Zoning retired; replacement is zoning-agol:bastrop-city-tx (AGOL Zoning_Place_Type / PlaceTypeClass).",
    );
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
