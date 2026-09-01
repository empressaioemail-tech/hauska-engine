/**
 * Compiler-enforced full parcel record — every rail present, never partial.
 */

import type { CompanionCellState, ScalarCellState } from "./cell-state.js";
import type {
  CompanionRailKey,
  ParcelRecordRailKey,
  ScalarRailKey,
} from "./rail-keys.js";
import { PARCEL_RECORD_RAIL_KEYS, isCompanionRail } from "./rail-keys.js";

export type ScalarRecordCells = { [K in ScalarRailKey]: ScalarCellState };
export type CompanionRecordCells = { [K in CompanionRailKey]: CompanionCellState };

/** Closed column set — every rail required; no optional cells at compile time. */
export type ParcelRecordCells = ScalarRecordCells & CompanionRecordCells;

export interface ParcelRecordRow {
  placeKey: string;
  countyFips: string;
  propId: string;
  /** false = unincorporated (measured); true = in city; null = not yet measured. */
  incorporated: boolean | null;
  cells: ParcelRecordCells;
  instantiatedAt: string;
}

export function placeKeyFromParts(countyFips: string, propId: string): string {
  return `${countyFips}:${propId}`;
}

/**
 * Runtime backstop only — callers must receive cells from instantiateParcelRecord.
 * Parameter is unknown so Partial never leaks optional cells to readers.
 */
export function assertFullRecordCells(cells: unknown): asserts cells is ParcelRecordCells {
  if (cells == null || typeof cells !== "object") {
    throw new Error("parcel record cells must be an object");
  }
  const record = cells as Record<string, unknown>;
  for (const key of PARCEL_RECORD_RAIL_KEYS) {
    if (record[key] == null) {
      throw new Error(`parcel record missing rail column: ${key}`);
    }
  }
}

export function flattenCellStates(record: ParcelRecordRow): Array<{
  railKey: ParcelRecordRailKey;
  state: ScalarCellState | CompanionCellState;
}> {
  return PARCEL_RECORD_RAIL_KEYS.map((railKey) => ({
    railKey,
    state: record.cells[railKey],
  }));
}

/** @internal Exported for tests that deliberately violate shape. */
export function deleteCellForViolationTest(
  cells: ParcelRecordCells,
  key: ParcelRecordRailKey,
): unknown {
  const copy = { ...cells };
  delete (copy as Record<string, unknown>)[key];
  return copy;
}

export function cellKindForRail(
  key: ParcelRecordRailKey,
): "scalar" | "companion" {
  return isCompanionRail(key) ? "companion" : "scalar";
}
