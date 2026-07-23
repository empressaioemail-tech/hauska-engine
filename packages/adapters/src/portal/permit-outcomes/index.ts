/**
 * Portal / public-record permit-outcome adapters (Master WDLL 3.10).
 *
 * Not parcel-GIS `Adapter` instances — these fetch AHJ outcome fuel for
 * the calibration earning loop (outcome ledger → overlay backtest).
 */

export {
  PERMIT_OUTCOME_KINDS,
  type PermitOutcomeKind,
  type PermitOutcomeJurisdiction,
  type PermitOutcomeSourceId,
  type NormalizedPermitOutcome,
  type PermitOutcomeFetchResult,
  type PermitOutcomeFetchOptions,
} from "./types";

export {
  mapStatusToOutcomeKind,
  isPermitOutcomeKind,
  permitOutcomeRecordHash,
  buildNormalizedOutcome,
  toFindingOutcomePayload,
  permitOutcomeEntityId,
} from "./normalize";

export {
  AUSTIN_SODA_DATASET,
  AUSTIN_SODA_BASE,
  AUSTIN_SODA_SOURCE_ID,
  AUSTIN_SODA_JURISDICTION,
  normalizeAustinSodaRow,
  fetchAustinSodaPermitOutcomes,
} from "./austinSoda";

export {
  BASTROP_MYGOV_PORTAL,
  BASTROP_MYGOV_LOOKUP,
  BASTROP_MYGOV_SOURCE_ID,
  BASTROP_MYGOV_JURISDICTION,
  fetchBastropMygovPermitOutcomes,
} from "./bastropMygov";

export {
  GRAND_COUNTY_UT_SOURCE_ID,
  GRAND_COUNTY_UT_JURISDICTION,
  fetchGrandCountyUtPermitOutcomes,
} from "./grandCountyUt";

import { fetchAustinSodaPermitOutcomes } from "./austinSoda";
import { fetchBastropMygovPermitOutcomes } from "./bastropMygov";
import { fetchGrandCountyUtPermitOutcomes } from "./grandCountyUt";
import type {
  PermitOutcomeFetchOptions,
  PermitOutcomeFetchResult,
  PermitOutcomeSourceId,
} from "./types";

export async function fetchPermitOutcomes(
  sourceId: PermitOutcomeSourceId,
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult> {
  switch (sourceId) {
    case "austin-soda":
      return fetchAustinSodaPermitOutcomes(options);
    case "bastrop-mygov":
      return fetchBastropMygovPermitOutcomes(options);
    case "grand-county-ut":
      return fetchGrandCountyUtPermitOutcomes(options);
    default: {
      const _exhaustive: never = sourceId;
      throw new Error(`unknown permit-outcome source: ${_exhaustive}`);
    }
  }
}

/** Run Austin (live fuel) + bastrop/grand PARTIAL probes. */
export async function fetchPermitOutcomeBundle(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult[]> {
  const [austin, bastrop, grand] = await Promise.all([
    fetchAustinSodaPermitOutcomes(options),
    fetchBastropMygovPermitOutcomes(options),
    fetchGrandCountyUtPermitOutcomes(options),
  ]);
  return [austin, bastrop, grand];
}
