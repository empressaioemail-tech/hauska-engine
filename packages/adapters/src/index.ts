/**
 * Public surface of `@hauska-engine/adapters` — DA-PI-4.
 *
 * The api-server's generate-layers route imports {@link runAdapters},
 * {@link ALL_ADAPTERS}, and {@link resolveJurisdiction}. UI code that
 * needs to render a setback table imports the loaders from
 * `./local/setbacks`.
 */

export {
  type Adapter,
  type AdapterContext,
  type AdapterError,
  type AdapterJurisdiction,
  type AdapterLocalKey,
  type AdapterParcelContext,
  type AdapterResult,
  type AdapterRunOutcome,
  type AdapterSourceKind,
  type AdapterStateKey,
  type AdapterTier,
  type UpstreamFreshness,
  type UpstreamFreshnessStatus,
  AdapterRunError,
} from "./types";

export { runAdapters, type RunAdaptersInput } from "./runner";

export {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  SLOW_UPSTREAM_TIMEOUT_MS,
} from "./timeouts";

export {
  toCacheKey,
  CACHE_COORDINATE_PRECISION,
  FEDERAL_TIER_CACHE_PREDICATE,
  type AdapterCacheHit,
  type AdapterCacheKey,
  type AdapterCachePredicate,
  type AdapterResultCache,
} from "./cache";

export {
  ALL_ADAPTERS,
  FEDERAL_ADAPTERS,
  STATE_ADAPTERS,
  LOCAL_ADAPTERS,
  isFccEnabled,
  isTceqEdwardsEnabled,
} from "./registry";

export {
  resolveJurisdiction,
  type ResolveJurisdictionInput,
} from "./jurisdictionResolver";

export * from "./topography/index";

export {
  isRecord,
  pickString,
  pickNumber,
  pickFirstString,
  pickFirstNumber,
  PARCEL_ID_KEYS,
  PARCEL_ACRES_KEYS,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  FLOOD_ZONE_KEYS,
} from "./_payloadSummaryHelpers";

export {
  PILOT_JURISDICTIONS,
  PILOT_JURISDICTION_COVERAGE,
  PILOT_LOCAL_KEYS,
  PILOT_STATE_KEYS,
  FEDERAL_PILOT_LAYER_KINDS,
  type PilotJurisdiction,
  type PilotJurisdictionCoverage,
  type PilotJurisdictionLayer,
} from "./pilotJurisdictions";

export {
  filterApplicableAdapters,
  hasApplicableAdapters,
  noApplicableAdaptersMessage,
} from "./eligibility";

export {
  getSetbackTable,
  getSetbackTableForZoning,
  getSetbackDistrict,
  listSetbackTables,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
  type SetbackDistrict,
} from "./local/setbacks";

/** Master WDLL 3.10 — public-record permit-outcome fuel for calibration. */
export {
  PERMIT_OUTCOME_KINDS,
  fetchPermitOutcomes,
  fetchPermitOutcomeBundle,
  fetchAustinSodaPermitOutcomes,
  fetchBastropMygovPermitOutcomes,
  fetchGrandCountyUtPermitOutcomes,
  normalizeAustinSodaRow,
  mapStatusToOutcomeKind,
  toFindingOutcomePayload,
  permitOutcomeEntityId,
  type PermitOutcomeKind,
  type PermitOutcomeJurisdiction,
  type PermitOutcomeSourceId,
  type NormalizedPermitOutcome,
  type PermitOutcomeFetchResult,
  type PermitOutcomeFetchOptions,
} from "./portal/permit-outcomes/index";
