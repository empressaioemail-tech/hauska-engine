export * from "./types.js";
export * from "./classify.js";
export * from "./classify-county-street.js";
export * from "./geometry.js";
export {
  emitRoadNode,
  parseOsmWayElement,
  bastropRoadIntakeDescriptor,
  elginOsmRoadIntakeDescriptor,
} from "./emit-road-node.js";
export {
  emitCountySurveyedRoadNode,
  parseCountyStreetFeature,
  bastropCountySurveyedRoadDescriptor,
} from "./emit-county-road-node.js";
export {
  emitCountyRoadwayRoadNode,
  parseBastropRoadwayFeature,
  bastropCountyRoadwayDescriptor,
} from "./emit-county-roadway-node.js";
export { roadAtomToWarmSource } from "./road-to-warm-source.js";
export {
  fetchOverpassRoadsInBbox,
  fetchOverpassRoadsInBboxOutcome,
  fetchOverpassRoadsTiled,
  fetchBastropRoadsForIngest,
  fetchBastropOverpassOutcome,
  parseBastropBboxFromEnv,
  resolveBastropRoadIngestBbox,
  resolveBastropRoadIngestScope,
  BASTROP_COUNTY_BBOX,
  BASTROP_CITY_BBOX,
  CALDWELL_COUNTY_BBOX,
  LOCKHART_CITY_BBOX,
  ELGIN_CITY_BBOX,
  resolveCaldwellRoadIngestBbox,
  fetchCaldwellRoadsForIngest,
  resolveElginRoadIngestBbox,
  fetchElginRoadsForIngest,
  OSM_OVERPASS_URL,
  OVERPASS_MAX_ATTEMPTS,
  OVERPASS_RETRY_BASE_MS,
} from "./fetch-overpass-bbox.js";
export {
  fetchStreetsSurveyed2016Features,
  STREETS_SURVEYED_2016_URL,
} from "./fetch-streets-surveyed-2016.js";
export {
  fetchBastropCountyRoadwayFeatures,
  BASTROP_COUNTY_ROADWAY_URL,
} from "./fetch-bastrop-county-roadway.js";
export {
  resolveHonestRoadCoverage,
  coverageEmitsRoads,
  overpassProbeCoverageMode,
} from "./honest-fallback.js";
export type {
  OverpassFetchOutcome,
  FallbackSourcePresence,
  HonestRoadCoverage,
  FallbackSourceName,
} from "./honest-fallback.js";
export {
  resolveBastropRoadsHonest,
  probeBastropRoadFallbackPresence,
} from "./resolve-bastrop-roads-honest.js";

export {
  classifyCaldwellCadAttributes,
  caldwellCadIsAuthoritative,
  isDefinedCaldwellSurface,
  caldwellCadSyntheticWayId,
  CALDWELL_CAD_ROAD_ID_OFFSET,
} from "./classify-caldwell-cad.js";
export {
  emitCaldwellCadRoadNode,
  parseCaldwellCadRoadFeature,
  caldwellCadRoadIntakeDescriptor,
  caldwellOsmRoadIntakeDescriptor,
} from "./emit-caldwell-cad-road-node.js";
export {
  fetchCaldwellCadRoadFeatures,
  CALDWELL_CAD_ROAD_CENTERLINES_URL,
} from "./fetch-caldwell-cad-roads.js";
export {
  cityGisProvenancePosture,
  isUnreachableCityGisVerdict,
  unreachableCityGisReconHolds,
} from "./unreachable-city-gis.js";
export type {
  CityGisReachability,
  RoadSourceReconFixture,
} from "./unreachable-city-gis.js";
