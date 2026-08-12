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
  planCountyFloodHazard,
  type CountyFloodHazardPlan,
  type FloodParcelInput,
  type PlannedAbsentFloodHazard,
  type PlannedFloodHazard,
  type PlannedPresentFloodHazard,
} from "./plan-county-flood-hazard.js";

export {
  buildAtomForPlannedFloodHazard,
  buildAtomsForFloodHazardPlan,
  buildCountyFloodHazardCoverageAtom,
  verifyStoredFloodHazardFactAtom,
  type FloodCountyRunProvenance,
  type StoredFloodHazardVerdict,
} from "./flood-hazard-fact-atoms.js";
