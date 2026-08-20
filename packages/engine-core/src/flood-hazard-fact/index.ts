/**
 * County flood-hazard-fact writer — FEMA NFHL S_FLD_HAZ_AR evaluation.
 */

export {
  bboxContainsPoint,
  bboxIntersects,
  filterZonesByBBox,
  findZoneAtPoint,
  geometryCentroid,
  isSfhaFlag,
  parseSfhaTf,
  pickPreferredFloodZone,
  pointInGeoJson,
  ringCentroid,
  UnrecognisedSfhaFlagError,
  type BBox,
  type FloodZoneFeature,
  type LngLat,
  type SfhaFlag,
} from "./geo.js";

export {
  bboxFromZones,
  buildFloodZoneGrid,
  countGeometryVertices,
  findZoneAtPointWithGrid,
  gatherGridCandidateIndices,
  FLOOD_ZONE_GRID_VERTEX_BUDGET,
  type FloodZoneGrid,
} from "./flood-zone-grid.js";

export {
  assembleCountyFloodHazardPlan,
  hasUsableCentroid,
  isQueryableParcel,
  planCountyFloodHazard,
  selectPlannableParcels,
  type CountyFloodHazardPlan,
  type FloodParcelInput,
  type PlannableParcel,
  type PlannableParcelSelection,
  type PlannedAbsentFloodHazard,
  type PlannedFloodHazard,
  type PlannedPresentFloodHazard,
  type RefusedFloodHazard,
  type ResolvedFloodZone,
} from "./plan-county-flood-hazard.js";

export {
  candidatesSql,
  containsSql,
  countZonesInBBox,
  defaultPlanBatchSize,
  firstZoneVintageInBBox,
  planCountyFloodHazardPostgis,
  probeFloodZoneGeomReadiness,
  zoneMajorContainsSql,
  FLOOD_ZONE_TABLE,
  type FloodPlanBackend,
  type FloodZoneGeomReadiness,
  type PostgisPlanOptions,
  type PostgisPlanResult,
} from "./postgis-flood-plan.js";

export {
  buildAtomForPlannedFloodHazard,
  buildAtomsForFloodHazardPlan,
  buildCountyFloodHazardCoverageAtom,
  verifyStoredFloodHazardFactAtom,
  type FloodCountyRunProvenance,
  type StoredFloodHazardVerdict,
} from "./flood-hazard-fact-atoms.js";

export {
  FLOOD_PLAN_NDJSON_FORMAT,
  buildFloodPlanPayload,
  digestFloodPlan,
  drainFloodPlanPayload,
  readFloodPlanPayload,
  writeFloodPlanPayload,
  type FloodPlanDigest,
  type FloodPlanPayload,
} from "./plan-payload.js";

export {
  classifySamplePointContainment,
  countTestableRings,
  emptyContainmentTally,
  floodDeterminationGate,
  memoryStoreContainingCentroids,
  MemoryParcelRingStore,
  tallyContainment,
  type ContainmentState,
  type ContainmentTally,
  type ContainmentVerdict,
  type EmittableContainmentState,
  type ParcelRingLoad,
  type ParcelRingRef,
  type ParcelRingStore,
} from "./containment.js";

export {
  fetchTxgioParcelRing,
  loadTxgioParcelRingStore,
  parseFloodParcelStoreKey,
  TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL,
  TXGIO_PARCEL_RING_BY_PROP_ID_SQL,
  TXGIO_PARCEL_RING_COUNTY_BATCH_SQL,
} from "./txgio-parcel-ring-store.js";
