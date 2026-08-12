/**
 * Factory 1.5 zoning staging — acquisition → neondb staging table.
 * Does NOT write atoms. Factory 2 zoning writer consumes drain later.
 */

export {
  TEXAS_WGS84_BOUNDS,
  assertTexasWgs84Bbox,
  bboxFromEsriRings,
  bboxFromGeoJsonCoordinates,
  isPlausibleTexasWgs84Bbox,
  ZoningProjectionError,
  type GeoBbox,
} from "./bbox.js";

export {
  assertPayloadContract,
  assertSourceTierSatisfied,
  buildStagingRowId,
  ZoningStagingContractError,
  type GeometryGrain,
  type GeoJsonPolygon,
  type LayerRole,
  type ZoningStagingPayload,
} from "./payload-contract.js";

export {
  ZONING_STAGING_REGISTRY,
  listZoningStagingCityKeys,
  resolveZoningStagingCity,
  type ZoningCityRegistryEntry,
} from "./registry.js";

export {
  normalizeZoningFeature,
  type ArcGisFeature,
  type NormalizeOptions,
} from "./normalize.js";

export {
  dbRowToPayload,
  drainZoningStagingRows,
  type DrainOptions,
  type DrainResult,
  type ZoningStagingDbRow,
} from "./drain.js";
