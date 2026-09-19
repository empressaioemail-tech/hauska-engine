import { describe, expect, it } from "vitest";

import { gradeFloodAdjudication, normalizeZone } from "../grade.js";
import {
  ALL_LEGS,
  CODE_LEGS,
  DECLARED_BANDS,
  type FloodAdjudicationCase,
} from "../types.js";

const RING = {
  type: "Polygon",
  coordinates: [
    [
      [-97.4, 30.1],
      [-97.3, 30.1],
      [-97.3, 30.2],
      [-97.4, 30.2],
      [-97.4, 30.1],
    ],
  ],
};

function healthy(
  over: Partial<FloodAdjudicationCase> = {},
): FloodAdjudicationCase {
  return {
    parcelNodeId: "48021:1",
    atomSamplePoint: [-97.35, 30.15],
    atomContainment: "contained",
    samplePointUsed: [-97.35, 30.15],
    samplePointSource: "atom-stamp",
    atomFloodZone: "AE",
    atomIsAbsence: false,
    parcelGeometry: RING,
    postgisContains: true,
    nfhlZoneAtSamplePoint: "AE",
    nfhlEdition: "NFHL_48_20260101",
    ...over,
  };
}

describe("the standing check must be observed FAILING on each leg", () => {
  it("FAILS the stamp-present leg on an atom written before the gate existed", () => {
    const r = gradeFloodAdjudication(
      [
        healthy({
          atomSamplePoint: null,
          atomContainment: null,
          samplePointSource: "re-derived",
        }),
      ],
      ALL_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.legs.stampPresent.failed).toBe(1);
    expect(r.breaches[0]).toMatch(/unstamped determinations 1 of 1/);
  });

  it("FAILS the stamp-emittable leg when a not-contained determination reaches the store", () => {
    const r = gradeFloodAdjudication(
      [healthy({ atomContainment: "not-contained" })],
      ALL_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.legs.stampEmittable.failed).toBe(1);
    expect(r.findings.some((f) => f.leg === "stamp-emittable")).toBe(true);
  });

  it("FAILS the containment-divergence leg when the two implementations disagree", () => {
    // The point is genuinely inside the ring, so the JS side says contained.
    // PostGIS is told it is outside. One of the two is wrong and the check does
    // not need to know which — a divergence is the finding.
    const r = gradeFloodAdjudication(
      [healthy({ postgisContains: false })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.legs.containmentDivergence.failed).toBe(1);
    expect(r.findings[0]!.detail).toMatch(/JS ray cast says true/);
  });

  it("FAILS the divergence leg when PostGIS has a ring and the jsonb does not", () => {
    const r = gradeFloodAdjudication(
      [healthy({ parcelGeometry: null, postgisContains: true })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.findings[0]!.detail).toMatch(/no testable ring/);
  });

  it("FAILS the zone leg when the atom disagrees with NFHL at its OWN stamped point", () => {
    const r = gradeFloodAdjudication(
      [healthy({ atomFloodZone: "X", nfhlZoneAtSamplePoint: "AE" })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.legs.zoneAdjudication.failed).toBe(1);
    expect(r.findings[0]!.detail).toMatch(/NFHL NFHL_48_20260101 says AE/);
  });
});

describe("a stand-in point is reported, never banded", () => {
  it("routes a re-derived-point disagreement out of the banded leg and still surfaces it", () => {
    const r = gradeFloodAdjudication(
      [
        healthy({
          atomSamplePoint: null,
          atomContainment: null,
          samplePointSource: "re-derived",
          atomFloodZone: "X",
          nfhlZoneAtSamplePoint: "AE",
        }),
      ],
      CODE_LEGS,
    );
    // Not a breach: a corpus baked before the stamp existed would make this
    // permanently red, and a gate nobody can get to green gets ignored.
    expect(r.pass).toBe(true);
    expect(r.legs.zoneAdjudication.checked).toBe(0);
    expect(r.zoneAdjudicationOnStandInPoint.failed).toBe(1);
    expect(r.findings[0]!.detail).toMatch(/RE-DERIVED stand-in point/);
  });

  it("bands the same disagreement once the atom carries its own point", () => {
    const r = gradeFloodAdjudication(
      [healthy({ atomFloodZone: "X", nfhlZoneAtSamplePoint: "AE" })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(false);
    expect(r.zoneAdjudicationOnStandInPoint.checked).toBe(0);
  });
});

describe("scope selection cannot silently narrow a PASS", () => {
  it("echoes the scope and its reason into the report", () => {
    const r = gradeFloodAdjudication([healthy()], CODE_LEGS);
    expect(r.scope.legs).toEqual([
      "containment-divergence",
      "zone-adjudication",
    ]);
    expect(r.scope.reason).toMatch(/properties of the PREDICATE/);
  });

  it("does not grade a disabled leg at all, rather than grading it as passing", () => {
    const broken = healthy({ atomContainment: "not-contained" });
    expect(gradeFloodAdjudication([broken], ALL_LEGS).pass).toBe(false);
    const narrowed = gradeFloodAdjudication([broken], CODE_LEGS);
    expect(narrowed.pass).toBe(true);
    expect(narrowed.legs.stampEmittable.checked).toBe(0);
    expect(narrowed.legs.stampPresent.checked).toBe(0);
  });
});

describe("the standing check passes only a genuinely clean population", () => {
  it("passes a healthy case on every leg", () => {
    const r = gradeFloodAdjudication([healthy()], ALL_LEGS);
    expect(r.pass).toBe(true);
    expect(r.breaches).toEqual([]);
    expect(r.legs.zoneAdjudication.checked).toBe(1);
    expect(r.legs.containmentDivergence.checked).toBe(1);
  });

  it("compares zones case-insensitively and never by whitespace", () => {
    expect(normalizeZone("  ae ")).toBe("AE");
    expect(normalizeZone("")).toBeNull();
    const r = gradeFloodAdjudication(
      [healthy({ atomFloodZone: " ae ", nfhlZoneAtSamplePoint: "AE" })],
      ALL_LEGS,
    );
    expect(r.pass).toBe(true);
  });

  it("declares every band at zero, so nothing was tuned to fit a result", () => {
    expect(DECLARED_BANDS).toEqual({
      maxUnstamped: 0,
      maxNotContainedStamped: 0,
      maxContainmentDivergences: 0,
      maxZoneDisagreements: 0,
    });
  });
});

describe("unmeasurable never becomes a pass and never becomes a fail", () => {
  it("does not grade the divergence leg for a parcel with no PostGIS geom", () => {
    const r = gradeFloodAdjudication(
      [healthy({ postgisContains: null })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(true);
    expect(r.legs.containmentDivergence.checked).toBe(0);
    expect(r.legs.containmentDivergence.unmeasurable).toBe(1);
  });

  it("does not grade the zone leg when the point is in no loaded NFHL polygon", () => {
    const r = gradeFloodAdjudication(
      [healthy({ nfhlZoneAtSamplePoint: null })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(true);
    expect(r.legs.zoneAdjudication.checked).toBe(0);
    expect(r.legs.zoneAdjudication.unmeasurable).toBe(1);
  });

  it("does not grade the zone leg for an honest absence record", () => {
    const r = gradeFloodAdjudication(
      [healthy({ atomIsAbsence: true, atomFloodZone: null })],
      CODE_LEGS,
    );
    expect(r.pass).toBe(true);
    expect(r.legs.zoneAdjudication.unmeasurable).toBe(1);
  });

  it("counts a testable ring independently of whether a point exists to test it", () => {
    const r = gradeFloodAdjudication(
      [
        healthy({
          atomSamplePoint: null,
          samplePointUsed: null,
          samplePointSource: "none",
        }),
      ],
      CODE_LEGS,
    );
    // The old shape reported withParcelRing=0 here because it inferred the ring
    // from a containment verdict that had already short-circuited on the null
    // point. That produced 2,000-of-2,000 phantom divergences on the first live
    // run of this instrument.
    expect(r.denominators.withTestableRing).toBe(1);
    expect(r.legs.containmentDivergence.unmeasurable).toBe(1);
    expect(r.legs.containmentDivergence.failed).toBe(0);
  });

  it("keeps checked, failed and unmeasurable from being folded together", () => {
    const r = gradeFloodAdjudication(
      [
        healthy(),
        healthy({ parcelNodeId: "48021:2", postgisContains: null }),
        healthy({ parcelNodeId: "48021:3", nfhlZoneAtSamplePoint: null }),
      ],
      CODE_LEGS,
    );
    expect(r.denominators.casesGraded).toBe(3);
    expect(
      r.legs.containmentDivergence.checked +
        r.legs.containmentDivergence.unmeasurable,
    ).toBe(3);
    expect(
      r.legs.zoneAdjudication.checked + r.legs.zoneAdjudication.unmeasurable,
    ).toBe(3);
    expect(
      r.containmentStates.contained +
        r.containmentStates.notContained +
        r.containmentStates.unmeasurable,
    ).toBe(3);
  });
});
