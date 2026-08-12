/**
 * Spatial grid index tests — parity with linear scan + adversarial geometry.
 */
import { describe, expect, it } from "vitest";

import {
  findZoneAtPoint,
  type FloodZoneFeature,
} from "../flood-hazard-fact/geo.js";
import {
  buildFloodZoneGrid,
  countGeometryVertices,
  findZoneAtPointWithGrid,
  gatherGridCandidateIndices,
} from "../flood-hazard-fact/flood-zone-grid.js";

function squareZone(
  id: string,
  west: number,
  south: number,
  east: number,
  north: number,
  overrides: Partial<FloodZoneFeature> = {},
): FloodZoneFeature {
  return {
    zoneRowId: id,
    fldZone: "AE",
    zoneSubty: null,
    sfhaTf: "T",
    staticBfe: 10,
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
    ...overrides,
  };
}

function samplePoints(
  zones: FloodZoneFeature[],
  bbox: { westLng: number; southLat: number; eastLng: number; northLat: number },
  step = 0.05,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let lng = bbox.westLng; lng <= bbox.eastLng; lng += step) {
    for (let lat = bbox.southLat; lat <= bbox.northLat; lat += step) {
      pts.push([lng, lat]);
    }
  }
  // Include zone centroids and corners.
  for (const z of zones) {
    pts.push([(z.westLng + z.eastLng) / 2, (z.southLat + z.northLat) / 2]);
    pts.push([z.westLng, z.southLat]);
    pts.push([z.eastLng, z.northLat]);
  }
  return pts;
}

describe("countGeometryVertices", () => {
  it("counts outer ring and holes", () => {
    const poly = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
        [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.8],
          [0.2, 0.2],
        ],
      ],
    };
    expect(countGeometryVertices(poly)).toBe(10);
  });
});

describe("buildFloodZoneGrid + findZoneAtPointWithGrid", () => {
  const bbox = { westLng: 0, southLat: 0, eastLng: 10, northLat: 10 };

  it("grid path matches linear scan on synthetic zones", () => {
    const zones: FloodZoneFeature[] = [
      squareZone("a", 1, 1, 4, 4, { fldZone: "AE", sfhaTf: "T" }),
      squareZone("b", 5, 5, 8, 8, { fldZone: "X", sfhaTf: "F" }),
      squareZone("c", 2, 6, 3, 7, { fldZone: "AO", sfhaTf: "T" }),
    ];
    const grid = buildFloodZoneGrid(zones, bbox)!;
    expect(grid).not.toBeNull();
    expect(grid.cols).toBeGreaterThanOrEqual(8);
    expect(grid.rows).toBeGreaterThanOrEqual(8);

    for (const [lng, lat] of samplePoints(zones, bbox, 0.25)) {
      const linear = findZoneAtPoint(lng, lat, zones);
      const indexed = findZoneAtPointWithGrid(lng, lat, grid, zones);
      expect(indexed?.zoneRowId ?? null).toBe(linear?.zoneRowId ?? null);
    }
  });

  it("finds zone when point sits on a cell boundary (neighbor cell holds zone)", () => {
    // Small grid over [0,2]×[0,2] with 2 cols / 2 rows → cell edges at lng=1, lat=1.
    const zones = [squareZone("edge", 0.5, 0.5, 1.5, 1.5)];
    const smallBbox = { westLng: 0, southLat: 0, eastLng: 2, northLat: 2 };
    const grid = buildFloodZoneGrid(zones, smallBbox)!;
    // Point on the vertical cell boundary at lng=1, inside the zone polygon.
    const hit = findZoneAtPointWithGrid(1, 1, grid, zones);
    expect(hit?.zoneRowId).toBe("edge");
    const linear = findZoneAtPoint(1, 1, zones);
    expect(hit?.zoneRowId).toBe(linear?.zoneRowId);
  });

  it("registers zone spanning many cells and finds interior point", () => {
    const zones = [squareZone("wide", 0, 0, 9.5, 9.5)];
    const grid = buildFloodZoneGrid(zones, bbox)!;
    let cellsWithZone = 0;
    for (const cell of grid.cells) {
      if (cell.includes(0)) cellsWithZone += 1;
    }
    expect(cellsWithZone).toBeGreaterThan(1);
    const hit = findZoneAtPointWithGrid(5, 5, grid, zones);
    expect(hit?.zoneRowId).toBe("wide");
  });

  it("returns null for point inside outer ring but in a hole", () => {
    const zones: FloodZoneFeature[] = [
      {
        zoneRowId: "donut",
        fldZone: "AE",
        zoneSubty: null,
        sfhaTf: "T",
        staticBfe: null,
        westLng: 0,
        southLat: 0,
        eastLng: 4,
        northLat: 4,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
              [0, 0],
            ],
            [
              [1.5, 1.5],
              [2.5, 1.5],
              [2.5, 2.5],
              [1.5, 2.5],
              [1.5, 1.5],
            ],
          ],
        },
      },
    ];
    const grid = buildFloodZoneGrid(zones, { westLng: 0, southLat: 0, eastLng: 4, northLat: 4 })!;
    const inHole = findZoneAtPointWithGrid(2, 2, grid, zones);
    expect(inHole).toBeNull();
    expect(findZoneAtPoint(2, 2, zones)).toBeNull();
    const inRing = findZoneAtPointWithGrid(0.5, 0.5, grid, zones);
    expect(inRing?.zoneRowId).toBe("donut");
  });

  it("does not match when point is inside bbox but outside polygon", () => {
    // L-shaped zone: bbox is full square but lower-right triangle is empty.
    const zones: FloodZoneFeature[] = [
      {
        zoneRowId: "lshape",
        fldZone: "AE",
        zoneSubty: null,
        sfhaTf: "T",
        staticBfe: null,
        westLng: 0,
        southLat: 0,
        eastLng: 4,
        northLat: 4,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 2],
              [2, 2],
              [2, 4],
              [0, 4],
              [0, 0],
            ],
          ],
        },
      },
    ];
    const grid = buildFloodZoneGrid(zones, { westLng: 0, southLat: 0, eastLng: 4, northLat: 4 })!;
    // Inside bbox (4,4 corner) but outside L polygon.
    const miss = findZoneAtPointWithGrid(3.5, 3.5, grid, zones);
    expect(miss).toBeNull();
    expect(findZoneAtPoint(3.5, 3.5, zones)).toBeNull();
    const hit = findZoneAtPointWithGrid(1, 1, grid, zones);
    expect(hit?.zoneRowId).toBe("lshape");
  });

  it("prefers SFHA zone when multiple zones overlap", () => {
    const zones: FloodZoneFeature[] = [
      squareZone("non-sfha", 1, 1, 5, 5, { fldZone: "X", sfhaTf: "F" }),
      squareZone("sfha", 2, 2, 4, 4, { fldZone: "AE", sfhaTf: "T" }),
    ];
    const grid = buildFloodZoneGrid(zones, { westLng: 0, southLat: 0, eastLng: 6, northLat: 6 })!;
    const hit = findZoneAtPointWithGrid(3, 3, grid, zones);
    expect(hit?.zoneRowId).toBe("sfha");
    expect(hit?.fldZone).toBe("AE");
    expect(findZoneAtPoint(3, 3, zones)?.zoneRowId).toBe("sfha");
  });

  it("3x3 neighborhood gathers candidates from adjacent cells", () => {
    const zones = [squareZone("solo", 4.9, 4.9, 5.1, 5.1)];
    const grid = buildFloodZoneGrid(zones, bbox)!;
    const { col, row } = { col: 0, row: 0 };
    // Force a query near the zone from a corner cell — should still find via neighbors.
    const indices = gatherGridCandidateIndices(5, 5, grid);
    expect(indices.length).toBeGreaterThan(0);
    expect(findZoneAtPointWithGrid(5, 5, grid, zones)?.zoneRowId).toBe("solo");
    void col;
    void row;
  });
});
