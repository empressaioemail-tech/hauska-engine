/**
 * Registry-as-engine-input (Phase A / A4) — public surface.
 */

export type {
  JurisdictionRegistryRow,
  RegistryGeometrySourceMode,
  RegistryJoinKey,
} from "./types.js";

export {
  loadRegistryRowByFips,
  requireRegistryRowByFips,
  listRegistryFipsCodes,
  RegistryRowNotFoundError,
} from "./loader.js";
