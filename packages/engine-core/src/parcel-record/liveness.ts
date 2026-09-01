/**
 * Derived rail liveness — never a hand flag on rail metadata.
 *
 * A rail is live when at least one earned cell (value | absent-verified |
 * refused) exists in the records passed in (program-wide for that evaluation).
 * Known limit (decision): derivation cannot distinguish never-sourced from
 * sourced-but-failed-everywhere. The run ledger is the backstop.
 */

import { isEarnedCell, type AnyCellState } from "./cell-state.js";
import {
  PARCEL_RECORD_RAIL_KEYS,
  type ParcelRecordRailKey,
} from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { flattenCellStates } from "./record-shape.js";

/**
 * SQL contract for the same derivation against parcel_record_cell.
 * Keep in lockstep with isEarnedCell / deriveLiveRailKeys.
 */
export const RAIL_LIVENESS_SQL = [
  "SELECT rail_key",
  "FROM parcel_record_cell",
  "WHERE cell_state->>'kind' IN ('value', 'absent-verified', 'refused')",
  "GROUP BY rail_key",
  "HAVING COUNT(*) >= 1",
].join("\n");

export function deriveLiveRailKeys(
  records: readonly ParcelRecordRow[],
): readonly ParcelRecordRailKey[] {
  const live = new Set<ParcelRecordRailKey>();
  for (const rec of records) {
    for (const { railKey, state } of flattenCellStates(rec)) {
      if (isEarnedCell(state as AnyCellState)) live.add(railKey);
    }
  }
  return PARCEL_RECORD_RAIL_KEYS.filter((k) => live.has(k));
}

export function deriveDeclaredAheadRailKeys(
  records: readonly ParcelRecordRow[],
): readonly ParcelRecordRailKey[] {
  const live = new Set(deriveLiveRailKeys(records));
  return PARCEL_RECORD_RAIL_KEYS.filter((k) => !live.has(k));
}
