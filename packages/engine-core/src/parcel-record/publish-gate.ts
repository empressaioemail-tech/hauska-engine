/**
 * Publish gate — refuse when any LIVE rail cell is unaccounted.
 * Declared-ahead rails (no earned cell program-wide) are excluded and listed.
 */

import type { AnyCellState } from "./cell-state.js";
import { isEarnedCell, isUnaccounted } from "./cell-state.js";
import {
  deriveDeclaredAheadRailKeys,
  deriveLiveRailKeys,
} from "./liveness.js";
import type { RailCell } from "./load.js";
import type { ParcelRecordRailKey } from "./rail-keys.js";
import { PARCEL_RECORD_RAIL_KEYS } from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { flattenCellStates } from "./record-shape.js";

/**
 * WARN-level cross-check for the full-rail-poison bypass (known limit,
 * liveness.ts): when a rail had at least one earned cell in a PRIOR
 * evaluation but has zero in this one, deriveLiveRailKeys demotes it to
 * declared-ahead and evaluatePublishGate excludes it from scoring — silently
 * identical to a rail nobody ever attempted. This warning distinguishes
 * "went to zero" from "was always zero" WHEN the caller supplies prior
 * liveness state via PublishGateOptions.priorLiveRailKeys. Accept-and-warn
 * by decision (CP2, 2026-09-02) — not a hard refusal, and not a new
 * acquisition-status registry; opt-in only, so omitting the option preserves
 * today's silent behavior exactly.
 */
export interface PublishGateWarning {
  kind: "full-rail-poison";
  railKey: ParcelRecordRailKey;
  detail: string;
}

export interface PublishGateVerdict {
  ok: boolean;
  unaccountedCount: number;
  unaccountedSamples: Array<{ placeKey: string; railKey: ParcelRecordRailKey }>;
  /** Required. Rails that were not scored because they are not live. */
  excludedDeclaredAhead: readonly ParcelRecordRailKey[];
  /** Required. Empty unless options.priorLiveRailKeys surfaces a full-rail-poison rail. */
  warnings: PublishGateWarning[];
}

export interface PublishGateOptions {
  /** Cap sample list size in the verdict. */
  maxSamples?: number;
  /**
   * Rails known to be live as of a prior evaluation on the same (or a
   * comparable) record set. Optional and additive — when omitted, no
   * full-rail-poison warning can fire, matching pre-existing behavior
   * exactly. The caller is the source of "prior" (e.g. a previous verdict's
   * complement of excludedDeclaredAhead); this module holds no history.
   */
  priorLiveRailKeys?: readonly ParcelRecordRailKey[];
}

export function evaluatePublishGate(
  records: readonly ParcelRecordRow[],
  options: PublishGateOptions = {},
): PublishGateVerdict {
  const maxSamples = options.maxSamples ?? 20;
  const live = new Set(deriveLiveRailKeys(records));
  const excludedDeclaredAhead = deriveDeclaredAheadRailKeys(records);
  const unaccountedSamples: PublishGateVerdict["unaccountedSamples"] = [];
  let unaccountedCount = 0;

  for (const rec of records) {
    for (const { railKey, state } of flattenCellStates(rec)) {
      if (!live.has(railKey)) continue;
      if (isUnaccounted(state)) {
        unaccountedCount += 1;
        if (unaccountedSamples.length < maxSamples) {
          unaccountedSamples.push({ placeKey: rec.placeKey, railKey });
        }
      }
    }
  }

  const priorLive = new Set(options.priorLiveRailKeys ?? []);
  const warnings: PublishGateWarning[] = [];
  for (const railKey of excludedDeclaredAhead) {
    if (!priorLive.has(railKey)) continue;
    warnings.push({
      kind: "full-rail-poison",
      railKey,
      detail:
        `rail "${railKey}" had at least one earned cell in the prior evaluation but has zero now; ` +
        "it is being scored as declared-ahead (never attempted) rather than distinguished as a rail " +
        "that went from live to fully unaccounted.",
    });
  }

  return {
    ok: unaccountedCount === 0,
    unaccountedCount,
    unaccountedSamples,
    excludedDeclaredAhead,
    warnings,
  };
}

export class PublishGateRefusedError extends Error {
  readonly verdict: PublishGateVerdict;

  constructor(verdict: PublishGateVerdict) {
    super(
      `publish gate refused: ${verdict.unaccountedCount} unaccounted cell(s) remain on live rails; excludedDeclaredAhead=${verdict.excludedDeclaredAhead.join(",")}`,
    );
    this.name = "PublishGateRefusedError";
    this.verdict = verdict;
  }
}

export function assertPublishableCounty(
  records: readonly ParcelRecordRow[],
  options?: PublishGateOptions,
): void {
  const verdict = evaluatePublishGate(records, options);
  if (!verdict.ok) {
    throw new PublishGateRefusedError(verdict);
  }
}

/** Poison one cell to unaccounted — violation-test helper. */
export function poisonCell(
  record: ParcelRecordRow,
  railKey: ParcelRecordRailKey,
): ParcelRecordRow {
  const next = structuredClone(record);
  const state: AnyCellState = { kind: "unaccounted" };
  (next.cells as Record<string, AnyCellState>)[railKey] = state;
  return next;
}

export function allRailKeys(): readonly ParcelRecordRailKey[] {
  return PARCEL_RECORD_RAIL_KEYS;
}

/**
 * Verdict for ONE (county, rail) pair — same shape as PublishGateVerdict
 * (ok/unaccountedCount/excludedDeclaredAhead/warnings) so a B-READER
 * allowlist consumer written against one generalizes to the other, but
 * computed from a single rail's cells rather than a full multi-rail record
 * set. PARCEL-B-GATE-SCHED (F-01): the whole-county evaluatePublishGate
 * requires every ParcelRecordRow to carry all 65 rails (assertFullRecordCells),
 * so a rail-scoped caller cannot construct a valid input without fabricating
 * the other 64 rails -- which would corrupt deriveLiveRailKeys' cross-record
 * liveness computation for rails never actually loaded, and would misreport
 * excludedDeclaredAhead as covering rails this call never touched. Liveness
 * is naturally decomposable per rail (a rail is "live" iff at least one
 * record's cell for THAT rail is earned; that definition does not reference
 * any other rail), so this is a genuine narrowing of the same primitives
 * (isEarnedCell/isUnaccounted), not a redesign of the gate's semantics.
 */

/**
 * P-195: this county has zero earned cells for a rail that is NOT
 * declared-ahead program-wide, and at least one cell here is genuinely
 * `unaccounted` (never a rail whose cells are entirely `not-applicable` --
 * see evaluateRailGate's doc comment). Distinct from a normal `ok:false`
 * (some cells unaccounted among a live rail) because here NO cell in this
 * county earned anything at all: either the county itself has zero cells
 * (never instantiated) or this specific rail was simply never run for it,
 * while the rail is live somewhere else in the program. Both read the same
 * to a caller that only has this county's data, hence one code.
 */
export const RAIL_NEVER_FILLED = "RAIL_NEVER_FILLED";

export interface RailGateVerdict {
  ok: boolean;
  railKey: ParcelRecordRailKey;
  cellCount: number;
  unaccountedCount: number;
  unaccountedSamples: Array<{ placeKey: string }>;
  /** Required, same as PublishGateVerdict: [railKey] when the rail is legitimately excluded from scoring (declared-ahead program-wide, or entirely not-applicable in this county), else []. */
  excludedDeclaredAhead: readonly ParcelRecordRailKey[];
  /** Present only when ok is false because this county earned nothing at all for railKey (P-195). */
  code?: typeof RAIL_NEVER_FILLED;
}

export interface RailGateOptions {
  maxSamples?: number;
  /**
   * Rail keys with zero earned cells ANYWHERE in the store, across every
   * county -- e.g. the complement of loadProgramWideLiveRailKeys's result
   * against PARCEL_RECORD_RAIL_KEYS. REQUIRED, no default: without it this
   * function cannot distinguish "declared ahead, nobody has attempted this
   * rail on the whole program yet" from "this county specifically was
   * never filled for a rail the program already uses elsewhere" -- the
   * P-195 defect (a totally empty/never-filled county read every rail as
   * excluded and the gate passed it cleanly). A caller with no way to
   * supply this must not call evaluateRailGate; there is no silent
   * fallback, per ENFORCEMENT's rule against fail-open defaults.
   */
  programWideDeclaredAheadRailKeys:
    | ReadonlySet<ParcelRecordRailKey>
    | readonly ParcelRecordRailKey[];
}

export function evaluateRailGate(
  cells: readonly RailCell[],
  railKey: ParcelRecordRailKey,
  options: RailGateOptions,
): RailGateVerdict {
  const maxSamples = options.maxSamples ?? 20;
  const declaredAheadProgramWide =
    options.programWideDeclaredAheadRailKeys instanceof Set
      ? options.programWideDeclaredAheadRailKeys
      : new Set(options.programWideDeclaredAheadRailKeys);
  const live = cells.some((c) => isEarnedCell(c.state));

  const unaccountedSamples: RailGateVerdict["unaccountedSamples"] = [];
  let unaccountedCount = 0;
  for (const cell of cells) {
    if (isUnaccounted(cell.state)) {
      unaccountedCount += 1;
      if (unaccountedSamples.length < maxSamples) {
        unaccountedSamples.push({ placeKey: cell.placeKey });
      }
    }
  }

  if (!live) {
    // Entirely not-applicable (never empty by vacuous truth -- cells.length
    // must be > 0 for this to hold) is a legitimate, deliberately-stamped
    // accounted state, county-specific, and stays excluded regardless of
    // whether the rail is declared-ahead program-wide: a fully
    // unincorporated county's zoningDistrict cells, for example, are
    // correctly not-applicable everywhere in it even though zoningDistrict
    // is very much live in other counties. See __tests__/rail-gate.test.ts,
    // "not-applicable cells are neither earned nor unaccounted."
    const allNotApplicable =
      cells.length > 0 && cells.every((c) => c.state.kind === "not-applicable");
    if (allNotApplicable || declaredAheadProgramWide.has(railKey)) {
      return {
        ok: true,
        railKey,
        cellCount: cells.length,
        unaccountedCount: 0,
        unaccountedSamples: [],
        excludedDeclaredAhead: [railKey],
      };
    }
    // Zero earned cells, not all not-applicable, and not declared-ahead
    // anywhere in the program: either this county has no cells at all
    // (never instantiated) or this rail specifically was never run for it.
    // Never a silent pass -- P-195.
    return {
      ok: false,
      railKey,
      cellCount: cells.length,
      unaccountedCount,
      unaccountedSamples,
      excludedDeclaredAhead: [],
      code: RAIL_NEVER_FILLED,
    };
  }

  return {
    ok: unaccountedCount === 0,
    railKey,
    cellCount: cells.length,
    unaccountedCount,
    unaccountedSamples,
    excludedDeclaredAhead: [],
  };
}
