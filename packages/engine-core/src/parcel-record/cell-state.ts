/**
 * Parcel-record cell states — one accounted state per (parcel × rail).
 *
 * Durable template home: packages/engine-core/src/parcel-record/
 * Standing rule: _decisions/2026-09-01_every_parcel_starts_with_a_full_record.md
 */

/** Provenance carried on every value cell. */
export interface CellProvenance {
  source: string;
  vintage: string;
}

export type ScalarValueCell = CellProvenance & {
  kind: "value";
  /** JSON-serializable scalar payload for the rail. */
  value: string | number | boolean | null;
};

export type ScalarAbsentVerifiedCell = {
  kind: "absent-verified";
  basis: string;
};

export type ScalarNotApplicableCell = {
  kind: "not-applicable";
  reason: string;
};

export type ScalarRefusedCell = {
  kind: "refused";
  refusal: string;
};

export type ScalarUnaccountedCell = {
  kind: "unaccounted";
};

export type ScalarCellState =
  | ScalarValueCell
  | ScalarAbsentVerifiedCell
  | ScalarNotApplicableCell
  | ScalarRefusedCell
  | ScalarUnaccountedCell;

/**
 * Companion rails carry rows in a side table; the cell still holds exactly one state.
 * `disposition: "empty-set"` is ONLY for a SOURCED jurisdiction where something looked
 * and found zero rows — distinct from absent-verified (unsourced / cannot look).
 */
export type CompanionValueCell = CellProvenance & {
  kind: "value";
  disposition: "rows" | "empty-set";
  rowCount: number;
};

export type CompanionCellState =
  | CompanionValueCell
  | ScalarAbsentVerifiedCell
  | ScalarNotApplicableCell
  | ScalarRefusedCell
  | ScalarUnaccountedCell;

export type AnyCellState = ScalarCellState | CompanionCellState;

export const EARNED_CELL_KINDS = ["value", "absent-verified", "refused"] as const;
export type EarnedCellKind = (typeof EARNED_CELL_KINDS)[number];

export function isUnaccounted(state: AnyCellState): boolean {
  return state.kind === "unaccounted";
}

export function isEarnedCell(state: AnyCellState): boolean {
  return (
    state.kind === "value" ||
    state.kind === "absent-verified" ||
    state.kind === "refused"
  );
}

export function isPublishable(state: AnyCellState): boolean {
  return state.kind !== "unaccounted";
}

export function countCellState(
  states: readonly AnyCellState[],
): Record<AnyCellState["kind"], number> {
  const out: Record<string, number> = {
    value: 0,
    "absent-verified": 0,
    "not-applicable": 0,
    refused: 0,
    unaccounted: 0,
  };
  for (const s of states) {
    out[s.kind] = (out[s.kind] ?? 0) + 1;
  }
  return out as Record<AnyCellState["kind"], number>;
}
