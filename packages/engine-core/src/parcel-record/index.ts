/**
 * Parcel record — full column set per parcel, one accounted cell state per rail.
 */

export type {
  CellProvenance,
  CadNullVerifiedBasis,
  ScalarValueCell,
  ScalarAbsentVerifiedCell,
  ScalarNotApplicableCell,
  ScalarRefusedCell,
  ScalarUnaccountedCell,
  ScalarCellState,
  CompanionValueCell,
  CompanionCellState,
  AnyCellState,
} from "./cell-state.js";
export {
  isUnaccounted,
  isEarnedCell,
  isPublishable,
  countCellState,
  EARNED_CELL_KINDS,
} from "./cell-state.js";
export type { EarnedCellKind } from "./cell-state.js";

export type {
  ParcelRecordRailKey,
  ScalarRailKey,
  CompanionRailKey,
} from "./rail-keys.js";
export {
  PARCEL_RECORD_RAIL_META,
  PARCEL_RECORD_RAIL_KEYS,
  PARCEL_RECORD_SCALAR_RAIL_KEYS,
  PARCEL_RECORD_COMPANION_RAIL_KEYS,
  PARCEL_RECORD_RAIL_COUNT,
  ZONING_ENVELOPE_RAIL_KEYS,
  UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS,
  RAILS_ADDED_BEYOND_SEED,
  RAILS_V2_DECLARED_AHEAD,
  isCompanionRail,
  isScalarRail,
  railAccess,
} from "./rail-keys.js";

export type { RailAccessPair, RailDiscoverability, RailEntitlement, PublicRecordAcquiredBy } from "./access-pair.js";
export {
  PUBLIC_RAIL_ACCESS,
  OWNER_RAIL_ACCESS,
  TENANT_PRIVATE_ACCESS,
  accessForPublicRecordRef,
} from "./access-pair.js";

export type {
  RepresentableScalar,
  ValueHistoryRow,
  SalesHistoryRow,
  P85StoreRef,
  PublicRecordRefRow,
  FloodwayVsFloodplain,
  FloodCompanionRow,
  OwnerRow,
  UtilityKind,
  UtilityServiceRow,
  OssfRow,
  AgValuationRow,
  MineralRightsRow,
  HoaDeedRestrictionsRow,
  OverlayDistrictsRow,
} from "./companion-shapes.js";

export {
  RAIL_LIVENESS_SQL,
  deriveLiveRailKeys,
  deriveDeclaredAheadRailKeys,
} from "./liveness.js";

export type {
  ScalarRecordCells,
  CompanionRecordCells,
  ParcelRecordCells,
  ParcelRecordRow,
} from "./record-shape.js";
export {
  placeKeyFromParts,
  assertFullRecordCells,
  flattenCellStates,
  deleteCellForViolationTest,
} from "./record-shape.js";

export type { ParcelRecordProgramConfig } from "./config.js";
export {
  createParcelRecordProgramConfig,
  texasCtxProgramConfig,
} from "./config.js";

export {
  scalarUnaccounted,
  companionUnaccounted,
  scalarNotApplicable,
  companionNotApplicable,
  buildParcelRecordCells,
  instantiateParcelRecord,
  summarizeCountyRecords,
  UNINCORPORATED_ZONING_REASON,
  type InstantiateParcelInput,
  type CountyInstantiationSummary,
} from "./instantiate.js";

export {
  evaluatePublishGate,
  assertPublishableCounty,
  PublishGateRefusedError,
  poisonCell,
  allRailKeys,
  type PublishGateVerdict,
  type PublishGateOptions,
} from "./publish-gate.js";

export {
  ingestCadOntoRecords,
  ingestAtomsOntoRecords,
  applyAtomPresenceToRecord,
  indexAtomsByPlaceKey,
  diffCellStateCounts,
  type CadPropertyRow,
  type AtomPresenceRow,
  type IngestSummary,
} from "./ingest-existing.js";

export {
  auditNotApplicableCells,
  type NotApplicableAuditReport,
  type NotApplicableAuditRow,
} from "./not-applicable-audit.js";

/** Old county-rail ledger — read-only disposition for this card. */
export const COUNTY_RAIL_LEDGER_DISPOSITION = {
  store: "legacy-design-tools deployment DB",
  tables: ["county_rail", "county_facet_coverage"],
  status: "dead-gating-indicators",
  detail:
    "hasWriter / atomFamilyState / isPartial uniform across 3,556 cells; " +
    "nothing recomputes. Different grain (county×rail) from parcel_record (parcel×rail). " +
    "Repoint publish/coverage consumers to parcel_record before retiring county_facet_coverage.",
} as const;
