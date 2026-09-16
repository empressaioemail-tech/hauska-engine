/**
 * P-262 items 1, 2 and 5 — the ring scrub, the logical-edge grouping, and the
 * named decline, tested against their OWN exported tolerances.
 *
 * Every ring here is built in metres about a fixed origin and converted to
 * lng/lat through the same frame the production projection uses, so a test can
 * say "a vertex 0.30 m from its neighbour" and mean it.
 *
 * THE MEASURED BAND (why the default tolerances are what they are; all four
 * real fixture rings, turn at every vertex, sorted):
 *
 *   48209:97658 (Hays, 9 edges)   0.01 0.01 0.02 0.02 0.03 | 89.80 89.93 90.01 90.21
 *   48453:427599 (Travis, 4)      85.98 89.36 89.63 95.02
 *   324-knockout-rose (13)        1.31 9.15 9.16 9.16 9.19 9.19 9.20 9.20 11.17 | 70.16 88.76 ...
 *   312-knockout-rose (7)         0.99 16.59 27.85 | 82.10 88.75 89.21 89.67
 *
 * So across the fixtures the largest turn that belongs to a digitised line is
 * 0.03 degrees, the largest turn that belongs to a frontage CURVE is 11.17
 * degrees, and the shallowest real corner is 70.16 degrees. The default 10
 * degrees sits between the curve and the corner on purpose: it keeps a curve
 * out of the line groups (fusing 9.15-11.17 degree turns would report a curve as
 * straight) and the curve is then handled as a frontage RUN by the front rule
 * (edgeLabeling.ts, P262_CURVED_FRONTAGE_MAX_TURN_DEG = 45, whose own margin is
 * 32.1 degrees inside the run versus 57.2 at its nearest end).
 */
import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../edgeLabeling.js";
import { openRing, projectRing, type Ring } from "../geometry.js";
import {
  P262_COLLINEAR_VERTEX_TOL_DEG,
  P262_DUPLICATE_VERTEX_TOL_M,
  P262_LOGICAL_EDGE_MAX_TURN_DEG,
  groupRingChordsIntoLogicalEdges,
  scrubRingForLabeling,
  turnAtVertexDeg,
  validateParcelRing,
} from "../ring-logical-edges.js";
import {
  PARCEL_48209_97658_SAN_MARCOS,
  PARCEL_48453_427599_PFLUGERVILLE,
  ROADS_AROUND_48209_97658,
} from "../fixtures/p262Parcels.js";
import {
  PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
  ROADS_AROUND_KNOCKOUT_ROSE,
  SITUS_324_KNOCKOUT_ROSE,
} from "../fixtures/p262CurvedFrontage.js";

const EARTH_RADIUS_M = 6_378_137;
const LNG0 = -97.5;
const LAT0 = 30;

/** Metres about (LNG0, LAT0) -> a closed WGS84 ring. */
function ringFromMetres(points: ReadonlyArray<readonly [number, number]>): Ring {
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const toLngLat = ([x, y]: readonly [number, number]): [number, number] => [
    LNG0 + x / mPerDegLng,
    LAT0 + y / mPerDegLat,
  ];
  return [...points.map(toLngLat), toLngLat(points[0]!)];
}

/** A 100 m square, optionally with an extra vertex spliced in after `after`. */
function squareWithVertex(
  extra: readonly [number, number] | null,
  after = 0,
): ReadonlyArray<readonly [number, number]> {
  const square: Array<readonly [number, number]> = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  if (!extra) return square;
  const out = square.slice();
  out.splice(after + 1, 0, extra);
  return out;
}

describe("P-262 item 5 — a ring that cannot be labelled says WHY", () => {
  it("names each way a ring can fail validation", () => {
    expect(validateParcelRing(ringFromMetres([[0, 0], [100, 0], [100, 100], [0, 100]]))).toBeNull();
    expect(validateParcelRing([[LNG0, LAT0], [LNG0 + 0.001, LAT0]])).toBe("ring-too-few-vertices");
    expect(
      validateParcelRing([
        [LNG0, LAT0],
        [Number.NaN, LAT0],
        [LNG0 + 0.001, LAT0 + 0.001],
        [LNG0, LAT0],
      ]),
    ).toBe("ring-non-finite-coordinate");
    // Three collinear points enclose no area.
    expect(
      validateParcelRing([
        [LNG0, LAT0],
        [LNG0 + 1e-5, LAT0],
        [LNG0 + 2e-5, LAT0],
        [LNG0, LAT0],
      ]),
    ).toBe("ring-zero-area");
    // A ring that leaves the square and comes back across its own bottom edge
    // (two vertical spikes at x=150 and x=50 cross y=0): self-intersecting, with
    // area of its own, so it is not turned away by the zero-area check first.
    expect(
      validateParcelRing(
        ringFromMetres([
          [0, 0],
          [300, 0],
          [300, 100],
          [150, 100],
          [150, -100],
          [50, -100],
          [50, 100],
          [0, 100],
        ]),
      ),
    ).toBe("ring-self-intersecting");
  });

  it("a ring the scrub empties reaches a NAMED decline, never an empty label set", () => {
    // Every vertex within P262_DUPLICATE_VERTEX_TOL_M of the next: 0.2 m apart.
    const sliver: Ring = ringFromMetres([
      [0, 0],
      [0.2, 0],
      [0.2, 0.2],
      [0, 0.2],
    ]);
    const scrub = scrubRingForLabeling(sliver);
    expect(scrub.ok).toBe(false);
    expect(scrub.reason).toBe("ring-zero-area");

    const res = labelEdgesFromRoads({
      parcelRing: sliver,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: null,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.decline).toBe("ring-validation-failed");

    const nonFinite = labelEdgesFromRoads({
      parcelRing: [
        [LNG0, LAT0],
        [Number.NaN, LAT0],
        [LNG0 + 0.001, LAT0 + 0.001],
        [LNG0, LAT0],
      ] as Ring,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: null,
    });
    expect(nonFinite).toEqual({ ok: false, decline: "ring-validation-failed" });
  });

  it("declines by name when there is no road to label against", () => {
    expect(
      labelEdgesFromRoads({
        parcelRing: ringFromMetres(squareWithVertex(null)),
        roads: [],
        situsAddress: null,
      }),
    ).toEqual({ ok: false, decline: "no-roads-available" });
  });
});

describe("P-262 item 1 — the scrub, at its own stated tolerances", () => {
  it("collapses a vertex inside the duplicate tolerance and keeps one outside it", () => {
    const inside = scrubRingForLabeling(ringFromMetres(squareWithVertex([99.7, 0])));
    expect(inside.ok).toBe(true);
    expect(inside.duplicateVerticesRemoved).toBe(1);
    expect(inside.keptOriginalVertexIndices).toHaveLength(4);

    const outside = scrubRingForLabeling(ringFromMetres(squareWithVertex([99.1, 0.6])));
    expect(outside.ok).toBe(true);
    expect(outside.duplicateVerticesRemoved).toBe(0);
    expect(outside.keptOriginalVertexIndices).toHaveLength(5);
    expect(P262_DUPLICATE_VERTEX_TOL_M).toBe(0.5);
  });

  it("collapses a near-collinear vertex and keeps one the tolerance cannot excuse", () => {
    // A vertex 20 m along the bottom edge, lifted 0.14 m: 0.40 degrees.
    const nearCollinear = scrubRingForLabeling(ringFromMetres(squareWithVertex([20, 0.14])));
    expect(nearCollinear.ok).toBe(true);
    expect(nearCollinear.collinearVerticesRemoved).toBe(1);

    // The same vertex lifted 0.56 m: 1.60 degrees — a real (if tiny) bend.
    const realBend = scrubRingForLabeling(ringFromMetres(squareWithVertex([20, 0.56])));
    expect(realBend.ok).toBe(true);
    expect(realBend.collinearVerticesRemoved).toBe(0);
    expect(realBend.keptOriginalVertexIndices).toHaveLength(5);
    expect(P262_COLLINEAR_VERTEX_TOL_DEG).toBe(1.0);
  });

  it("maps every surviving vertex back into the input ring's own vertex order", () => {
    // The same ring twice: counter-clockwise, and CLOCKWISE (which projectRing
    // reverses to CCW), so a scrub that assumed identity would mis-attribute
    // every kept index in one of the two.
    const ccw = ringFromMetres(squareWithVertex([99.6, 0]));
    const cw: Ring = [ccw[0]!, ...ccw.slice(1, -1).reverse(), ccw[0]!];
    for (const ring of [ccw, cw]) {
      const scrub = scrubRingForLabeling(ring);
      expect(scrub.ok).toBe(true);
      expect(scrub.duplicateVerticesRemoved).toBe(1);
      const openInput = openRing(ring);
      expect(scrub.keptOriginalVertexIndices).toHaveLength(openInput.length - 1);
      for (const [k, index] of scrub.keptOriginalVertexIndices.entries()) {
        const source = openInput[index]!;
        const kept = scrub.vertices[k]!;
        expect(Math.abs(source[0] - kept[0])).toBeLessThan(1e-9);
        expect(Math.abs(source[1] - kept[1])).toBeLessThan(1e-9);
      }
    }
  });
});

describe("P-262 item 2 — chords of one lot line are one edge", () => {
  it("fuses a collinear run and splits at a real corner", () => {
    const proj = projectRing(ringFromMetres(squareWithVertex([50, 0])))!;
    const groups = groupRingChordsIntoLogicalEdges(proj);
    expect(groups.map((g) => g.chordIndices)).toEqual([[0, 1], [2], [3], [4]]);
    // Every chord exactly once, in ring order.
    expect(groups.flatMap((g) => g.chordIndices)).toEqual([0, 1, 2, 3, 4]);
    expect(groups[0]!.lengthM).toBeCloseTo(100, 3);
  });

  it("keeps a real curve out of the line groups", () => {
    const proj = projectRing(PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS)!;
    const groups = groupRingChordsIntoLogicalEdges(proj);
    // The frontage curve's turns measure 9.15-11.17 degrees: the 9.15/9.2 degree
    // joins fuse, the 11.17 degree join splits, and every corner (70.16+) splits.
    expect(groups.map((g) => g.chordIndices.length)).toEqual([1, 1, 1, 1, 9]);
  });

  it("the grouping is stable across the whole artifact band on the dispatch fixtures", () => {
    const sweep = [0.05, 0.5, 1, P262_COLLINEAR_VERTEX_TOL_DEG, 2, 4, 5, 8, 10, 12, 20, 45, 60, 69.9];
    for (const ring of [PARCEL_48209_97658_SAN_MARCOS, PARCEL_48453_427599_PFLUGERVILLE]) {
      const proj = projectRing(ring)!;
      const reference = JSON.stringify(groupRingChordsIntoLogicalEdges(proj).map((g) => g.chordIndices));
      for (const maxTurnDeg of sweep) {
        const groups = groupRingChordsIntoLogicalEdges(proj, { maxTurnDeg });
        expect(
          JSON.stringify(groups.map((g) => g.chordIndices)),
          `${maxTurnDeg} degrees changed the grouping of a ring whose turns are 0.03 or 85.98+`,
        ).toBe(reference);
      }
    }
    // The band that makes that true, measured on the rings themselves.
    const turns48209 = projectRing(PARCEL_48209_97658_SAN_MARCOS)!.points
      .map((_, v) => turnAtVertexDeg(projectRing(PARCEL_48209_97658_SAN_MARCOS)!, v))
      .sort((a, b) => a - b);
    expect(turns48209.filter((t) => t <= P262_LOGICAL_EDGE_MAX_TURN_DEG).at(-1)).toBeCloseTo(0.03, 2);
    expect(turns48209.find((t) => t > P262_LOGICAL_EDGE_MAX_TURN_DEG)).toBeGreaterThanOrEqual(89.8);
  });

  it("raising the threshold past the curve is NOT how a curved frontage is handled", () => {
    // At 45 degrees the frontage curve would fuse into ONE line (the turns are
    // 9.15-11.17): that is why the front rule grows a frontage RUN over separate
    // lines instead, and why the grouping threshold stays at 10.
    const proj = projectRing(PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS)!;
    const atDefault = groupRingChordsIntoLogicalEdges(proj);
    const at45 = groupRingChordsIntoLogicalEdges(proj, { maxTurnDeg: 45 });
    const largest = (groups: ReturnType<typeof groupRingChordsIntoLogicalEdges>) =>
      Math.max(...groups.map((g) => g.chordIndices.length));
    expect(largest(atDefault)).toBe(9);
    expect(largest(at45)).toBeGreaterThan(9);
  });
});

describe("P-262 item 6 — the frontage run, measured on the curved fixture", () => {
  it("labels the whole frontage curve front and leaves the back of the lot alone", () => {
    const res = labelEdgesFromRoads({
      parcelRing: PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
      roads: ROADS_AROUND_KNOCKOUT_ROSE,
      situsAddress: SITUS_324_KNOCKOUT_ROSE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fronts = res.edgeLabels.filter((e) => e.label === "front").map((e) => e.index);
    // The curve (0-7) plus the nearest chord (8) plus the curve's far chord (12);
    // 9, 10 and 11 face away from the street and keep their own roles.
    expect(fronts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 12]);
    expect(res.edgeLabels.filter((e) => e.label === "front").every((e) => e.frontBasis === "situs-street-match")).toBe(true);
    expect(res.edgeLabels[9]!.label).toBe("side");
    expect(res.edgeLabels[10]!.label).toBe("rear");
    expect(res.edgeLabels[11]!.label).toBe("side");
  });
});
