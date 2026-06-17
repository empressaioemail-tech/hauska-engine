/**
 * Idaho statewide adapters — INSIDE Idaho.
 *
 * INSIDE Idaho hosts statewide layers as ArcGIS REST services under
 * `https://gis.idaho.gov/...`. Coverage is uneven (per the DA-PI-4
 * brief): the DEM is statewide but the parcels layer is a roll-up from
 * counties that opted in, so a parcel in a non-participating county
 * gets a `no-coverage` outcome rather than an empty success.
 *
 * Two adapters this sprint:
 *   - `inside-idaho:dem`     — statewide elevation contours.
 *   - `inside-idaho:parcels` — statewide parcels roll-up.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const INSIDE_IDAHO_ENDPOINTS = {
  dem: "https://gis.idaho.gov/server/rest/services/Elevation/Idaho_Elevation_Contours/MapServer/0",
  parcels:
    "https://gis.idaho.gov/server/rest/services/Cadastral/Idaho_Statewide_Parcels/MapServer/0",
} as const;

/**
 * Freshness windows for the INSIDE Idaho adapters, in whole months.
 * Surfaced via {@link evaluateStateSnapshotFreshness} so the Site
 * Context tab renders the same amber stale badge on state-tier rows
 * that Task #222 added on the federal tier.
 *
 *   - `dem` (24mo): the Idaho statewide elevation contour layer is
 *     republished as new lidar collections complete; terrain at a
 *     point is geologically stable, so the snapshot is stale only
 *     when the underlying raster product has been replaced. 24 months
 *     mirrors the USGS NED window for the same reason.
 *   - `parcels` (12mo): the statewide parcels layer is a county
 *     roll-up with uneven update cadence (per the DA-PI-4 brief: some
 *     counties refresh quarterly, others annually). 12 months keeps
 *     the badge useful — a year-old read should prompt a re-run —
 *     while staying loose enough that a slow-cadence county doesn't
 *     trip the tag every other read.
 */
export const INSIDE_IDAHO_DEM_FRESHNESS_THRESHOLD_MONTHS = 24;
export const INSIDE_IDAHO_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 12;

function idahoApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey === "idaho";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const idahoDemAdapter: Adapter = {
  adapterKey: "inside-idaho:dem",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "inside-idaho-dem",
  provider: "INSIDE Idaho",
  jurisdictionGate: { state: "idaho" },
  appliesTo: idahoApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: INSIDE_IDAHO_ENDPOINTS.dem,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: false,
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
        kind: "elevation-contours",
        featureCount: result.features.length,
        features: result.features,
      },
    };
  },
};

export const idahoParcelsAdapter: Adapter = {
  adapterKey: "inside-idaho:parcels",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "inside-idaho-parcels",
  provider: "INSIDE Idaho (county roll-up)",
  jurisdictionGate: { state: "idaho" },
  appliesTo: idahoApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: INSIDE_IDAHO_ENDPOINTS.parcels,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      // Per the brief: "INSIDE Idaho coverage is uneven — flag gaps."
      // A miss here may mean the county hasn't pushed parcels into the
      // statewide roll-up. We surface as a deterministic no-coverage
      // outcome so the runner can attribute the gap to this layer
      // (rather than e.g. a network blip).
      throw new AdapterRunError(
        "no-coverage",
        "No parcel polygon in the INSIDE Idaho statewide roll-up at this lat/lng (county may not participate).",
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
