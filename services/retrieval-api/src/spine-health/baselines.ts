/**
 * Bastrop spine-health pack constants + seed baselines from the
 * 2026-07-27 COMPLETE-BASTROP hardening audit / composition inventory.
 */

export const BASTROP_PACK = "bastrop" as const;

/** Gold parcel for point / setback / atom-chain probes (audit A). */
export const GOLD_PARCEL_NODE_ID = "48021:33512";
/** Current-law BDC Euclidean district (Ord. 2026-06). Was P-5 under repealed B3. */
export const GOLD_DISTRICT = "SF-1";
export const GOLD_LAT = 30.1119;
export const GOLD_LNG = -97.31912;

export const COUNTY_FIPS_BASTROP = "48021";

/** City of Bastrop AGOL Place Type zoning (real origin). */
export const AGOL_ZONING_PLACE_TYPE_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0";

export const BASTROP_PARCELS_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0";

export const BASTROP_FLOODPLAIN_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Emergency_Management/FEMA_Flood_Hazard_Areas/MapServer/0";

export const BASTROP_COUNTY_ROADWAY_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Transportation_BP/Bastrop_County_Roadway/MapServer/0";

export const BASTROP_STREETS_SURVEYED_2016_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/RoadAndBridgeMap/StreetsSurveyed2016/FeatureServer/0";

export const OVERPASS_INTERPRETER = "https://overpass-api.de/api/interpreter";

/**
 * Seed baselines (audit 2026-07-27 live probes / ledger).
 * Zero-with-baseline>0 must alert — these numbers make that path real.
 */
export const SEED_BASELINES = {
  "bastrop-tx:parcels": 1,
  "bastrop-tx:floodplain": 1,
  "zoning-agol:bastrop-city-tx": 574,
  "bastrop-tx:zoning": 0,
  "osm-overpass": 1000,
  "county-roadway": 1000,
  "streets-surveyed-2016": 1000,
  "txgio_parcel:48021": 74729,
  "txgio_parcel:48021:zoning_district": 6213,
  "place_layer_snapshots:tier1:48021": 62257,
  "place_layer_snapshots:zoning_present:48021": 5769,
  /** S-14 bake lag: txgio zd − tier1 zoning_present (6213 − 5769). */
  "place_layer_snapshots:s14_delta:48021": 444,
  "boundary-primitive": 26454,
  "depth-warm": 3642,
  "rule-setback": 1,
  "reasoning-chain": 3,
} as const;

export type SeedBaselineProbeId = keyof typeof SEED_BASELINES;

export function seedBaseline(probeId: string): number | null {
  if (Object.prototype.hasOwnProperty.call(SEED_BASELINES, probeId)) {
    return SEED_BASELINES[probeId as SeedBaselineProbeId];
  }
  return null;
}
