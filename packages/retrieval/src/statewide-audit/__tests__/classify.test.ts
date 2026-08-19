// LIVENESS AND DIVERGENCE CONTROL for the gap classifier.
//
// Two things are proven here, and neither is optional:
//
//  1. EVERY GapClass can fire. A classifier whose zeros have never been shown
//     reachable is a dead gate, and a dead gate reports "no defects" forever.
//     The statewide audit's zeros are only evidence because of this file.
//
//  2. Mutating ONE input moves the class. A classifier that returns the same
//     answer whatever you feed it is not measuring anything. Each divergence
//     case below changes exactly one field and asserts the verdict moves.

import { describe, expect, it } from "vitest";

import {
  ALL_GAP_CLASSES,
  SERVED_FIELD_BY_RAIL,
  classifyCell,
  emptyGapCounts,
  isLedgerStalerThanTheWrite,
  isScoredSatisfied,
  type CellInput,
} from "../classify.js";
import type { GapClass, RailKey } from "../types.js";

/** A cell with everything present. Every case below mutates ONE field of it. */
function baseline(): CellInput {
  return {
    countyFips: "48021",
    railKey: "geometry",
    writtenAtoms: 62_398,
    scoredRowExists: true,
    ledgerDisplayState: "satisfied-present",
    scoredComputedAt: "2026-08-14T17:41:22.500Z",
    writtenAt: "2026-08-10T00:00:00.000Z",
    servedPresentParcels: 3_931,
    servedSweptParcels: 62_399,
    railCountiesWritten: 253,
    railCeilingCounties: 253,
    countiesTotal: 254,
  };
}

describe("classifyCell — every class fires", () => {
  const seen = new Set<GapClass>();

  it("no-gap when all three layers carry it", () => {
    const v = classifyCell(baseline());
    expect(v.gapClass).toBe("no-gap");
    expect(v.gapBasis.startsWith("all-three-present: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("unwritten when the store is empty and no ceiling binds", () => {
    const v = classifyCell({
      ...baseline(),
      writtenAtoms: 0,
      railCeilingCounties: 254,
    });
    expect(v.gapClass).toBe("unwritten");
    expect(v.gapBasis.startsWith("store-empty: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("out-of-reach when the store is empty and the rail is at its own ceiling", () => {
    const v = classifyCell({
      ...baseline(),
      railKey: "rrc-wells",
      writtenAtoms: 0,
      railCountiesWritten: 1,
      railCeilingCounties: 1,
    });
    expect(v.gapClass).toBe("out-of-reach");
    expect(v.gapBasis.startsWith("ceiling-reached: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("written-unscored / scorer-absent when NO ledger row exists for the facet", () => {
    const v = classifyCell({
      ...baseline(),
      railKey: "footprint",
      writtenAtoms: 20_182,
      scoredRowExists: false,
      ledgerDisplayState: "not-yet",
    });
    expect(v.gapClass).toBe("written-unscored");
    expect(v.gapBasis.startsWith("scorer-absent: ")).toBe(true);
    // The distinction that decides the remediation: a RECOMPUTE cannot move it.
    expect(v.gapBasis).toContain("RECOMPUTING THE LEDGER WOULD NOT MOVE IT");
    seen.add(v.gapClass);
  });

  it("written-unscored / ledger-stale when the row predates the write", () => {
    const v = classifyCell({
      ...baseline(),
      ledgerDisplayState: "not-yet",
      scoredComputedAt: "2026-08-14T17:41:22.500Z",
      writtenAt: "2026-08-17T12:43:00.000Z",
    });
    expect(v.gapClass).toBe("written-unscored");
    expect(v.gapBasis.startsWith("ledger-stale: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("written-unserved / no-served-slot when the sheet has no field for the rail", () => {
    const v = classifyCell({
      ...baseline(),
      railKey: "mud",
      ledgerDisplayState: "satisfied-present",
    });
    expect(v.gapClass).toBe("written-unserved");
    expect(v.gapBasis.startsWith("no-served-slot: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("written-unserved / served-slot-empty when the field resolves absent everywhere", () => {
    const v = classifyCell({
      ...baseline(),
      railKey: "flood",
      servedPresentParcels: 0,
      servedSweptParcels: 62_399,
    });
    expect(v.gapClass).toBe("written-unserved");
    expect(v.gapBasis.startsWith("served-slot-empty: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("not-measured when the served sweep has not reached the county", () => {
    const v = classifyCell({
      ...baseline(),
      servedPresentParcels: null,
      servedSweptParcels: null,
    });
    expect(v.gapClass).toBe("not-measured");
    expect(v.gapBasis.startsWith("layer-not-measured: ")).toBe(true);
    seen.add(v.gapClass);
  });

  it("covers every declared GapClass — no dead gate", () => {
    expect([...seen].sort()).toEqual([...ALL_GAP_CLASSES].sort());
  });
});

describe("divergence — one input moves, the verdict moves", () => {
  it("writtenAtoms 1 -> 0 flips no-gap to unwritten", () => {
    const before = classifyCell({ ...baseline(), railCeilingCounties: 254 });
    const after = classifyCell({
      ...baseline(),
      railCeilingCounties: 254,
      writtenAtoms: 0,
    });
    expect(before.gapClass).toBe("no-gap");
    expect(after.gapClass).toBe("unwritten");
  });

  it("scoredRowExists true -> false changes the SUB-SHAPE and therefore the remediation", () => {
    const stale = classifyCell({ ...baseline(), ledgerDisplayState: "not-yet" });
    const absent = classifyCell({
      ...baseline(),
      ledgerDisplayState: "not-yet",
      scoredRowExists: false,
    });
    expect(stale.gapClass).toBe("written-unscored");
    expect(absent.gapClass).toBe("written-unscored");
    // Same class, materially different job. If these two ever read the same,
    // somebody will refresh a ledger that has nothing to refresh from.
    expect(stale.gapBasis).not.toBe(absent.gapBasis);
    expect(stale.gapBasis.startsWith("ledger-stale: ")).toBe(true);
    expect(absent.gapBasis.startsWith("scorer-absent: ")).toBe(true);
  });

  it("served present 1 -> 0 flips no-gap to written-unserved", () => {
    const before = classifyCell({ ...baseline(), servedPresentParcels: 1 });
    const after = classifyCell({ ...baseline(), servedPresentParcels: 0 });
    expect(before.gapClass).toBe("no-gap");
    expect(after.gapClass).toBe("written-unserved");
  });

  it("a ceiling that does NOT bind stops manufacturing out-of-reach", () => {
    const binds = classifyCell({
      ...baseline(),
      writtenAtoms: 0,
      railCountiesWritten: 1,
      railCeilingCounties: 1,
    });
    // The rail has already written MORE counties than its stated ceiling, so
    // the ceiling is wrong and must not excuse an empty county.
    const doesNotBind = classifyCell({
      ...baseline(),
      writtenAtoms: 0,
      railCountiesWritten: 200,
      railCeilingCounties: 1,
    });
    expect(binds.gapClass).toBe("out-of-reach");
    expect(doesNotBind.gapClass).toBe("unwritten");
  });
});

describe("helpers", () => {
  it("only the two satisfied states count as scored", () => {
    expect(isScoredSatisfied("satisfied-present")).toBe(true);
    expect(isScoredSatisfied("satisfied-absent")).toBe(true);
    expect(isScoredSatisfied("not-yet")).toBe(false);
    expect(isScoredSatisfied("no-writer")).toBe(false);
    expect(isScoredSatisfied("no-atom")).toBe(false);
    expect(isScoredSatisfied("derivation-indeterminate")).toBe(false);
    expect(isScoredSatisfied(null)).toBe(false);
  });

  it("staleness needs BOTH stamps; an unknown is never upgraded to an accusation", () => {
    expect(
      isLedgerStalerThanTheWrite("2026-08-14T17:41:22.500Z", "2026-08-17T12:43:00.000Z"),
    ).toBe(true);
    expect(
      isLedgerStalerThanTheWrite("2026-08-18T00:00:00.000Z", "2026-08-17T12:43:00.000Z"),
    ).toBe(false);
    expect(isLedgerStalerThanTheWrite(null, "2026-08-17T12:43:00.000Z")).toBe(false);
    expect(isLedgerStalerThanTheWrite("2026-08-14T17:41:22.500Z", null)).toBe(false);
    expect(isLedgerStalerThanTheWrite("not-a-date", "2026-08-17T12:43:00.000Z")).toBe(false);
  });

  it("exactly seven of fourteen rails have NO served slot, and that is a finding", () => {
    const rails = Object.keys(SERVED_FIELD_BY_RAIL) as RailKey[];
    expect(rails).toHaveLength(14);
    const unserved = rails.filter((r) => SERVED_FIELD_BY_RAIL[r] === null).sort();
    expect(unserved).toEqual([
      "easement",
      "footprint",
      "mud",
      "owner",
      "rail-corridor",
      "rrc-pipelines",
      "rrc-wells",
    ]);
  });

  it("emptyGapCounts enumerates every class at zero", () => {
    const counts = emptyGapCounts();
    expect(Object.keys(counts).sort()).toEqual([...ALL_GAP_CLASSES].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});
