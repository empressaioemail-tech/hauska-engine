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
  ZONING_VERDICT_FIELDS_RULED_OUT,
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
  evaluateRailGate,
  type PublishGateVerdict,
  type PublishGateOptions,
  type PublishGateWarning,
  type RailGateVerdict,
  type RailGateOptions,
} from "./publish-gate.js";

export {
  loadCountyParcelRecords,
  loadCountyRailCells,
  loadCountyRailCellsPage,
  countyRailCellsFirstAfter,
  DEFAULT_RAIL_CELL_PAGE_SIZE,
  type ParcelRecordSqlClient,
  type LoadCountyParcelRecordsResult,
  type RailCell,
  type RailCellPage,
  type LoadCountyRailCellsResult,
} from "./load.js";

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

/**
 * Old county-rail ledger — read-only disposition for this card.
 * Live-reverified 2026-09-02 (CELL-LEDGER CP1/CP2); prior text here cited
 * MEMORY.md prose rather than a session's own re-read, which ENFORCEMENT.md's
 * "read the authoritative record, never a proxy" section warns against.
 */
export const COUNTY_RAIL_LEDGER_DISPOSITION = {
  store:
    "PRODUCTION_NEONDB_URL / neondb (the shared cortex-prod store) — " +
    "'legacy-design-tools deployment DB' names the SERVICE that manages the " +
    "tables, not a separate physical database; confirmed live, not opening " +
    "that repo.",
  tables: ["county_rail", "county_facet_coverage"],
  status: "dead-gating-indicators",
  liveVerifiedAt: "2026-09-02T15:57:50Z",
  countyRail: {
    rowCount: 14,
    grain: "one row per rail definition (geometry/cad/zoning/roads/flood/... — the RAIL REGISTER), not the county×rail cell table",
    detail:
      "has_writer=true and atom_family_state='present' on all 14 rows, zero variation — confirmed dead as gating fields.",
  },
  countyFacetCoverage: {
    rowCount: 1817,
    grain: "county×rail cell table",
    detail:
      "1,817 live rows, NOT 3,556 — 3,556 is 254 counties × 14 rails, the theoretical denominator, never an " +
      "observed row count; do not requote it as one. rail_state and classification DO vary across rows (not " +
      "literally uniform: rail_state {not-yet:1094, satisfied-present:609, satisfied-absent:76, empty:38}; " +
      "classification {real-at-ceiling:980, true-source-gap:831, needs-crosswalk:6}). The near-gating fields ARE " +
      "effectively dead: integrity_verdict n/a on 98.9% (1798/1817), staleness_flag false on 100% (1817/1817), " +
      "onboarded false on 99.9% (1815/1817), cert_state empty on 99.9% (1815/1817). Strongest evidence: " +
      "max(checked_at) = max(last_verified_at) = 2026-08-23T03:22:18Z across all 1,817 rows — zero recompute " +
      "activity in the 10 days before this reading, while parcel_record_cell (its would-be replacement) was " +
      "measured being written multiple times per minute in the same session.",
  },
  detail:
    "Different grain (county×rail) from parcel_record (parcel×rail); nothing recomputes county_facet_coverage. " +
    "Repoint publish/coverage consumers to parcel_record before retiring county_facet_coverage, per " +
    "ENFORCEMENT.md retirement order. The actual legacy-design-tools consumer list of these two tables was NOT " +
    "verified from this repo — that repo was not opened this session or the prior one; open item, not a claim.",
} as const;
