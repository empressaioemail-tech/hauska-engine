/**
 * Grand County UT (Moab) permit outcomes — PARTIAL.
 *
 * Public-free corpus jurisdiction, but no bulk public-record building
 * permit ledger was found for programmatic fetch without secrets
 * (county portal is case/address interactive; not SODA/CKAN).
 */

import type {
  PermitOutcomeFetchOptions,
  PermitOutcomeFetchResult,
} from "./types";

export const GRAND_COUNTY_UT_SOURCE_ID = "grand-county-ut" as const;
export const GRAND_COUNTY_UT_JURISDICTION = "grand_county_ut" as const;

const PARTIAL_REASON =
  "grand_county_ut has no verified public bulk building-permit open-data endpoint; public-free code corpus is live but permit-outcome fuel is not scrapable without secrets or a TPIA-style batch.";

export async function fetchGrandCountyUtPermitOutcomes(
  _options: PermitOutcomeFetchOptions = {},
): Promise<PermitOutcomeFetchResult> {
  return {
    sourceId: GRAND_COUNTY_UT_SOURCE_ID,
    jurisdictionTenant: GRAND_COUNTY_UT_JURISDICTION,
    outcomes: [],
    partialReason: PARTIAL_REASON,
    httpStatus: null,
    fetchedAt: new Date().toISOString(),
  };
}
