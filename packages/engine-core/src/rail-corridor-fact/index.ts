export {
  haversineMeters,
  ringsFromGeoJson,
  lineStringsFromGeoJson,
  minEdgeToLineDistanceMeters,
  minPointToParcelEdgeMeters,
  expandBbox,
  bboxIntersects,
} from "./geo.js";

export {
  NTAD_NARN_LINES_URL,
  NTAD_GRADE_CROSSINGS_URL,
  NTAD_NARN_SOURCE_VINTAGE,
  fetchNtadRailCorridorsForCounty,
  fetchNtadGradeCrossingsForCounty,
  probeNtadRailSource,
  mapNetToStatus,
  mapNetToClass,
  type RailCorridorFeature,
  type GradeCrossingFeature,
  type NtadSourceProbeResult,
} from "./ntad-source.js";

export {
  loadStagedNtadCorridors,
  loadStagedNtadCrossings,
} from "./staged-narn.js";

export {
  planCountyRailCorridor,
  type RailParcelInput,
  type CountyRailCorridorPlan,
  type PlannedRailCorridor,
} from "./plan-county-rail-corridor.js";

export {
  buildAtomsForRailCorridorPlan,
  buildAtomForPlannedRailCorridor,
  verifyStoredRailCorridorFactAtom,
  type RailCorridorCountyRunProvenance,
} from "./rail-corridor-fact-atoms.js";
