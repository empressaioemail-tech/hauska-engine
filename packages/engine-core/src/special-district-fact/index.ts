/**
 * County special-district-fact writer — TCEQ water-district membership.
 *
 * Production path: PostGIS true-geometry zone-major ST_Intersects
 * (`postgis-zone-major-st-intersects-true-geom`). The JS centroid planner
 * remains as a unit-test / straddler oracle only.
 */

export {
  bboxContainsPoint,
  bboxIntersects,
  buildDistrictSpatialIndex,
  filterDistrictsByBBox,
  filterDistrictsByCounty,
  geometryCentroid,
  pointInGeoJson,
  type BBox,
  type DistrictSpatialIndex,
  type LngLat,
  type SpecialDistrictFeature,
} from "./geo.js";

export {
  countyFipsFromComptrollerCode,
  loadComptrollerRegistryFromCsv,
  lookupComptrollerTaxRate,
  tceqCountyFipsFromFields,
  type ComptrollerRegistryEntry,
  type ComptrollerTaxRateEnrichment,
} from "./comptroller-registry.js";

export {
  buildEmptyCountyDistrictAbsenceReason,
  buildOutsideSourceAbsenceReason,
  EMPTY_COUNTY_DISTRICT_ABSENCE_RULE,
  OUTSIDE_TRUE_GEOM_ABSENCE_RULE,
} from "./honesty.js";

export {
  TRUE_GEOM_MEMBERSHIP_METHOD,
  assertTrueGeomMembershipMethod,
  type TrueGeomMembershipMethod,
} from "./membership-method.js";

export {
  attachComptrollerTaxRates,
  planCountySpecialDistricts,
  type CountySpecialDistrictPlan,
  type PlannedAbsentSpecialDistrict,
  type PlannedPresentSpecialDistrict,
  type PlannedSpecialDistrict,
  type SpecialDistrictParcelInput,
} from "./plan-county-special-districts.js";

export {
  planCountySpecialDistrictsPostgis,
  type PostgisSpecialDistrictPlanMeta,
  type PostgisSpecialDistrictPlanOptions,
  type PostgisSpecialDistrictPlanResult,
} from "./postgis-special-district-plan.js";

export {
  buildPlanPayload,
  drainSpecialDistrictPlanPayload,
  readPlanPayload,
  writePlanPayload,
  type SpecialDistrictPlanPayload,
  type SpecialDistrictPlanStoreTruth,
} from "./plan-payload.js";

export {
  buildAtomForPlannedSpecialDistrict,
  buildAtomsForSpecialDistrictPlan,
  buildCountySpecialDistrictCoverageAtom,
  verifyStoredSpecialDistrictFactAtom,
  type SpecialDistrictCountyRunProvenance,
  type StoredSpecialDistrictVerdict,
} from "./special-district-fact-atoms.js";
