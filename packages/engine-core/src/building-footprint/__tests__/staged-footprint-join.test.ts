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
    const join = joinStagedCandidatePairs(
      [
        { parcel: parcelA, footprint: buildingFp },
        { parcel: parcelB, footprint: buildingFp },
      ],
      [parcelA, parcelB],
    );
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
