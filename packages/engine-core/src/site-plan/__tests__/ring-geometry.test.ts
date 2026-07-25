import { describe, expect, it } from "vitest";

import {
  assignSetbackRoles,
  computeSetbackOffset,
  dedupeClosingVertex,
  ringSegments,
} from "../ring-geometry.js";

const FEET_TO_METERS = 0.3048;
// Representative parcel shape (48029:105129 is ~7756 sqft SF; a 70x110 ft
// rectangle is 7700 sqft, close enough to exercise real setback values
// 10/5/20 ft without depending on live TxGIO geometry).
const WIDTH_FT = 70;
const DEPTH_FT = 110;
const W = WIDTH_FT * FEET_TO_METERS;
const D = DEPTH_FT * FEET_TO_METERS;
const rect = [
  { x: 0, y: 0 },
  { x: W, y: 0 },
  { x: W, y: D },
  { x: 0, y: D },
];
const setback = { front: 10, side: 5, rear: 20 }; // ft, real 48029:105129 values

describe("dedupeClosingVertex", () => {
  it("drops a repeated GeoJSON closing point", () => {
    const closed = [...rect, rect[0]!];
    expect(dedupeClosingVertex(closed)).toEqual(rect);
  });
  it("leaves an already-open ring untouched", () => {
    expect(dedupeClosingVertex(rect)).toEqual(rect);
  });
});

describe("ringSegments", () => {
  it("wraps around to close the ring", () => {
    const segments = ringSegments(rect);
    expect(segments).toHaveLength(4);
    expect(segments[3]!.b).toEqual(rect[0]);
    expect(segments[0]!.lengthMeters).toBeCloseTo(W, 6);
    expect(segments[1]!.lengthMeters).toBeCloseTo(D, 6);
  });
});

describe("assignSetbackRoles", () => {
  it("uses an explicit front-edge hint when supplied", () => {
    const { basis, assignments } = assignSetbackRoles(rect, setback, 1);
    expect(basis).toBe("front-edge-hint");
    expect(assignments[1]).toEqual({ role: "front", distanceFt: 10 });
    expect(assignments[3]).toEqual({ role: "rear", distanceFt: 20 });
    expect(assignments[0]).toEqual({ role: "side", distanceFt: 5 });
    expect(assignments[2]).toEqual({ role: "side", distanceFt: 5 });
  });

  it("without a hint, picks the shorter south-most edge pair as front/rear (disclosed heuristic)", () => {
    const { basis, assignments } = assignSetbackRoles(rect, setback);
    expect(basis).toBe("geometric-heuristic:shortest-edge-pair-south-most");
    // seg0 (y=0, width W, the shorter edge, south-most) -> front
    expect(assignments[0]).toEqual({ role: "front", distanceFt: 10 });
    // seg2 (y=D, width W) -> rear
    expect(assignments[2]).toEqual({ role: "rear", distanceFt: 20 });
    // seg1/seg3 (length D, the longer pair) -> side
    expect(assignments[1]).toEqual({ role: "side", distanceFt: 5 });
    expect(assignments[3]).toEqual({ role: "side", distanceFt: 5 });
  });

  it("falls back to a conservative uniform-minimum for irregular (non-4-edge) rings", () => {
    const pentagon = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 6 }, { x: 5, y: 10 }, { x: -2, y: 4 },
    ];
    const { basis, assignments } = assignSetbackRoles(pentagon, setback);
    expect(basis).toBe("unresolved-uniform-min");
    for (const a of assignments) {
      expect(a).toEqual({ role: "unassigned", distanceFt: 5 }); // min(10,5,20)
    }
  });
});

describe("computeSetbackOffset", () => {
  it("produces a smaller, correctly-inset polygon for the real 48029:105129 setback values", () => {
    const result = computeSetbackOffset(rect, setback);
    expect(result.offsetDegenerate).toBe(false);
    expect(result.offsetRing).not.toBeNull();
    const ring = result.offsetRing!;
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    // Side setback (5 ft) insets left/right edges; front/rear (10/20 ft) inset top/bottom.
    expect(Math.min(...xs)).toBeCloseTo(5 * FEET_TO_METERS, 3);
    expect(Math.max(...xs)).toBeCloseTo(W - 5 * FEET_TO_METERS, 3);
    expect(Math.min(...ys)).toBeCloseTo(10 * FEET_TO_METERS, 3); // front
    expect(Math.max(...ys)).toBeCloseTo(D - 20 * FEET_TO_METERS, 3); // rear
  });

  it("flags degenerate (setback-consumes-lot) rather than drawing a self-intersecting polygon", () => {
    const tiny = [
      { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }, { x: 0, y: 5 },
    ]; // ~10x16 ft lot, setbacks 10/5/20 ft consume it entirely
    const result = computeSetbackOffset(tiny, setback);
    expect(result.offsetDegenerate).toBe(true);
    expect(result.offsetRing).toBeNull();
    expect(result.offsetDegenerateReason).toMatch(/setback-consumes-lot/);
  });
});
