/**
 * County owner-fact writer — parcels ⨝ cad_property via normalizeForJoin.
 */

export {
  indexOwnerCadRowsByJoinKey,
  planCountyOwnerFacts,
  type CountyOwnerFactPlan,
  type OwnerAbsenceKind,
  type OwnerCadRowInput,
  type OwnerParcelInput,
  type PlannedAbsentOwnerFact,
  type PlannedOwnerFact,
  type PlannedPresentOwnerFact,
} from "./plan-county-owner-facts.js";

export {
  buildAtomForPlannedOwnerFact,
  buildAtomsForOwnerFactPlan,
  buildCountyOwnerCoverageAtom,
  verifyStoredOwnerFactAtom,
  type OwnerCountyRunProvenance,
  type StoredOwnerFactVerdict,
} from "./owner-fact-atoms.js";
