/**
 * Honest-absence planning helpers (ADR-029 ruling #1 hybrid absence shape).
 */

import type { EasementScope } from "./constants.js";
import { resolveCountyEasementRoute } from "./constants.js";

export interface CountyCoverageAbsencePlan {
  outcome: "county-coverage-absence";
  countyFips: string;
  provenanceScope: readonly string[];
}

/**
 * ONE county-coverage row when no published easement source exists for the county.
 * Unincorporated parcels rely on this at serve time — not millions of per-parcel sentinels.
 */
export function planCountyEasementHonestAbsence(input: {
  countyFips: string;
  scope?: EasementScope;
}): {
  countyCoverage: CountyCoverageAbsencePlan;
  atomsWouldWrite: number;
} {
  const route = resolveCountyEasementRoute(input.countyFips, input.scope ?? "county");
  if (route.adapterKind !== "honest-absence") {
    throw new Error(
      `planCountyEasementHonestAbsence called for ${input.countyFips} but route is ${route.adapterKind}`,
    );
  }
  const countyCoverage: CountyCoverageAbsencePlan = {
    outcome: "county-coverage-absence",
    countyFips: input.countyFips,
    provenanceScope: route.provenanceScope,
  };
  return {
    countyCoverage,
    atomsWouldWrite: 1,
  };
}
