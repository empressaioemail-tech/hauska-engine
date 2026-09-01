/**
 * Parcel record — full column set per parcel, one accounted cell state per rail.
 */

export type {
  CellProvenance,
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
  isPublishable,
  countCellState,
} from "./cell-state.js";

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
  isCompanionRail,
  isScalarRail,
} from "./rail-keys.js";

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
  type PermitJurisdictionEntry,
  type PermitSourcingConfig,
  createPermitSourcingConfig,
  texasCtxPermitSourcingUnsourced,
  texasCtxPermitSourcingWithAustin,
  isPermitJurisdictionSourced,
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

export type { ParcelPermitRow, PermitsServeField } from "./permits-field.js";
export {
  unsourcedPermitsBasis,
  unresolvedPermitsBasis,
  unsourcedPermitsCell,
  sourcedEmptyPermitsCell,
  sourcedPermitsWithRowsCell,
  isPermitsUnsourcedCell,
  isPermitsSourcedEmptyCell,
  isPermitsSourcedWithRowsCell,
  permitsServeStatesAreDistinct,
  projectPermitsServeField,
} from "./permits-field.js";

export {
  AUSTIN_SODA_PERMIT_SOURCE,
  TRAVIS_COUNTY_FIPS,
  AUSTIN_TX_JURISDICTION,
  tcadIdToTravisPropId,
  placeKeyFromTcadId,
  normalizeAustinSodaPermitRow,
  indexPermitsByPlaceKey,
  applyPermitsToRecord,
  ingestPermitsOntoRecords,
  type RawAustinSodaPermitRow,
  type PermitsByPlaceKey,
} from "./ingest-permits.js";

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
