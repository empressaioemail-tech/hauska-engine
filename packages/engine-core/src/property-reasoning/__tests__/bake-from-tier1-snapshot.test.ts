import { describe, expect, it } from "vitest";

import { emitFromTier1Snapshot } from "../bake-from-tier1-snapshot.js";

describe("emitFromTier1Snapshot setback via cityKey (WDLL 3.4–3.6)", () => {
  it("emits setback-RULE + envelope DERIVED for austin-tx SF-3", () => {
    const result = emitFromTier1Snapshot(
      "48453:TEST-AUSTIN-SF3",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        baseFacts: { situsCity: "Austin" },
        zoning: { district: "SF-3", jurisdictionKey: "austin-tx" },
        envelope: { status: "declined", declineReason: "atom_path_pending" } as {
          status: string;
        },
      },
      "48453",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(true);
    expect(result.envelopePresent).toBe(true);
    expect(result.notes).toEqual(
      expect.arrayContaining(["zoning", "setback", "envelope"]),
    );
    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      front: 25,
      side: 5,
      rear: 10,
      sourceCodeAtomRef: {
        role: "rule",
        entityType: "code-section",
      },
    });
    const envelope = result.atoms.find(
      (a) => a.entityType === "buildable-envelope",
    );
    expect(envelope).toMatchObject({
      entityType: "buildable-envelope",
      reasoningChain: { reasoningKind: "derived" },
      outcome: { kind: "provisional-front-edge" },
    });
  });

  it("emits setback-RULE for san-antonio-tx R-6", () => {
    const result = emitFromTier1Snapshot(
      "48029:TEST-SA-R6",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: { district: "R-6", jurisdictionKey: "san_antonio_tx" },
      },
      "48029",
    );
    expect(result.setbackPresent).toBe(true);
    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      sourceCodeAtomRef: { role: "rule" },
    });
  });

  it("honest-absence when jurisdiction has no setback table", () => {
    const result = emitFromTier1Snapshot(
      "48187:TEST-SEGUIN",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: { district: "R-1", jurisdictionKey: "seguin-tx" },
      },
      "48187",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(false);
    expect(result.notes).toContain("setback-table-missing:seguin-tx");
  });

  it("honest-absence when no jurisdictionKey on multi-city parcel", () => {
    const result = emitFromTier1Snapshot(
      "48453:TEST-NO-KEY",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: { district: "SF-3" },
      },
      "48453",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(false);
    expect(result.notes).toContain("setback-omitted-no-jurisdiction-key");
  });
});
