/**
 * OPS-16 A-004 / P-09 — staged geometry-true join.
 *
 * FAILING-FIRST fixture: a building straddles the A|B parcel line. Its bbox
 * overlaps parcel A (adjacent bleed) with true polygon overlap < 10%.
 * bbox-only attach (negative oracle) wrongly includes A.
 * geometry-true attach rejects A and attaches B as primary.
 */
import { describe, expect, it } from "vitest";

import { bboxContainsRing } from "../geo.js";
import {
  STAGED_FOOTPRINT_COUNTY_EMPTY,
  STAGED_FOOTPRINT_GEOM_UNREADY,
  STAGED_FOOTPRINT_TABLE_MISSING,
  StagedFootprintError,
  computeStagedJoinDiagnostics,
  describeStagedFootprintAbsence,
  envelopeOfRing,
  geometryTrueAttach,
  haltStagedFootprintOrThrow,
  joinStagedCandidatePairs,
  planCountyFromStagedGeometryTrueJoin,
  stagedEnvelopeCandidatesSql,
} from "../staged-footprint-join.js";
import type { ParcelRecord, RingLngLat } from "../types.js";

function rect(
  west: number,
  south: number,
  east: number,
  north: number,
): RingLngLat {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function bboxesIntersect(
  a: ReturnType<typeof envelopeOfRing>,
  b: ReturnType<typeof envelopeOfRing>,
): boolean {
  return (
    a.westLng <= b.eastLng &&
    a.eastLng >= b.westLng &&
    a.southLat <= b.northLat &&
    a.northLat >= b.southLat
  );
}

/**
 * Negative oracle ONLY. Axis-aligned envelope intersect — the 59.5% bbox
 * false-positive class A2 measured. Must not be used as a production attach.
 */
function bboxAttach(footprintRing: RingLngLat, parcelRing: RingLngLat): boolean {
  return bboxesIntersect(envelopeOfRing(footprintRing), envelopeOfRing(parcelRing));
}

/** Parcel A west of the shared line at lng = -97.329. */
const PARCEL_A = rect(-97.33, 30.1, -97.329, 30.101);
/** Parcel B east of the shared line. */
const PARCEL_B = rect(-97.329, 30.1, -97.328, 30.101);
/**
 * Building mostly in B; a thin sliver crosses into A (~7% of footprint width).
 * Bbox overlaps A; true overlap is below the 10% straddle floor.
 */
const BUILDING = rect(-97.32906, 30.1002, -97.3282, 30.1008);

const parcelA: ParcelRecord = {
  parcelNodeId: "48021:A",
  propId: "A",
  fips: "48021",
  ring: PARCEL_A,
};
const parcelB: ParcelRecord = {
  parcelNodeId: "48021:B",
  propId: "B",
  fips: "48021",
  ring: PARCEL_B,
};
const buildingFp = { footprintId: "straddle-bleed", ring: BUILDING };

describe("failing-first: bbox bleed vs geometry-true attach", () => {
  it("negative oracle: bboxAttach (and bboxContainsRing) wrongly include parcel A", () => {
    expect(bboxAttach(BUILDING, PARCEL_A)).toBe(true);
    expect(bboxContainsRing(envelopeOfRing(PARCEL_A), BUILDING)).toBe(true);
    expect(bboxAttach(BUILDING, PARCEL_B)).toBe(true);
  });

  it("geometry-true rejects A (<10% overlap) and attaches B as primary", () => {
    const a = geometryTrueAttach(BUILDING, PARCEL_A);
    const b = geometryTrueAttach(BUILDING, PARCEL_B);
    expect(a.overlapRatio).toBeLessThan(0.1);
    expect(a.attach).toBe(false);
    expect(b.overlapRatio).toBeGreaterThanOrEqual(0.5);
    expect(b.attach).toBe(true);
    expect(b.structureRole).toBe("primary");
  });

  it("joinStagedCandidatePairs does not attach the envelope-only pair to A", () => {
    const join = joinStagedCandidatePairs(
      [
        { parcel: parcelA, footprint: buildingFp },
        { parcel: parcelB, footprint: buildingFp },
      ],
      [parcelA, parcelB],
    );
    expect(join.byParcel.has("48021:A")).toBe(false);
    expect(join.footprintsJoined).toBe(1);
    expect(join.orphanRejected).toBe(0);
    expect(join.byParcel.get("48021:B")?.[0]?.mlFeatureId).toBe("straddle-bleed");
    expect(join.byParcel.get("48021:B")?.[0]?.footprintId).toBe("primary");
    expect(join.parcelsWithFootprint).toBe(1);
    expect(join.parcelsAbsentSentinel).toBe(1);
  });

  it("plan from staged join never emits county-coverage-absent for a bleed reject", () => {
    const pairs = [
      { parcel: parcelA, footprint: buildingFp },
      { parcel: parcelB, footprint: buildingFp },
    ];
    const join = joinStagedCandidatePairs(pairs, [parcelA, parcelB]);
    const plan = planCountyFromStagedGeometryTrueJoin(
      [
        { parcelKey: "A", ring: PARCEL_A },
        { parcelKey: "B", ring: PARCEL_B },
      ],
      join,
      { countyFips: "48021", featuresRead: 1 },
    );
    expect(plan.counts.countyCoverageAbsent).toBe(0);
    expect(plan.mlEmptyBbox).toBe(false);
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.absentPerParcel).toBe(1);
    const absentA = plan.planned.find(
      (p) => p.outcome === "absent-per-parcel" && p.parcelKey === "A",
    );
    expect(absentA).toBeDefined();
    // No diagnostics passed (back-compat call, matches every caller before
    // P-158): the old, undifferentiated string is preserved byte-for-byte.
    expect(absentA?.outcome === "absent-per-parcel" ? absentA.reason : null).toBe(
      "staged-geometry-true-join-below-10pct-overlap-threshold — no qualifying staged footprint for parcel",
    );
    expect(absentA?.outcome === "absent-per-parcel" ? absentA.joinOutcome : "defined").toBeUndefined();
  });
});

/**
 * P-158: the "below-10pct" string covered three distinct causes. This proves
 * all three are separately reachable and correctly evidenced, including the
 * one the old fixture above could never exercise (attached-to-neighbour --
 * loses to a higher-ratio neighbour despite itself clearing the 10% floor),
 * per the mission's "not-vacuous" requirement.
 */
describe("P-158: staged absence splits into three evidenced causes", () => {
  // C sits far away from every footprint in this fixture: zero envelope
  // candidates, the true acquisition-gap case.
  const parcelC: ParcelRecord = {
    parcelNodeId: "48021:C",
    propId: "C",
    fips: "48021",
    ring: rect(-90, 10, -89.999, 10.001),
  };

  // D and E share a boundary at lng = -97.339. A single footprint straddles
  // it, split roughly 38% into D / 62% into E -- BOTH clear the 10% floor
  // (unlike the A/B fixture above, where only one side did), so this is
  // genuinely "a footprint straddles two parcels", not a below-threshold
  // reject. joinStagedCandidatePairs gives the whole footprint to the
  // higher-ratio parcel (E); D is the neighbour-losing case.
  const parcelD: ParcelRecord = {
    parcelNodeId: "48021:D",
    propId: "D",
    fips: "48021",
    ring: rect(-97.34, 30.2, -97.339, 30.201),
  };
  const parcelE: ParcelRecord = {
    parcelNodeId: "48021:E",
    propId: "E",
    fips: "48021",
    ring: rect(-97.339, 30.2, -97.338, 30.201),
  };
  const straddleFp = {
    footprintId: "d-e-straddle",
    ring: rect(-97.3395, 30.2002, -97.3382, 30.2008),
  };

  const pairs = [
    { parcel: parcelA, footprint: buildingFp },
    { parcel: parcelB, footprint: buildingFp },
    { parcel: parcelD, footprint: straddleFp },
    { parcel: parcelE, footprint: straddleFp },
    // parcelC deliberately has no pair at all -- it never enters the
    // envelope prefilter in production, exactly as it never appears here.
  ];

  it("computeStagedJoinDiagnostics records every candidate ratio and each footprint's winner", () => {
    const diagnostics = computeStagedJoinDiagnostics(pairs);
    expect(diagnostics.candidateRatiosByParcel.has("48021:C")).toBe(false);
    expect(diagnostics.candidateRatiosByParcel.get("48021:A")?.[0]?.ratio).toBeLessThan(0.1);
    const dRatio = diagnostics.candidateRatiosByParcel.get("48021:D")?.[0]?.ratio ?? -1;
    const eRatio = diagnostics.candidateRatiosByParcel.get("48021:E")?.[0]?.ratio ?? -1;
    expect(dRatio).toBeGreaterThanOrEqual(0.1);
    expect(dRatio).toBeLessThan(0.5);
    expect(eRatio).toBeGreaterThan(dRatio);
    expect(diagnostics.footprintWinner.get("d-e-straddle")).toEqual({
      parcelNodeId: "48021:E",
      ratio: Math.round(eRatio * 10000) / 10000,
    });
  });

  it("branch 1: no-candidate-in-envelope for a parcel with zero candidates", () => {
    const diagnostics = computeStagedJoinDiagnostics(pairs);
    const described = describeStagedFootprintAbsence("48021:C", diagnostics);
    expect(described.joinOutcome).toEqual({ kind: "no-candidate-in-envelope" });
    expect(described.reason).toMatch(/no-candidate-in-envelope/);
  });

  it("branch 2: overlap-below-threshold for a real candidate under 10%", () => {
    const diagnostics = computeStagedJoinDiagnostics(pairs);
    const described = describeStagedFootprintAbsence("48021:A", diagnostics);
    expect(described.joinOutcome.kind).toBe("overlap-below-threshold");
    expect(described.reason).toMatch(/overlap-below-threshold/);
    if (described.joinOutcome.kind === "overlap-below-threshold") {
      expect(described.joinOutcome.bestOverlapRatio).toBeLessThan(0.1);
    }
  });

  it("branch 3 (not vacuous): attached-to-neighbour when a straddling footprint's other side wins", () => {
    const diagnostics = computeStagedJoinDiagnostics(pairs);
    const described = describeStagedFootprintAbsence("48021:D", diagnostics);
    expect(described.joinOutcome.kind).toBe("attached-to-neighbour");
    expect(described.reason).toMatch(/attached-to-neighbour/);
    expect(described.reason).toMatch(/\bE\b/);
    if (described.joinOutcome.kind === "attached-to-neighbour") {
      expect(described.joinOutcome.neighbourParcelKey).toBe("E");
      expect(described.joinOutcome.neighbourOverlapRatio).toBeGreaterThan(
        described.joinOutcome.ownOverlapRatio,
      );
      expect(described.joinOutcome.ownOverlapRatio).toBeGreaterThanOrEqual(0.1);
    }
  });

  it("end to end: planCountyFromStagedGeometryTrueJoin carries the split reason and joinOutcome per parcel", () => {
    const join = joinStagedCandidatePairs(pairs, [parcelA, parcelB, parcelC, parcelD, parcelE]);
    const diagnostics = computeStagedJoinDiagnostics(pairs);
    const plan = planCountyFromStagedGeometryTrueJoin(
      [
        { parcelKey: "A", ring: PARCEL_A },
        { parcelKey: "B", ring: PARCEL_B },
        { parcelKey: "C", ring: parcelC.ring },
        { parcelKey: "D", ring: parcelD.ring },
        { parcelKey: "E", ring: parcelE.ring },
      ],
      join,
      { countyFips: "48021", featuresRead: 2 },
      diagnostics,
    );
    const byKey = new Map(plan.planned.map((p) => [p.parcelKey, p]));
    const a = byKey.get("A");
    const c = byKey.get("C");
    const d = byKey.get("D");
    expect(a?.outcome === "absent-per-parcel" ? a.joinOutcome?.kind : null).toBe(
      "overlap-below-threshold",
    );
    expect(c?.outcome === "absent-per-parcel" ? c.joinOutcome?.kind : null).toBe(
      "no-candidate-in-envelope",
    );
    expect(d?.outcome === "absent-per-parcel" ? d.joinOutcome?.kind : null).toBe(
      "attached-to-neighbour",
    );
    // Three distinct causes must never collapse back onto one string.
    const reasons = new Set(
      ["A", "C", "D"].map((k) => {
        const entry = byKey.get(k);
        return entry?.outcome === "absent-per-parcel" ? entry.reason : null;
      }),
    );
    expect(reasons.size).toBe(3);
  });
});

describe("haltStagedFootprintOrThrow named fail-closed errors", () => {
  const base = {
    tablePresent: true,
    geomColumnPresent: true,
    gistIndexPresent: true,
    countyRowCount: 10,
    countyGeomPopulated: 10,
    countyFips: "48021",
  };

  it("throws STAGED_FOOTPRINT_TABLE_MISSING", () => {
    expect(() =>
      haltStagedFootprintOrThrow({ ...base, tablePresent: false }),
    ).toThrow(StagedFootprintError);
    try {
      haltStagedFootprintOrThrow({ ...base, tablePresent: false });
    } catch (err) {
      expect(err).toBeInstanceOf(StagedFootprintError);
      expect((err as StagedFootprintError).code).toBe(
        STAGED_FOOTPRINT_TABLE_MISSING,
      );
      expect(JSON.stringify(err)).toContain(STAGED_FOOTPRINT_TABLE_MISSING);
    }
  });

  it("throws STAGED_FOOTPRINT_COUNTY_EMPTY (HALT, not absence atoms)", () => {
    try {
      haltStagedFootprintOrThrow({
        ...base,
        countyRowCount: 0,
        countyGeomPopulated: 0,
      });
      expect.unreachable("empty county must halt");
    } catch (err) {
      expect((err as StagedFootprintError).code).toBe(
        STAGED_FOOTPRINT_COUNTY_EMPTY,
      );
      expect((err as StagedFootprintError).message).toMatch(/HALT/);
    }
  });

  it("throws STAGED_FOOTPRINT_GEOM_UNREADY when GiST or geom is incomplete", () => {
    try {
      haltStagedFootprintOrThrow({ ...base, gistIndexPresent: false });
      expect.unreachable("missing gist must halt");
    } catch (err) {
      expect((err as StagedFootprintError).code).toBe(
        STAGED_FOOTPRINT_GEOM_UNREADY,
      );
    }
    try {
      haltStagedFootprintOrThrow({ ...base, countyGeomPopulated: 9 });
      expect.unreachable("partial geom must halt");
    } catch (err) {
      expect((err as StagedFootprintError).code).toBe(
        STAGED_FOOTPRINT_GEOM_UNREADY,
      );
    }
  });
});

describe("stagedEnvelopeCandidatesSql", () => {
  it("prefilters with ST_Intersects + ST_MakeEnvelope and does not attach", () => {
    const sql = stagedEnvelopeCandidatesSql();
    expect(sql).toMatch(/ST_Intersects/);
    expect(sql).toMatch(/ST_MakeEnvelope/);
    expect(sql).toMatch(/fp\.geom/);
    expect(sql).not.toMatch(/INSERT/i);
    expect(sql).not.toMatch(/overlap/i);
  });
});
