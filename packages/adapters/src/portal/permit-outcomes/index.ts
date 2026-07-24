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

export {
  SAN_MARCOS_SOURCE_ID,
  SAN_MARCOS_JURISDICTION,
  fetchSanMarcosPermitOutcomes,
} from "./sanMarcosArcGis";

export {
  SAN_ANTONIO_SOURCE_ID,
  SAN_ANTONIO_JURISDICTION,
  fetchSanAntonioPermitOutcomes,
} from "./sanAntonioCsv";

export {
  CEDAR_PARK_SOURCE_ID,
  CEDAR_PARK_JURISDICTION,
  fetchCedarParkPermitOutcomes,
} from "./cedarParkArcGis";

export {
  NEW_BRAUNFELS_SOURCE_ID,
  NEW_BRAUNFELS_JURISDICTION,
  fetchNewBraunfelsPermitOutcomes,
} from "./newBraunfelsArcGis";

import { fetchAustinSodaPermitOutcomes } from "./austinSoda";
import { fetchBastropMygovPermitOutcomes } from "./bastropMygov";
import { fetchCedarParkPermitOutcomes } from "./cedarParkArcGis";
import { fetchGrandCountyUtPermitOutcomes } from "./grandCountyUt";
import { fetchNewBraunfelsPermitOutcomes } from "./newBraunfelsArcGis";
import { fetchSanAntonioPermitOutcomes } from "./sanAntonioCsv";
import { fetchSanMarcosPermitOutcomes } from "./sanMarcosArcGis";
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
    case "san-marcos-arcgis":
      return fetchSanMarcosPermitOutcomes(options);
    case "san-antonio-csv":
      return fetchSanAntonioPermitOutcomes(options);
    case "cedar-park-arcgis":
      return fetchCedarParkPermitOutcomes(options);
    case "new-braunfels-arcgis":
      return fetchNewBraunfelsPermitOutcomes(options);
    default: {
      const _exhaustive: never = sourceId;
      throw new Error(`unknown permit-outcome source: ${_exhaustive}`);
    }
  }
}

/** Live bulk feeds + PARTIAL probes for breadth 3.10. */
export async function fetchPermitOutcomeBundle(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult[]> {
  return Promise.all([
    fetchAustinSodaPermitOutcomes(options),
    fetchSanMarcosPermitOutcomes(options),
    fetchSanAntonioPermitOutcomes(options),
    fetchCedarParkPermitOutcomes(options),
    fetchNewBraunfelsPermitOutcomes(options),
    fetchBastropMygovPermitOutcomes(options),
    fetchGrandCountyUtPermitOutcomes(options),
  ]);
}
