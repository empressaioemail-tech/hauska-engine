export {
  fetchRrcWellsForBBox,
  TEXAS_RRC_WELLS_LAYER,
  type RrcWellFeature,
  type CountyWellFetchResult,
} from "./fetch-wells.js";

export {
  STAGED_WELL_ADAPTER,
  STAGED_WELL_SOURCE,
  fetchRrcWellsFromStagedTable,
  stagedWellTableExists,
} from "./fetch-wells-staged.js";

export {
  bboxContainsPoint,
  distancePointToPolygonMeters,
  expandBBox,
  geometryCentroid,
  haversineMeters,
  pointInGeoJson,
  type BBox,
  type LngLat,
} from "./geo.js";

export {
  WELL_FACT_PROXIMITY_RADIUS_METERS,
  planCountyWellFacts,
  wellParcelDistanceMeters,
  type CountyWellFactPlan,
  type PlannedWellFact,
  type WellParcelInput,
} from "./plan-county-well-facts.js";

export {
  buildApiNumber14,
  deriveOrphanedFlag,
  mapSymnumToWellStatus,
  mapSymnumToWellType,
} from "./symnum.js";

export {
  assertNoChunkPkCollapse,
  countWellFactPersistCollisions,
  wellFactPersistDid,
} from "./persist-key.js";

export {
  buildAtomForPlannedWellFact,
  buildAtomsForWellFactPlan,
  buildCountyWellFactCoverageAtom,
  verifyStoredWellFactAtom,
  type StoredWellFactVerdict,
  type WellCountyRunProvenance,
} from "./well-fact-atoms.js";
