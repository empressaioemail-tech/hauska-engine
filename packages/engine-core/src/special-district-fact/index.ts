/**
 * County special-district-fact writer — TCEQ water-district PIP evaluation.
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

export { buildOutsideSourceAbsenceReason } from "./honesty.js";

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
  buildAtomForPlannedSpecialDistrict,
  buildAtomsForSpecialDistrictPlan,
  buildCountySpecialDistrictCoverageAtom,
  verifyStoredSpecialDistrictFactAtom,
  type SpecialDistrictCountyRunProvenance,
  type StoredSpecialDistrictVerdict,
} from "./special-district-fact-atoms.js";
