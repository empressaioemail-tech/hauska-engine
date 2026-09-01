/**
 * Instantiate a full parcel record — the ONLY constructor for ParcelRecordCells.
 */

import type { CompanionCellState, ScalarCellState } from "./cell-state.js";
import type { PermitSourcingConfig } from "./config.js";
import { isPermitJurisdictionSourced } from "./config.js";
import {
  unresolvedPermitsBasis,
  unsourcedPermitsCell,
} from "./permits-field.js";
import {
  PARCEL_RECORD_COMPANION_RAIL_KEYS,
  PARCEL_RECORD_SCALAR_RAIL_KEYS,
  UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS,
} from "./rail-keys.js";
import type { ParcelRecordCells, ParcelRecordRow } from "./record-shape.js";
import {
  assertFullRecordCells,
  placeKeyFromParts,
} from "./record-shape.js";

export const UNINCORPORATED_ZONING_REASON =
  "unincorporated parcel — county does not zone land outside city limits";

export function scalarUnaccounted(): ScalarCellState {
  return { kind: "unaccounted" };
}

export function companionUnaccounted(): CompanionCellState {
  return { kind: "unaccounted" };
}

export function scalarNotApplicable(reason: string): ScalarCellState {
  return { kind: "not-applicable", reason };
}

export function companionNotApplicable(reason: string): CompanionCellState {
  return { kind: "not-applicable", reason };
}

const NOT_APPLICABLE_RAIL_SET = new Set<string>(UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS);

function permitsCellAtInstantiate(input: InstantiateParcelInput): CompanionCellState {
  const jurisdictionKey = input.permitsJurisdictionKey?.trim() || null;
  if (!jurisdictionKey) {
    return {
      kind: "absent-verified",
      basis: unresolvedPermitsBasis(),
    };
  }
  const config = input.permitSourcing;
  if (!config) {
    return unsourcedPermitsCell(jurisdictionKey);
  }
  if (isPermitJurisdictionSourced(config, jurisdictionKey)) {
    return companionUnaccounted();
  }
  return unsourcedPermitsCell(jurisdictionKey);
}

function cellForRailAtInstantiate(
  railKey: string,
  input: InstantiateParcelInput,
  nowIso: string,
): ScalarCellState | CompanionCellState {
  if (railKey === "countyFips") {
    return {
      kind: "value",
      value: input.countyFips,
      source: "instantiate",
      vintage: nowIso,
    };
  }
  if (railKey === "permits") {
    return permitsCellAtInstantiate(input);
  }
  if (input.incorporated === false && NOT_APPLICABLE_RAIL_SET.has(railKey)) {
    return (PARCEL_RECORD_COMPANION_RAIL_KEYS as readonly string[]).includes(railKey)
      ? companionNotApplicable(UNINCORPORATED_ZONING_REASON)
      : scalarNotApplicable(UNINCORPORATED_ZONING_REASON);
  }
  return (PARCEL_RECORD_COMPANION_RAIL_KEYS as readonly string[]).includes(railKey)
    ? companionUnaccounted()
    : scalarUnaccounted();
}

/**
 * Sole constructor for a complete column set. Do not build ParcelRecordCells elsewhere.
 */
export function buildParcelRecordCells(input: InstantiateParcelInput): ParcelRecordCells {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const cells: Record<string, ScalarCellState | CompanionCellState> = {};

  for (const key of PARCEL_RECORD_SCALAR_RAIL_KEYS) {
    cells[key] = cellForRailAtInstantiate(key, input, nowIso) as ScalarCellState;
  }
  for (const key of PARCEL_RECORD_COMPANION_RAIL_KEYS) {
    cells[key] = cellForRailAtInstantiate(key, input, nowIso) as CompanionCellState;
  }

  assertFullRecordCells(cells);
  return cells;
}

export interface InstantiateParcelInput {
  countyFips: string;
  propId: string;
  /** Must be measured per parcel — never scaled from county aggregates. */
  incorporated: boolean | null;
  /**
   * AHJ permit jurisdiction (e.g. austin_tx, bastrop_tx). When set and unsourced,
   * permits stamps absent-verified — not unaccounted, not empty-set.
   */
  permitsJurisdictionKey?: string | null;
  /** When omitted, sourced jurisdictions leave permits unaccounted until ingest. */
  permitSourcing?: PermitSourcingConfig;
  nowIso?: string;
}

export function instantiateParcelRecord(input: InstantiateParcelInput): ParcelRecordRow {
  const nowIso = input.nowIso ?? new Date().toISOString();
  return {
    placeKey: placeKeyFromParts(input.countyFips, input.propId),
    countyFips: input.countyFips,
    propId: input.propId,
    incorporated: input.incorporated,
    cells: buildParcelRecordCells(input),
    instantiatedAt: nowIso,
  };
}

export interface CountyInstantiationSummary {
  countyFips: string;
  parcelCount: number;
  cellCount: number;
  byState: Record<string, number>;
}

export function summarizeCountyRecords(
  records: readonly ParcelRecordRow[],
): CountyInstantiationSummary {
  if (records.length === 0) {
    return {
      countyFips: "",
      parcelCount: 0,
      cellCount: 0,
      byState: {},
    };
  }
  const byState: Record<string, number> = {};
  let cellCount = 0;
  for (const rec of records) {
    for (const key of Object.keys(rec.cells) as Array<keyof ParcelRecordCells>) {
      cellCount += 1;
      const kind = rec.cells[key].kind;
      byState[kind] = (byState[kind] ?? 0) + 1;
    }
  }
  return {
    countyFips: records[0]!.countyFips,
    parcelCount: records.length,
    cellCount,
    byState,
  };
}
