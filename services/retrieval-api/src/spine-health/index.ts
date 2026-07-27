/**
 * Spine health board — COMPLETE-BASTROP B1 (S-03).
 */

export type {
  DeriveStatusInput,
  ProbeKind,
  ProbeResult,
  ProbeStatus,
  SpineHealthSummary,
} from "./types.js";

export { deriveProbeStatus, DEFAULT_DEGRADE_FRACTION } from "./derive-status.js";

export {
  AGOL_ZONING_PLACE_TYPE_URL,
  BASTROP_COUNTY_ROADWAY_URL,
  BASTROP_FLOODPLAIN_URL,
  BASTROP_PACK,
  BASTROP_PARCELS_URL,
  BASTROP_STREETS_SURVEYED_2016_URL,
  COUNTY_FIPS_BASTROP,
  GOLD_DISTRICT,
  GOLD_LAT,
  GOLD_LNG,
  GOLD_PARCEL_NODE_ID,
  OVERPASS_INTERPRETER,
  SEED_BASELINES,
  seedBaseline,
} from "./baselines.js";

export {
  ensureSpineHealthSchema,
  insertProbeResults,
  loadLastSuccessBaselines,
  loadLatestProbeSummary,
} from "./persist.js";

export {
  probeBastropFloodplain,
  probeBastropParcels,
  probeBastropZoningDeadExpected,
  probeBoundaryPrimitive,
  probeCountyRoadway,
  probeDepthWarm,
  probeOsmOverpass,
  probeReasoningChain,
  probeRuleSetback,
  probeStreetsSurveyed2016,
  probeTier1Snapshots48021,
  probeTxgioParcel48021,
  probeZoningAgol,
  runAllBastropProbes,
} from "./probes.js";

export {
  readSpineHealthSummary,
  runBastropSpineHealthPack,
} from "./run-pack.js";
