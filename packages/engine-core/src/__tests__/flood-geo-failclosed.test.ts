/**
 * W-3 / W-4 / W-5 proof-by-violation for flood-hazard-fact/geo.ts.
 *
 * Snapshot this file was written against: hauska-engine
 * d3f37949003fae5a99a82b62956352b7dcaa1022.
 *
 * Defect copies below are the OLD predicates, kept so a clean pass cannot
 * be confused with a check that cannot fail.
 */
import { describe, expect, it } from "vitest";

import {
  UnrecognisedSfhaFlagError,
  findZoneAtPoint,
  geometryCentroid,
  isSfhaFlag,
  parseSfhaTf,
  pickPreferredFloodZone,
  type FloodZoneFeature,
  type LngLat,
} from "../flood-hazard-fact/geo.js";
import {
  buildFloodZoneGrid,
  findZoneAtPointWithGrid,
} from "../flood-hazard-fact/flood-zone-grid.js";
import { geometryCentroid as wellFactGeometryCentroid } from "../well-fact/geo.js";

/** W-5 defect: anything other than T/t/true reads FALSE. */
function isSfhaFlagDefect(sfhaTf: string | null | undefined): boolean {
  return sfhaTf === "T" || sfhaTf === "t" || sfhaTf === "true";
}

function findZoneAtPointDefect(
  lng: number,
  lat: number,
  zones: ReadonlyArray<FloodZoneFeature>,
): FloodZoneFeature | null {
  const candidates: FloodZoneFeature[] = [];
  for (const z of zones) {
    if (
      lng < z.westLng ||
      lng > z.eastLng ||
      lat < z.southLat ||
      lat > z.northLat
    ) {
      continue;
    }
    candidates.push(z);
  }
  if (candidates.length === 0) return null;
  const sfha = candidates.find((c) => isSfhaFlagDefect(c.sfhaTf));
  return sfha ?? candidates[0]!;
}

/** W-4 defect: flood MultiPolygon answered for part one of N. */
function floodMultiPolygonPartOneDefect(geometry: unknown): LngLat | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0];
    if (Array.isArray(first) && Array.isArray(first[0])) {
      const ring = first[0] as Array<[number, number]>;
      const n =
        ring.length > 1 &&
        ring[0]![0] === ring[ring.length - 1]![0] &&
        ring[0]![1] === ring[ring.length - 1]![1]
          ? ring.length - 1
          : ring.length;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += ring[i]![0];
        sy += ring[i]![1];
      }
      return [sx / n, sy / n];
    }
  }
  return null;
}

function squareZone(
  id: string,
  west: number,
  south: number,
  east: number,
  north: number,
  sfhaTf: string | null,
  fldZone = "AE",
): FloodZoneFeature {
  return {
    zoneRowId: id,
    fldZone,
    zoneSubty: null,
    sfhaTf,
    staticBfe: null,
    westLng: west,
    southLat: south,
    eastLng: east,
    northLat: north,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

const CLOSED_SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
};

const TWO_PART_MULTIPOLYGON = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
    [
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
        [10, 10],
      ],
    ],
  ],
};

describe("W-5 parseSfhaTf fails closed on unrecognised encodings", () => {
  it("accepts the FEMA domain T and F", () => {
    expect(parseSfhaTf("T")).toBe("sfha");
    expect(parseSfhaTf("F")).toBe("not-sfha");
    expect(isSfhaFlag("T")).toBe(true);
    expect(isSfhaFlag("F")).toBe(false);
  });

  it("throws on Y, null, and 1, while the old predicate returns false", () => {
    for (const bad of ["Y", null, "1"] as const) {
      expect(isSfhaFlagDefect(bad), `defect false for ${String(bad)}`).toBe(
        false,
      );
      expect(() => parseSfhaTf(bad)).toThrow(UnrecognisedSfhaFlagError);
      expect(() => isSfhaFlag(bad)).toThrow(UnrecognisedSfhaFlagError);
      try {
        parseSfhaTf(bad);
        throw new Error(`parseSfhaTf(${String(bad)}) did not throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(UnrecognisedSfhaFlagError);
        expect((err as UnrecognisedSfhaFlagError).sfhaTf).toBe(bad);
        expect((err as UnrecognisedSfhaFlagError).name).toBe(
          "UnrecognisedSfhaFlagError",
        );
      }
    }
  });

  it("throws on empty string, t, true, TRUE (encodings the old predicate either swallowed or treated as SFHA)", () => {
    expect(isSfhaFlagDefect("")).toBe(false);
    expect(isSfhaFlagDefect("TRUE")).toBe(false);
    expect(isSfhaFlagDefect("t")).toBe(true);
    expect(isSfhaFlagDefect("true")).toBe(true);
    for (const bad of ["", "t", "true", "TRUE"] as const) {
      expect(() => parseSfhaTf(bad)).toThrow(UnrecognisedSfhaFlagError);
    }
  });
});

describe("W-5 findZoneAtPoint does not fall through to candidates[0]", () => {
  it("two overlapping zones with unrecognised flags throw rather than return array-order first", () => {
    const zones = [
      squareZone("first", 0, 0, 4, 4, "Y", "X"),
      squareZone("second", 1, 1, 3, 3, "1", "AE"),
    ];
    const defectHit = findZoneAtPointDefect(2, 2, zones);
    expect(defectHit?.zoneRowId).toBe("first");

    expect(() => findZoneAtPoint(2, 2, zones)).toThrow(
      UnrecognisedSfhaFlagError,
    );
    expect(() => pickPreferredFloodZone(zones)).toThrow(
      UnrecognisedSfhaFlagError,
    );

    const grid = buildFloodZoneGrid(zones, {
      westLng: 0,
      southLat: 0,
      eastLng: 4,
      northLat: 4,
    })!;
    expect(() => findZoneAtPointWithGrid(2, 2, grid, zones)).toThrow(
      UnrecognisedSfhaFlagError,
    );
  });

  it("unrecognised sibling raises even when a later flag is valid SFHA T", () => {
    const zones = [
      squareZone("bad", 0, 0, 4, 4, "Y", "X"),
      squareZone("sfha", 1, 1, 3, 3, "T", "AE"),
    ];
    const defectHit = findZoneAtPointDefect(2, 2, zones);
    expect(defectHit?.zoneRowId).toBe("sfha");
    expect(() => findZoneAtPoint(2, 2, zones)).toThrow(
      UnrecognisedSfhaFlagError,
    );
  });

  it("null flags on two overlapping zones throw, not candidates[0]", () => {
    const zones = [
      squareZone("a", 0, 0, 4, 4, null, "X"),
      squareZone("b", 1, 1, 3, 3, null, "AE"),
    ];
    expect(findZoneAtPointDefect(2, 2, zones)?.zoneRowId).toBe("a");
    expect(() => findZoneAtPoint(2, 2, zones)).toThrow(
      UnrecognisedSfhaFlagError,
    );
  });

  it("mixed recognised SFHA and non-SFHA: SFHA wins regardless of array order", () => {
    const nonFirst = [
      squareZone("non", 0, 0, 4, 4, "F", "X"),
      squareZone("sfha", 1, 1, 3, 3, "T", "AE"),
    ];
    expect(findZoneAtPoint(2, 2, nonFirst)?.zoneRowId).toBe("sfha");
    const sfhaFirst = [
      squareZone("sfha", 1, 1, 3, 3, "T", "AE"),
      squareZone("non", 0, 0, 4, 4, "F", "X"),
    ];
    expect(findZoneAtPoint(2, 2, sfhaFirst)?.zoneRowId).toBe("sfha");
  });

  it("all recognised non-SFHA returns the first candidate honestly", () => {
    const zones = [
      squareZone("x-outer", 0, 0, 4, 4, "F", "X"),
      squareZone("x-inner", 1, 1, 3, 3, "F", "X"),
    ];
    expect(findZoneAtPoint(2, 2, zones)?.zoneRowId).toBe("x-outer");
  });
});

describe("W-3 / W-4 third geometryCentroid", () => {
  it("closed-ring Polygon does not double-count the closing vertex", () => {
    const third = geometryCentroid(CLOSED_SQUARE);
    const wellFact = wellFactGeometryCentroid(CLOSED_SQUARE);
    expect(wellFact).toEqual([0.8, 0.8]);
    expect(third).toEqual([1, 1]);
    expect(third).not.toEqual(wellFact);
  });

  it("MultiPolygon returns null, not part-one centroid", () => {
    const partOne = floodMultiPolygonPartOneDefect(TWO_PART_MULTIPOLYGON);
    expect(partOne).toEqual([1, 1]);
    expect(geometryCentroid(TWO_PART_MULTIPOLYGON)).toBeNull();
    expect(wellFactGeometryCentroid(TWO_PART_MULTIPOLYGON)).toBeNull();
  });

  it("Point stays the point", () => {
    expect(geometryCentroid({ type: "Point", coordinates: [-97.5, 30.25] })).toEqual(
      [-97.5, 30.25],
    );
  });

  it("MultiPolygon null is not replaced by bbox midpoint (writer call-site defect)", () => {
    const bboxMid: LngLat = [
      (0 + 12) / 2,
      (0 + 12) / 2,
    ];
    function writerBboxFallbackDefect(geometry: unknown): LngLat | null {
      return geometryCentroid(geometry) ?? bboxMid;
    }
    expect(writerBboxFallbackDefect(TWO_PART_MULTIPOLYGON)).toEqual([6, 6]);
    expect(geometryCentroid(TWO_PART_MULTIPOLYGON)).toBeNull();
  });
});
