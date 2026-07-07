/**
 * RRC H-10 (Annual Disposal/Injection Well Monitoring) adapter.
 *
 * Fetches and normalizes monthly injection and disposal volumes from the RRC's
 * H-10 reporting system. Per ADR-025, injection volumes are reported at the
 * well level (same grain as gas production).
 *
 * **IMPLEMENTATION NOTE**: This adapter is FIXTURE-ONLY for activation due to
 * EXIT-BOUNDED constraints. For production use, download bulk H-10 files from
 * the RRC public data site or use the manual CSV export path documented in
 * the client.
 */

export type {
  H10QueryParams,
  RawH10InjectionRecord,
  H10FetchResult,
} from "./types.js";

export {
  H10_BASE_URL,
  H10_MANUAL_INSTRUCTIONS,
  fetchH10Injection,
} from "./client.js";

export { normalizeH10Injection } from "./normalize.js";
