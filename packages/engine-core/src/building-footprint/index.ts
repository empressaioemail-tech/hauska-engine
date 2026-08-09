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

export { loadMlFootprintsForBbox } from "./ml-footprint-loader.js";

export {
  classifyOverlapRatio,
  footprintParcelOverlapRatio,
  joinFootprintsToParcels,
} from "./spatial-join.js";

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
