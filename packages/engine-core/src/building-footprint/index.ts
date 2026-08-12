export {
  FOOTPRINT_WRITER_ADAPTER,
  GLOBAL_ML_REPO_URL,
  GLOBAL_ML_TEXAS_ZIP_URL,
  ML_EMPTY_BBOX_PROVENANCE_SCOPE,
  ML_FOOTPRINT_SOURCE_CITATION,
  ML_FOOTPRINT_SOURCE_VINTAGE,
  PRIMARY_OVERLAP_MIN,
  STRADDLE_OVERLAP_MIN,
} from "./constants.js";

export {
  planCountyBuildingFootprints,
} from "./plan-county-building-footprints.js";

export {
  buildAtomForPlannedBuildingFootprint,
  buildAtomsForBuildingFootprintPlan,
  verifyStoredBuildingFootprintAtom,
  type FootprintCountyRunProvenance,
  type StoredBuildingFootprintVerdict,
} from "./building-footprint-atoms.js";

export {
  resolveFootprintRoute,
  type ResolveFootprintRouteInput,
} from "./resolve-footprint-route.js";

export { loadMlFootprintsForBbox, probeMlFootprintsForBbox } from "./ml-footprint-loader.js";
export {
  ensureTexasMlZipCached,
  texasMlZipCachePath,
} from "./ml-texas-zip-cache.js";
export {
  countTexasMlFeatures,
  streamTexasMlFeatures,
} from "./ml-texas-feature-stream.js";
export {
  streamGeoJsonSeqWithBackpressure,
  STREAM_QUEUE_HIGH_WATER,
  STREAM_QUEUE_LOW_WATER,
} from "./stream-geojson-seq-backpressure.js";

export {
  classifyOverlapRatio,
  footprintParcelOverlapRatio,
  joinFootprintsToParcels,
} from "./spatial-join.js";

export {
  STAGED_FOOTPRINT_TABLE,
  STAGED_FOOTPRINT_TABLE_MISSING,
  STAGED_FOOTPRINT_COUNTY_EMPTY,
  STAGED_FOOTPRINT_GEOM_UNREADY,
  StagedFootprintError,
  assertStagedFootprintCountyReady,
  candidatePairsFromEnvelopeRows,
  envelopeOfRing,
  geometryTrueAttach,
  haltStagedFootprintOrThrow,
  joinStagedCandidatePairs,
  loadStagedEnvelopeCandidates,
  planCountyFromStagedGeometryTrueJoin,
  planCountyStagedFootprints,
  probeStagedFootprintCounty,
  probeStagedFootprintTable,
  selectStagedJoinRoster,
  stagedEnvelopeCandidatesSql,
  type StagedCandidatePair,
  type StagedEnvelopeCandidateRow,
  type StagedFootprintErrorCode,
  type StagedFootprintHaltInput,
} from "./staged-footprint-join.js";

export {
  bboxContainsRing,
  geometryOuterRing,
  ringToFootprintGeometry,
} from "./geo.js";

export type {
  BboxWgs84,
  CountyBuildingFootprintPlan,
  FootprintAdapterKind,
  FootprintRoute,
  MlFootprintFeature,
  ParcelFootprintInput,
  ParcelRecord,
  PlannedBuildingFootprint,
  RingLngLat,
} from "./types.js";
