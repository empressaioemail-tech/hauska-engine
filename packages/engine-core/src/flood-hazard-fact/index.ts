/**
 * County flood-hazard-fact writer — FEMA NFHL S_FLD_HAZ_AR evaluation.
 */

export {
  classifySamplePointContainment,
  countTestableRings,
  deriveFloodSamplePoint,
  emptyContainmentTally,
  floodDeterminationGate,
  tallyContainment,
  type ContainmentState,
  type ContainmentTally,
  type ContainmentVerdict,
  type EmittableContainmentState,
  type FloodEmitReasonCode,
  type FloodRefusalReasonCode,
  type FloodDeterminationDecision,
  type FloodDeterminationGateResult,
  type SamplePoint,
  type SamplePointDerivation,
} from "./containment.js";

export {
  bboxContainsPoint,
  bboxIntersects,
  filterZonesByBBox,
  findZoneAtPoint,
  geometryCentroid,
  isSfhaFlag,
  pointInGeoJson,
  ringCentroid,
  type BBox,
  type FloodZoneFeature,
  type LngLat,
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
  type FloodHazardFactAtomWithSampling,
  type FloodSamplingProvenance,
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
