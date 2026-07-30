import { describe, expect, it } from "vitest";

import { computeD8Field, accumulationThresholdForResolution } from "@hauska-engine/adapters/hydrology";

import {
  FLOW_PATHS_MAX,
  FLOW_PATH_MAX_POINTS,
  SWATH_MAX_HALF_WIDTH_CELLS,
  SWATH_MIN_HALF_WIDTH_CELLS,
  buildFloodFlowPaths,
  buildSwathRing,
  douglasPeuckerIndices,
  type BuildFloodFlowPathsOptions,
} from "../flood-flow-paths.js";
import { runFloodDrainageStudy } from "../flood-drainage-study.js";
import type { ParcelGeometryResolver } from "../../parcel-terrain/author.js";

const bbox = { westLng: -97.33, southLat: 30.09, eastLng: -97.31, northLat: 30.11 };

/** Valley DEM: flow converges into a fixed column and drains SOUTH
 *  (row 0 = north; elevation falls as row grows). */
function valleyDem(width: number, height: number, valleyCol: number): Float32Array {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = Math.abs(col - valleyCol) * 2 + (height - row) * 0.5;
    }
  }
  return values;
}

/** Rippled south-draining slope: sin ridges carve MULTIPLE parallel channels
 *  -- the many-candidate fixture for the path cap + payload-size checks. */
function rippledDem(width: number, height: number): Float32Array {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] =
        (height - row) * 0.5 + 4 * Math.abs(Math.sin(col * 0.22)) + col * 0.001;
    }
  }
  return values;
}

/** A ring straddling the valley column mid-grid (cell-center space). */
function ringAroundValley(width: number, height: number, valleyCol: number): Array<[number, number]> {
  const cellLng = (bbox.eastLng - bbox.westLng) / width;
  const cellLat = (bbox.northLat - bbox.southLat) / height;
  const cx = bbox.westLng + (valleyCol + 0.5) * cellLng;
  const cy = bbox.northLat - (height / 2) * cellLat;
  const dx = cellLng * 5;
  const dy = cellLat * 5;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];
}

/** A ring far outside the modeled channels (grid corner, off the valley). */
function farCornerRing(): Array<[number, number]> {
  const west = bbox.westLng + 0.00001;
  const north = bbox.northLat - 0.00001;
  return [
    [west, north - 0.0002],
    [west + 0.0002, north - 0.0002],
    [west + 0.0002, north],
    [west, north],
    [west, north - 0.0002],
  ];
}

function buildOn(
  elevation: Float32Array,
  width: number,
  height: number,
  overrides: Partial<BuildFloodFlowPathsOptions> = {},
) {
  const d8 = computeD8Field(elevation, width, height);
  return buildFloodFlowPaths({
    elevation,
    width,
    height,
    accumulation: d8.accumulation,
    fdir: d8.fdir,
    bbox,
    accumulationThreshold: 50,
    parcelRing: ringAroundValley(width, height, 24),
    demResolutionMeters: 10,
    ...overrides,
  });
}

describe("buildFloodFlowPaths", () => {
  const W = 48;
  const H = 48;

  it("emits the PINNED contract shape: downstream coordinates, strength 0..1, kind enum, aligned swaths, note", () => {
    const result = buildOn(valleyDem(W, H, 24), W, H);
    expect(result).not.toBeNull();
    expect(result!.flowPaths.length).toBeGreaterThan(0);
    expect(result!.catchmentSwaths.length).toBe(result!.flowPaths.length);
    for (const p of result!.flowPaths) {
      expect(Array.isArray(p.coordinates)).toBe(true);
      expect(p.coordinates.length).toBeGreaterThanOrEqual(2);
      for (const c of p.coordinates) {
        expect(c.length).toBe(2);
        expect(Number.isFinite(c[0])).toBe(true);
        expect(Number.isFinite(c[1])).toBe(true);
      }
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(1);
      expect(["interior", "exit"]).toContain(p.kind);
    }
    // The trunk claims the grid's max-accumulation cell -> strength exactly 1.
    expect(Math.max(...result!.flowPaths.map((p) => p.strength))).toBe(1);
    // Provenance note documents the derivation and the honesty line.
    expect(result!.note).toContain("D8 flow-accumulation");
    expect(result!.note).toContain("10 m per pixel");
    expect(result!.note).toContain("not a delineated watershed boundary");
  });

  it("orders every path DOWNSTREAM (valley drains south -> latitude falls trunk-first-to-last)", () => {
    const result = buildOn(valleyDem(W, H, 24), W, H);
    expect(result).not.toBeNull();
    const trunk = result!.flowPaths.find((p) => p.strength === 1)!;
    expect(trunk).toBeDefined();
    const first = trunk.coordinates[0]!;
    const last = trunk.coordinates[trunk.coordinates.length - 1]!;
    expect(first[1]).toBeGreaterThan(last[1]);
  });

  it("marks the path crossing the parcel ring as 'exit' and off-parcel paths as 'interior'", () => {
    // Ring straddles the valley mid-grid -> the trunk passes through and leaves.
    const onValley = buildOn(valleyDem(W, H, 24), W, H);
    expect(onValley).not.toBeNull();
    const trunk = onValley!.flowPaths.find((p) => p.strength === 1)!;
    expect(trunk.kind).toBe("exit");
    // Same terrain, ring in a far corner no channel touches -> all interior.
    const offValley = buildOn(valleyDem(W, H, 24), W, H, { parcelRing: farCornerRing() });
    expect(offValley).not.toBeNull();
    for (const p of offValley!.flowPaths) expect(p.kind).toBe("interior");
    // Swath kind mirrors its path's kind.
    onValley!.flowPaths.forEach((p, i) => {
      expect(onValley!.catchmentSwaths[i]!.kind).toBe(p.kind);
      expect(onValley!.catchmentSwaths[i]!.strength).toBe(p.strength);
    });
  });

  it("caps paths at FLOW_PATHS_MAX and vertices at FLOW_PATH_MAX_POINTS on a many-channel grid", () => {
    const W2 = 300;
    const H2 = 300;
    const result = buildOn(rippledDem(W2, H2), W2, H2, {
      parcelRing: ringAroundValley(W2, H2, 150),
    });
    expect(result).not.toBeNull();
    expect(result!.flowPaths.length).toBeLessThanOrEqual(FLOW_PATHS_MAX);
    for (const p of result!.flowPaths) {
      expect(p.coordinates.length).toBeLessThanOrEqual(FLOW_PATH_MAX_POINTS);
    }
    for (const s of result!.catchmentSwaths) {
      // Ring = left side + right side + closure.
      expect(s.coordinates.length).toBeLessThanOrEqual(FLOW_PATH_MAX_POINTS * 2 + 1);
      // Closed exterior ring.
      expect(s.coordinates[0]).toEqual(s.coordinates[s.coordinates.length - 1]);
    }
  });

  it("keeps the whole v3 payload map-friendly on a real-shaped grid (< 150 KB serialized)", () => {
    const W2 = 300;
    const H2 = 300;
    const result = buildOn(rippledDem(W2, H2), W2, H2, {
      parcelRing: ringAroundValley(W2, H2, 150),
    });
    expect(result).not.toBeNull();
    const bytes = JSON.stringify({
      flowPaths: result!.flowPaths,
      catchmentSwaths: result!.catchmentSwaths,
      flowPathsNote: result!.note,
    }).length;
    // Measured 2026-07-29: 3,746 bytes for 12 paths + swaths (300x300 grid).
    expect(bytes).toBeLessThan(150_000);
  });

  it("returns null honestly on degenerate fields: all-nodata, and no cell at the channel threshold", () => {
    const nodata = new Float32Array(W * H).fill(Number.NaN);
    const d8n = computeD8Field(nodata, W, H);
    expect(
      buildFloodFlowPaths({
        elevation: nodata,
        width: W,
        height: H,
        accumulation: d8n.accumulation,
        fdir: d8n.fdir,
        bbox,
        accumulationThreshold: 50,
        parcelRing: farCornerRing(),
        demResolutionMeters: 10,
      }),
    ).toBeNull();
    // Small tilted plane: max accumulation stays below the 50-cell threshold.
    const W3 = 24;
    const H3 = 24;
    const plane = new Float32Array(W3 * H3);
    for (let row = 0; row < H3; row++) {
      for (let col = 0; col < W3; col++) {
        plane[row * W3 + col] = 200 - col * 0.8 + row * 0.05;
      }
    }
    const d8p = computeD8Field(plane, W3, H3);
    expect(
      buildFloodFlowPaths({
        elevation: plane,
        width: W3,
        height: H3,
        accumulation: d8p.accumulation,
        fdir: d8p.fdir,
        bbox,
        accumulationThreshold: 50,
        parcelRing: farCornerRing(),
        demResolutionMeters: 10,
      }),
    ).toBeNull();
  });
});

describe("buildSwathRing", () => {
  it("widens with the per-vertex half-width: cross-corridor span ~= 2x half-width at each end", () => {
    // Straight south-running path along a meridian.
    const vertices: Array<[number, number]> = [
      [-97.32, 30.105],
      [-97.32, 30.1],
      [-97.32, 30.095],
    ];
    const ring = buildSwathRing(vertices, [10, 20, 40]);
    expect(ring.length).toBe(7); // 3 left + 3 right + closure
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const mLng = 110_574 * Math.cos((30.105 * Math.PI) / 180);
    const spanAt = (a: [number, number], b: [number, number]) =>
      Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * 110_574);
    // Upstream end: left[0] vs right-last-before-closure (the mirrored v0).
    expect(spanAt(ring[0]!, ring[5]!)).toBeCloseTo(20, 0);
    // Downstream end: left[2] vs right[first] (the mirrored v2).
    expect(spanAt(ring[2]!, ring[3]!)).toBeCloseTo(80, 0);
  });

  it("documents sane half-width bounds relative to DEM cells", () => {
    expect(SWATH_MIN_HALF_WIDTH_CELLS).toBeGreaterThan(0);
    expect(SWATH_MAX_HALF_WIDTH_CELLS).toBeGreaterThan(SWATH_MIN_HALF_WIDTH_CELLS);
  });
});

describe("douglasPeuckerIndices", () => {
  it("keeps endpoints, preserves order, and collapses collinear runs", () => {
    const line: Array<[number, number]> = [];
    for (let i = 0; i <= 100; i++) line.push([-97.32 + i * 0.0001, 30.1]);
    const kept = douglasPeuckerIndices(line, 0.00001);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(100);
    expect(kept.length).toBeLessThan(10);
    for (let i = 1; i < kept.length; i++) expect(kept[i]!).toBeGreaterThan(kept[i - 1]!);
  });
});

// --- absent-safe integration fixture (old consumers unaffected) ----------

const parcelBbox = { westLng: -97.32, southLat: 30.1, eastLng: -97.318, northLat: 30.102 };
const ringWgs84: Array<[number, number]> = [
  [-97.3196, 30.1004],
  [-97.3184, 30.1004],
  [-97.3184, 30.1016],
  [-97.3196, 30.1016],
  [-97.3196, 30.1004],
];
const resolver: ParcelGeometryResolver = {
  async resolve() {
    return { bbox: parcelBbox, sourceRef: "txgio-parcel:test", ring: ringWgs84 };
  },
};

function fakeFetchDem(grid: number) {
  return (async (bboxArg: unknown, opts: { resolutionMeters: number }) => ({
    bytes: new Uint8Array(8),
    contentType: "image/tiff",
    bbox: bboxArg,
    resolutionMeters: opts.resolutionMeters,
    resolutionMetersRequested: opts.resolutionMeters,
    resolutionMetersActual: null,
    widthPx: grid,
    heightPx: grid,
    endpoint: "https://fake.usgs.example/exportImage",
    fetchedAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const failingRainfall = (async () => {
  throw new Error("test stub: no NOAA egress");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

function okWorkerResult() {
  return {
    status: "ok" as const,
    library: "native-d8",
    libraryVersion: "1.0.0",
    routing: "d8",
    accumulationThreshold: accumulationThresholdForResolution(10),
    drainageZonesGeoJson: { type: "FeatureCollection" as const, features: [] },
    flowLinesGeoJson: { type: "FeatureCollection" as const, features: [] },
    rainfallResultGeoJson: null,
    pourPoint: { lng: -97.319, lat: 30.101 },
  };
}

describe("study payload: flowPaths absent-safety", () => {
  it("OMITS flowPaths/catchmentSwaths/flowPathsNote when no channel reaches the threshold -- old consumers see the exact pre-v3 shape", async () => {
    // 24x24 tilted plane: max D8 accumulation < 50-cell threshold.
    const GRID = 24;
    const values = new Float32Array(GRID * GRID);
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        values[row * GRID + col] = 200 - col * 0.8 + row * 0.05;
      }
    }
    const { study } = await runFloodDrainageStudy({
      parcelNodeId: "48021:fixture",
      resolver,
      fetchDem: fakeFetchDem(GRID),
      parseDem: async () => ({
        width: GRID,
        height: GRID,
        values,
        minElevation: 0,
        maxElevation: 200,
        nodataCount: 0,
      }),
      runWorker: async () => okWorkerResult(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    const json = JSON.parse(JSON.stringify(study)) as Record<string, unknown>;
    expect("flowPaths" in json).toBe(false);
    expect("catchmentSwaths" in json).toBe(false);
    expect("flowPathsNote" in json).toBe(false);
    // Pre-v3 fields intact.
    expect(json.briefing).toBeTruthy();
    expect(json.demProvenance).toBeTruthy();
  });

  it("carries flowPaths + index-aligned catchmentSwaths + note when the D8 field has real channels", async () => {
    // 64x64 valley: trunk accumulation far above the 50-cell threshold.
    const GRID = 64;
    const values = valleyDem(GRID, GRID, 32);
    const { study } = await runFloodDrainageStudy({
      parcelNodeId: "48021:fixture",
      resolver,
      fetchDem: fakeFetchDem(GRID),
      parseDem: async () => ({
        width: GRID,
        height: GRID,
        values,
        minElevation: 0,
        maxElevation: 200,
        nodataCount: 0,
      }),
      runWorker: async () => okWorkerResult(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    expect(study.flowPaths).toBeDefined();
    expect(study.flowPaths!.length).toBeGreaterThan(0);
    expect(study.catchmentSwaths!.length).toBe(study.flowPaths!.length);
    expect(study.flowPathsNote).toContain("D8 flow-accumulation");
    for (const p of study.flowPaths!) {
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(1);
    }
  });
});
