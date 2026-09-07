import { describe, expect, it } from "vitest";

import { geometryOuterRing } from "../geo.js";

const SMALL_SLIVER = [
  [-97.5, 30.0],
  [-97.499, 30.0],
  [-97.499, 30.001],
  [-97.5, 30.001],
  [-97.5, 30.0],
];

const BIG_TRACT = [
  [-97.4, 30.0],
  [-97.3, 30.0],
  [-97.3, 30.1],
  [-97.4, 30.1],
  [-97.4, 30.0],
];

describe("geometryOuterRing", () => {
  it("extracts a plain Polygon's outer ring", () => {
    const ring = geometryOuterRing({ type: "Polygon", coordinates: [BIG_TRACT] });
    expect(ring).toEqual(BIG_TRACT);
  });

  it("picks the largest part of a MultiPolygon when the sliver is listed first", () => {
    const ring = geometryOuterRing({
      type: "MultiPolygon",
      coordinates: [[SMALL_SLIVER], [BIG_TRACT]],
    });
    expect(ring).toEqual(BIG_TRACT);
  });

  it("picks the largest part of a MultiPolygon when the sliver is listed last", () => {
    const ring = geometryOuterRing({
      type: "MultiPolygon",
      coordinates: [[BIG_TRACT], [SMALL_SLIVER]],
    });
    expect(ring).toEqual(BIG_TRACT);
  });

  it("returns null for unrecognized geometry types", () => {
    expect(geometryOuterRing({ type: "Point", coordinates: [-97.4, 30.0] })).toBeNull();
    expect(geometryOuterRing(null)).toBeNull();
    expect(geometryOuterRing(undefined)).toBeNull();
  });

  it("skips malformed parts of a MultiPolygon and still finds the real tract", () => {
    const ring = geometryOuterRing({
      type: "MultiPolygon",
      coordinates: [null, [BIG_TRACT], "not-a-ring"],
    });
    expect(ring).toEqual(BIG_TRACT);
  });
});
