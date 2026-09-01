/**
 * Publish gate — refuse when any LIVE rail cell is unaccounted.
 * Declared-ahead rails (no earned cell program-wide) are excluded and listed.
 */

import type { AnyCellState } from "./cell-state.js";
import { isUnaccounted } from "./cell-state.js";
import {
  deriveDeclaredAheadRailKeys,
  deriveLiveRailKeys,
} from "./liveness.js";
import type { ParcelRecordRailKey } from "./rail-keys.js";
import { PARCEL_RECORD_RAIL_KEYS } from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { flattenCellStates } from "./record-shape.js";

export interface PublishGateVerdict {
  ok: boolean;
  unaccountedCount: number;
  unaccountedSamples: Array<{ placeKey: string; railKey: ParcelRecordRailKey }>;
  /** Required. Rails that were not scored because they are not live. */
  excludedDeclaredAhead: readonly ParcelRecordRailKey[];
}

export interface PublishGateOptions {
  /** Cap sample list size in the verdict. */
  maxSamples?: number;
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

  return {
    ok: unaccountedCount === 0,
    unaccountedCount,
    unaccountedSamples,
    excludedDeclaredAhead,
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
