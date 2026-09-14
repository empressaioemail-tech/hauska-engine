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
 * P-195: cells.length === 0 for a (county, rail) pair -- loadCountyRailCells
 * guarantees this happens ONLY when the county itself has zero parcel_record
 * rows (never instantiated; every real parcel carries a cell for every
 * rail), so this is a structural "this county does not exist yet" signal,
 * never a per-rail scoping decision. A rail that IS built and live
 * elsewhere in the program still earning a clean excludedDeclaredAhead for
 * such a county is the exact defect this row exists to close: an empty
 * county produced 65 clean excluded verdicts and the gate passed it.
 *
 * Deliberately NOT triggered by a populated county whose cells are all
 * unaccounted or all not-applicable for one rail -- that shape is
 * indistinguishable from (and, in real, ratified production behavior, IS)
 * a rail deliberately scoped to a subset of counties by design (e.g.
 * maxImperviousCoverPct's writer is hard-scoped to Travis only and never
 * writes so much as a not-applicable cell anywhere else; see hauska-factory
 * test/gate-county-scoped-rail.test.mjs, which this change must not
 * regress). That shape keeps reading excludedDeclaredAhead, unchanged.
 */
export const RAIL_NEVER_FILLED = "RAIL_NEVER_FILLED";

export interface RailGateVerdict {
  ok: boolean;
  railKey: ParcelRecordRailKey;
  cellCount: number;
  unaccountedCount: number;
  unaccountedSamples: Array<{ placeKey: string }>;
  /** Required, same as PublishGateVerdict: [railKey] when the rail is legitimately excluded from scoring, else []. */
  excludedDeclaredAhead: readonly ParcelRecordRailKey[];
  /** Present only when ok is false because this (county, rail) pair carried zero cells at all (P-195). */
  code?: typeof RAIL_NEVER_FILLED;
}

export interface RailGateOptions {
  maxSamples?: number;
  /**
   * Rail keys with zero earned cells ANYWHERE in the store, across every
   * county -- e.g. the complement of loadProgramWideLiveRailKeys's result
   * against PARCEL_RECORD_RAIL_KEYS. REQUIRED, no default: without it this
   * function cannot distinguish, for a structurally empty county
   * (cells.length === 0), "declared ahead, nobody has attempted this rail
   * on the whole program yet" (nothing to report) from "this rail is live
   * elsewhere but this county was never filled at all" (P-195, a real
   * gap). A caller with no way to supply this must not call
   * evaluateRailGate; there is no silent fallback, per ENFORCEMENT's rule
   * against fail-open defaults.
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

  if (!live) {
    if (cells.length === 0 && !declaredAheadProgramWide.has(railKey)) {
      return {
        ok: false,
        railKey,
        cellCount: 0,
        unaccountedCount: 0,
        unaccountedSamples: [],
        excludedDeclaredAhead: [],
        code: RAIL_NEVER_FILLED,
      };
    }
    return {
      ok: true,
      railKey,
      cellCount: cells.length,
      unaccountedCount: 0,
      unaccountedSamples: [],
      excludedDeclaredAhead: [railKey],
    };
  }

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

  return {
    ok: unaccountedCount === 0,
    railKey,
    cellCount: cells.length,
    unaccountedCount,
    unaccountedSamples,
    excludedDeclaredAhead: [],
  };
}
