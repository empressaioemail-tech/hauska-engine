/**
 * RRC PDQ (Production Data Query) adapter.
 *
 * Fetches and normalizes monthly oil and gas production volumes from the RRC's
 * PDQ surface. Models the Texas reporting split per ADR-025:
 * - Oil production → rrc-lease anchor (lease-level reporting)
 * - Gas production → well anchor (well-level reporting)
 *
 * **IMPLEMENTATION NOTE**: This adapter is FIXTURE-ONLY for activation due to
 * EXIT-BOUNDED constraints. The PDQ web surface requires complex session
 * handling, and bulk EBCDIC extracts exceed the 20MB size limit. For production
 * use, download bulk extracts from ftp://ftpe.rrc.texas.gov/shfwba/ or use
 * the manual CSV export path documented in the client.
 */

export type {
  PdqQueryParams,
  RawOilProductionRecord,
  RawGasProductionRecord,
  PdqOilFetchResult,
  PdqGasFetchResult,
} from "./types.js";

export {
  PDQ_BASE_URL,
  PDQ_MANUAL_INSTRUCTIONS,
  fetchOilProduction,
  fetchGasProduction,
} from "./client.js";

export {
  normalizeOilProduction,
  normalizeGasProduction,
} from "./normalize.js";
