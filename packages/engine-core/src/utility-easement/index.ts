/**
 * County utility-easement writer — ADR-029 / T3 WS4.
 */

export {
  BASTROP_FIPS,
  BASTROP_COUNTY_EASEMENT_PROVENANCE_SCOPE,
  MCLENNAN_FIPS,
  resolveCountyEasementRoute,
  type CountyEasementRoute,
  type EasementAdapterKind,
  type EasementScope,
  type EasementSourceTier,
} from "./constants.js";

export { classifyEasementStatus } from "./easement-classify.js";

export {
  planCountyEasementHonestAbsence,
  type CountyCoverageAbsencePlan,
} from "./county-absence.js";

export {
  bufferLineStringFt,
  easementIntersectsParcelRing,
  geoJsonRingFromEsri,
  ringToEasementGeometry,
  type EasementFeatureInput,
  type EasementParcelInput,
  type RingLngLat,
} from "./geo.js";

export { fetchCadEasementFeatures } from "./cad-easement-fetch.js";

export { joinMunicipalEasementsToParcels } from "./municipal-easement.js";

export {
  planCountyUtilityEasement,
  type CountyUtilityEasementPlan,
  type PlannedCountyEasementCoverage,
  type PlannedPerParcelEasementAbsence,
  type PlannedPresentEasement,
  type PlannedUtilityEasement,
} from "./plan-county-utility-easement.js";

export {
  buildAtomForPlannedUtilityEasement,
  buildAtomsForUtilityEasementPlan,
  verifyStoredUtilityEasementAtom,
  type StoredUtilityEasementVerdict,
  type UtilityEasementCountyRunProvenance,
} from "./utility-easement-atoms.js";
