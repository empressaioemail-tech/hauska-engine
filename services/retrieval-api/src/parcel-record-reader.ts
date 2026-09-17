/**
 * P-152 ONE-READER: `GET /property-nodes/:parcelNodeId/record`.
 *
 * Walks the closed 65-rail parcel_record registry for one parcel, decides
 * per-rail `serve` state, and dereferences an atom when a cell names one.
 * See OPS-23 P-152 dispatch (`_dispatches/2026-09-11_p152-reader_dispatch.md`)
 * for the full contract this implements.
 *
 * P-297 / A-193 SUPERSEDES THE OLD DECISION (2026-09-17, operator ruling
 * `_decisions/2026-09-16_county_verdict_is_not_the_serve_switch.md`, OPS-24
 * law 7). Until this change the reader mirrored legacy-design-tools'
 * `parcelRecordAllowlist.ts` exactly: `record` when a pair was slated AND the
 * county's gate verdict was `pass`, `refused` on any other recognised verdict,
 * `legacy-transitional` when unslated. The verdict is a COMPLETENESS AND
 * PUBLISH GRADE for a whole (county, rail) pair; it is not the switch that
 * decides what one parcel shows. Because the verdict refuses on a single
 * unaccounted cell, one unaccounted cell anywhere in a county moved EVERY
 * parcel in that county off the ledger — including parcels whose own cell was
 * earned. That is the regression A-192 named for the six onboarded counties.
 *
 * THE DECISION NOW (the same rule the LDT half builds, asserted against the
 * same fixture — `src/__fixtures__/cell-serve-rule.json`):
 *
 *   | cell state                                  | served as                          |
 *   |---------------------------------------------|------------------------------------|
 *   | `value` (incl. a verified zero)             | the value, its source and vintage  |
 *   | `absent-verified`, `not-applicable`         | the stated absence, with its reason|
 *   | `refused`, `unaccounted`                    | a declared refusal, cell's reason  |
 *   | no cell, malformed cell, unreadable store   | a declared refusal naming that     |
 *
 * The legacy or baked value is NEVER the answer for a slated rail. An unslated
 * pair keeps its pre-cutover path, byte-identically.
 *
 * THE VERDICT STILL TRAVELS (`gate`), and decides nothing: it is loaded only
 * for a slated pair exactly as before, and returned as information so a
 * surface can say "this county's rail is incomplete" without hiding a
 * parcel's earned value. No serve decision in this module reads it.
 *
 * WIRE STATES ARE UNCHANGED — `record` | `refused` | `legacy-transitional`.
 * No new state is needed for a stated absence: `record` with the cell's own
 * `kind: "absent-verified"` / `"not-applicable"` already carries it, and every
 * existing consumer already distinguishes those by cell kind. Adding a state
 * would silently break the consumers that gate on `serve === "record"` and
 * then read the absence (engine-core's `recordOverlayDistricts` is the live
 * example). ONE field is added, additively: `refusal`, because a refusal must
 * carry its reason and for a missing cell there is no cell to carry it.
 */

import {
  PARCEL_RECORD_RAIL_KEYS,
  PARCEL_RECORD_RAIL_REGISTRY_SHA,
} from "./parcel-record-rail-registry.js";
import parcelRecordSlateData from "./parcel-record-slate.json" with { type: "json" };
import type { ParcelFactoryStore, ParcelGateVerdictKind } from "./parcel-record-db.js";

const PARCEL_RECORD_SLATE: ReadonlySet<string> = new Set(parcelRecordSlateData.slate);

export type ParcelRecordServeState = "record" | "refused" | "legacy-transitional";

/* ------------------------------ THE ONE RULE ------------------------------ */
/**
 * P-297's cell-serve rule. This is the ONLY place this repo decides what a
 * slated rail serves.
 *
 * THE FIXTURE IS THE CROSS-REPO CONTRACT, NOT THIS FILE.
 * `src/__fixtures__/cell-serve-rule.json` is a byte-identical copy of
 * legacy-design-tools' own copy (LDT PR #710, the P-297 half). Both readers
 * consume the same rows, so neither repo can decide what a cell kind means
 * without the other's copy disagreeing; `src/__tests__/cell-serve-rule.test.ts`
 * fails if this file and that fixture part company. The four `expect` fields in
 * the fixture -- `serve`, `form`, `absenceVerdict`, `refusalCode` -- are exactly
 * the fields returned below, so the comparison is literal, not a paraphrase.
 *
 * `_ruleId` must equal `CELL_SERVE_RULE_ID` in both repos; a divergence test in
 * each repo guards its own copy. The fixture carries `pinnedRowNames`: the rows
 * a copy may not quietly drop.
 *
 * THE SLATE, NOT THE VERDICT, IS THE CUT-OVER SWITCH. `slated` is passed in as
 * a boolean so the rule needs no store and so each repo's own slate -- this
 * one vendored from LDT as `parcel-record-slate.json` -- stays the authority on
 * WHICH rails are cut over. What a cut-over rail serves is the parcel's own
 * cell, and nothing else.
 */
export const CELL_SERVE_RULE_ID = "cell-serve-rule-v1" as const;

/** `value`: the cell's value is served. `absence`: a stated absence. `refusal`: a declared refusal. */
export type CellServeForm = "value" | "absence" | "refusal";

export type CellServeAbsenceVerdict = "absent-verified" | "not-applicable";

/**
 * The refusal codes this reader emits, pinned by the shared fixture's
 * `refusalCode` column. They are the SAME tokens legacy-design-tools' own cell
 * reader emits (`parcelRecordCellRead.ts`'s `ParcelRecordCellRefusalCode`) --
 * deliberately, because the fixture is a cross-repo contract and a reader that
 * named the same refusal two different ways could not be held to it. LDT's
 * fifth code, `store-not-configured`, is a TRANSPORT refusal: it has no
 * per-rail meaning here (this service's own route answers a 503 `errorClass`
 * instead — `store-not-configured` when no factory store is configured,
 * `read-failed` when a read fails), so it is
 * not in this union and never reaches a rail.
 */
export type CellServeRefusalCode =
  | "engine-refused"
  | "unaccounted"
  | "malformed-cell"
  | "no-such-parcel-or-rail";

/**
 * The rule's answer. A discriminated union rather than a bag of nullable
 * fields, so "refusal with no code" and "value with a refusal code" cannot be
 * constructed, and so the reader never has to guess a fallback code or reason.
 */
export type CellServeDecision =
  /** Unslated pair: this rail's pre-cutover path runs untouched. */
  | { serve: "current-path"; form: null; absenceVerdict: null; refusalCode: null; reason: null }
  /** A slated pair whose own cell answers: this is the value. */
  | { serve: "cell"; form: "value"; absenceVerdict: null; refusalCode: null; reason: null }
  /** A slated pair whose cell positively asserts an absence, with its basis. */
  | {
      serve: "cell";
      form: "absence";
      absenceVerdict: CellServeAbsenceVerdict;
      refusalCode: null;
      reason: null;
    }
  /** A slated pair that must be refused, with the code and the reason it travels under. */
  | {
      serve: "cell";
      form: "refusal";
      absenceVerdict: null;
      refusalCode: CellServeRefusalCode;
      reason: string;
    };

/** The refusal a slated rail declares. Non-null exactly when `serve === "refused"`. */
export interface ParcelRecordServeRefusal {
  code: CellServeRefusalCode;
  reason: string;
}

/** The three material cell kinds that carry a positive answer. Anything else is refused, never guessed. */
const CELL_KIND_VALUE = "value";
const CELL_KIND_ABSENT_VERIFIED = "absent-verified";
const CELL_KIND_NOT_APPLICABLE = "not-applicable";
const CELL_KIND_REFUSED = "refused";
const CELL_KIND_UNACCOUNTED = "unaccounted";

function asCellRecord(cell: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return null;
  return cell;
}

function asCellKind(cell: Record<string, unknown>): string | null {
  const kind = cell.kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind : null;
}

function asCellReason(cell: Record<string, unknown>, fallback: string): string {
  const reason = cell.reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : fallback;
}

/**
 * Is this (county, rail) pair in the code-owned slate? The slate question on
 * its own, without I/O and without a cell, so a caller can ask it before
 * spending a read. It is the rule's own first branch, not a second rule.
 */
export function isSlatedForCellServe(countyFips: string, railKey: string): boolean {
  const county = countyFips.trim();
  if (!county) return false;
  return PARCEL_RECORD_SLATE.has(slateKey(county, railKey));
}

/**
 * The rule. `cell` is the parcel's own decoded `cell_state` for this rail, or
 * `null` when the store held no row for it -- never `undefined`, so a caller
 * cannot pass "I did not look" off as "there was nothing there".
 *
 * A malformed body (not an object, no readable `kind`, or a kind this reader
 * does not recognise) is its OWN refusal with its own code. It is never folded
 * into "no cell", because "the store says something I cannot read" and "the
 * store says nothing" are different findings and a consumer debugging one must
 * not be shown the other.
 */
export function resolveCellServeDecision(
  slated: boolean,
  cell: Record<string, unknown> | null,
): CellServeDecision {
  if (!slated) {
    return { serve: "current-path", form: null, absenceVerdict: null, refusalCode: null, reason: null };
  }

  const record = asCellRecord(cell);
  if (!record) {
    return {
      serve: "cell",
      form: "refusal",
      absenceVerdict: null,
      refusalCode: "no-such-parcel-or-rail",
      reason:
        "No parcel_record_cell row exists for this parcel on this slated rail. Refusing rather than " +
        "serving the legacy or baked value: the store's silence about a rail that is supposed to be " +
        "served from it is not evidence about the parcel.",
    };
  }

  const kind = asCellKind(record);
  if (kind === null) {
    return {
      serve: "cell",
      form: "refusal",
      absenceVerdict: null,
      refusalCode: "malformed-cell",
      reason:
        "parcel_record_cell carries no readable 'kind'. Refusing rather than inventing a state.",
    };
  }

  switch (kind) {
    case CELL_KIND_VALUE:
      // A `value` cell with no scalar `value` field is still a value: some
      // rails are row-shaped (companion rows carry the payload) and the
      // shared fixture pins this row deliberately.
      return { serve: "cell", form: "value", absenceVerdict: null, refusalCode: null, reason: null };

    case CELL_KIND_ABSENT_VERIFIED:
      return {
        serve: "cell",
        form: "absence",
        absenceVerdict: "absent-verified",
        refusalCode: null,
        reason: null,
      };

    case CELL_KIND_NOT_APPLICABLE:
      return {
        serve: "cell",
        form: "absence",
        absenceVerdict: "not-applicable",
        refusalCode: null,
        reason: null,
      };

    case CELL_KIND_REFUSED:
      return {
        serve: "cell",
        form: "refusal",
        absenceVerdict: null,
        refusalCode: "engine-refused",
        reason: asCellReason(record, "parcel_record marked this cell refused with no reason recorded."),
      };

    case CELL_KIND_UNACCOUNTED:
      return {
        serve: "cell",
        form: "refusal",
        absenceVerdict: null,
        refusalCode: "unaccounted",
        reason: asCellReason(
          record,
          "parcel_record has not yet examined this rail for this parcel. Refusing rather than serving a pipeline word.",
        ),
      };

    default:
      return {
        serve: "cell",
        form: "refusal",
        absenceVerdict: null,
        refusalCode: "malformed-cell",
        reason:
          `parcel_record_cell has kind ${JSON.stringify(kind)}, not one of ` +
          "value/absent-verified/not-applicable/refused/unaccounted. Refusing rather than guessing.",
      };
  }
}

/** The wire's `serve` state for a decision. Unslated is legacy-transitional; every refusal is `refused`. */
function wireServeFromDecision(decision: CellServeDecision): ParcelRecordServeState {
  if (decision.serve === "current-path") return "legacy-transitional";
  return decision.form === "refusal" ? "refused" : "record";
}

/** The refusal detail for the wire, or null when the decision is not a refusal. */
function refusalWireFromDecision(decision: CellServeDecision): ParcelRecordServeRefusal | null {
  if (decision.form !== "refusal") return null;
  return { code: decision.refusalCode, reason: decision.reason };
}

export interface AtomDereference {
  did: string;
  entityType: string;
  body: unknown;
}

/** Minimal seam onto HybridRetrieval.getAtom — decouples this module from the full retrieval package type for testability. */
export interface AtomDereferencer {
  getAtom(input: { atomDid: string }): Promise<{ atom: unknown | null }>;
}

export interface ParcelRecordRailResponse {
  /** The decoded cell_state object verbatim (including 'kind'), or null when no parcel_record_cell row exists for this (place_key, rail_key). Deviation from the dispatch's non-nullable sketch: a rail genuinely can have no row, and fabricating a 'kind' would violate the fail-closed/never-invent-a-value convention this program is built on. Flagged in the close's `contradicted` field. */
  cell: Record<string, unknown> | null;
  gate: { verdict: ParcelGateVerdictKind | null; evaluatedAt: string | null };
  serve: ParcelRecordServeState;
  /**
   * P-297 additive field. Non-null exactly when `serve === "refused"`: the
   * code and reason the slated rail's own cell state produced. It exists
   * because the ruling requires a declared refusal to CARRY its reason, and a
   * missing or malformed cell has no cell object on the wire to carry one.
   * Additive only: no existing consumer reads it, `serve` keeps its three
   * states, and a client that ignores unknown fields is unaffected.
   */
  refusal: ParcelRecordServeRefusal | null;
  atom: AtomDereference | null;
  atomBacked: boolean;
  rendering: { text: string; atomVersion: string; vocabVersion: string } | null;
  companions: unknown[];
}

export interface ParcelRecordResponse {
  parcelNodeId: string;
  placeKey: string | null;
  countyFips: string;
  railRegistrySha: string;
  readAt: string;
  rails: Record<string, ParcelRecordRailResponse>;
  refused: { reason: string } | null;
}

function slateKey(countyFips: string, railKey: string): string {
  return `${countyFips}:${railKey}`;
}

/** Candidate field name for a future atom pointer on a cell (P-163 has not landed; no live cell carries one yet). */
function extractAtomDid(cellRaw: Record<string, unknown> | null): string | null {
  if (!cellRaw) return null;
  const v = cellRaw.atomDid;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function asStoredAtom(atom: unknown): AtomDereference | null {
  if (!atom || typeof atom !== "object") return null;
  const rec = atom as Record<string, unknown>;
  const entityType = typeof rec.entityType === "string" ? rec.entityType : "unknown";
  const did =
    typeof rec.atomDid === "string" && rec.atomDid.length > 0
      ? rec.atomDid
      : typeof rec.did === "string"
        ? rec.did
        : "";
  return { did, entityType, body: atom };
}

async function buildRailResponse(
  store: ParcelFactoryStore,
  dereferencer: AtomDereferencer,
  placeKey: string,
  countyFips: string,
  railKey: string,
): Promise<ParcelRecordRailResponse> {
  const [cell, companions] = await Promise.all([
    store.loadCell(placeKey, railKey),
    store.loadCompanionRows(placeKey, railKey),
  ]);

  const slated = isSlatedForCellServe(countyFips, railKey);

  // P-297 / A-193: the county verdict is INFORMATION on this response and
  // decides nothing. It is still loaded only for a slated pair (the same
  // short-circuit as before: an unslated pair was never going to serve from a
  // verdict), and no branch below reads it.
  let gate: { verdict: ParcelGateVerdictKind | null; evaluatedAt: string | null } = {
    verdict: null,
    evaluatedAt: null,
  };
  if (slated) {
    const verdict = await store.loadGateVerdict(countyFips, railKey);
    if (verdict) gate = { verdict: verdict.verdict, evaluatedAt: verdict.evaluatedAt };
  }

  // THE ONE RULE. What a slated rail serves comes from THIS parcel's own cell,
  // never from the county's grade. An unslated pair keeps its pre-cutover path.
  const decision = resolveCellServeDecision(slated, cell.raw);
  const serve = wireServeFromDecision(decision);
  const refusal = refusalWireFromDecision(decision);

  const atomDid = extractAtomDid(cell.raw);
  let atom: AtomDereference | null = null;
  if (atomDid) {
    const result = await dereferencer.getAtom({ atomDid });
    atom = asStoredAtom(result.atom);
  }

  return {
    cell: cell.raw,
    gate,
    serve,
    refusal,
    atom,
    atomBacked: atom !== null,
    rendering: null,
    companions,
  };
}

/**
 * `parcelNodeId`'s prop_id token is already normalizeForJoin'd by
 * convention (dispatch fact). `countyFips`/`normalizedPropId` are the two
 * halves already split by the caller (route-level id validation regex).
 */
export async function readParcelRecord(
  store: ParcelFactoryStore,
  dereferencer: AtomDereferencer,
  parcelNodeId: string,
  countyFips: string,
  normalizedPropId: string,
): Promise<ParcelRecordResponse> {
  const readAt = new Date().toISOString();
  const resolution = await store.resolvePlaceKey(countyFips, normalizedPropId);

  if (resolution.state === "ambiguous") {
    return {
      parcelNodeId,
      placeKey: null,
      countyFips,
      railRegistrySha: PARCEL_RECORD_RAIL_REGISTRY_SHA,
      readAt,
      rails: {},
      refused: {
        reason:
          `crosswalk ambiguous: both ${resolution.candidates.join(" and ")} exist as ` +
          `distinct parcel_record identities for normalized prop_id ${normalizedPropId}. ` +
          `P-161 has not landed a crosswalk rule; refusing rather than guessing which is authoritative.`,
      },
    };
  }

  const placeKey =
    resolution.state === "resolved" ? resolution.placeKey : `${countyFips}:${normalizedPropId}`;

  const rails: Record<string, ParcelRecordRailResponse> = {};
  await Promise.all(
    PARCEL_RECORD_RAIL_KEYS.map(async (railKey) => {
      rails[railKey] = await buildRailResponse(store, dereferencer, placeKey, countyFips, railKey);
    }),
  );

  return {
    parcelNodeId,
    placeKey,
    countyFips,
    railRegistrySha: PARCEL_RECORD_RAIL_REGISTRY_SHA,
    readAt,
    rails,
    refused: null,
  };
}

export { PARCEL_RECORD_SLATE };
