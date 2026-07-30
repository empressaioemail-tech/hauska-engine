import { describe, expect, it } from "vitest";

import type {
  GeoJsonFeatureCollection,
  HydrologyWorkerRequest,
  HydrologyWorkerResult,
} from "@hauska-engine/adapters/hydrology";
import { accumulationThresholdForResolution } from "@hauska-engine/adapters/hydrology";

import { computeD8Field, runHydrologyNative } from "@hauska-engine/adapters/hydrology";

import {
  DEFAULT_DRAINAGE_RESOLUTION_METERS,
  DEFAULT_RAINFALL_DEPTH_INCHES,
  HONEST_EMPTY_FLAT_TERRAIN,
  MIN_DRAINAGE_RESOLUTION_METERS,
  buildFloodDrainageBriefing,
  deriveDrainageZones,
  negligibleCatchmentThresholdSqFt,
  paddedCatchmentBbox,
  pointInRing,
  resolveFlowExits,
  resolvePourPoint,
  runFloodDrainageStudy,
  type FloodDrainageStudyStats,
} from "../flood-drainage-study.js";
import type { ParcelGeometryResolver } from "../../parcel-terrain/author.js";

// ─── fixtures ────────────────────────────────────────────────────────────
const parcelNodeId = "48021:47595";
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
    return { bbox: parcelBbox, sourceRef: "txgio-parcel:48021:47595:stratmap25", ring: ringWgs84 };
  },
};

const GRID = 24;

/** Shoelace area of a WGS84 ring in square feet — the same local-meters
 * approximation the study itself uses, so the assertions compare like to
 * like rather than importing a private helper. */
function ringAreaSqFtLocal(pts: ReadonlyArray<[number, number]>): number {
  if (pts.length < 3) return 0;
  const METERS_PER_DEG_LAT = 110_574;
  const mLng = METERS_PER_DEG_LAT * Math.cos((pts[0]![1] * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum +=
      pts[j]![0] * mLng * (pts[i]![1] * METERS_PER_DEG_LAT) -
      pts[i]![0] * mLng * (pts[j]![1] * METERS_PER_DEG_LAT);
  }
  return Math.abs(sum / 2) * 10.7639;
}

/** Sloped synthetic DEM over the padded catchment bbox (west-high → east-low). */
function slopedDem() {
  const values = new Float32Array(GRID * GRID);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      values[row * GRID + col] = 200 - col * 0.8 + row * 0.05;
    }
  }
  return {
    width: GRID,
    height: GRID,
    values,
    minElevation: 200 - (GRID - 1) * 0.8,
    maxElevation: 200 + (GRID - 1) * 0.05,
    nodataCount: 0,
  };
}

function flatDem() {
  const values = new Float32Array(GRID * GRID).fill(150);
  return { width: GRID, height: GRID, values, minElevation: 150, maxElevation: 150, nodataCount: 0 };
}

function fakeFetchDem() {
  const calls: Array<{ bbox: unknown; resolutionMeters: number }> = [];
  const fn = (async (bboxArg: unknown, opts: { resolutionMeters: number }) => {
    calls.push({ bbox: bboxArg, resolutionMeters: opts.resolutionMeters });
    return {
      bytes: new Uint8Array(8),
      contentType: "image/tiff",
      bbox: bboxArg,
      resolutionMeters: opts.resolutionMeters,
      resolutionMetersRequested: opts.resolutionMeters,
      resolutionMetersActual: null,
      widthPx: GRID,
      heightPx: GRID,
      endpoint: "https://fake.usgs.example/exportImage",
      fetchedAt: new Date().toISOString(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, calls };
}

const failingRainfall = (async () => {
  throw new Error("test stub: no NOAA egress");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const atlasRainfall = (async (args: { lat: number; lng: number }) => ({
  lat: args.lat,
  lng: args.lng,
  source: "noaa-atlas-14-pfds",
  fetchedAt: new Date().toISOString(),
  designStorms: [
    { returnPeriodYears: 25, durationHours: 24, depthInches: 7.1 },
    { returnPeriodYears: 100, durationHours: 24, depthInches: 9.8 },
  ],
  endpoint: "https://hdsc.nws.noaa.gov/fake",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
})) as any;

function quad(lng: number, lat: number, d: number, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng, lat],
          [lng + d, lat],
          [lng + d, lat + d],
          [lng, lat + d],
          [lng, lat],
        ],
      ],
    },
    properties,
  };
}

function mockWorkerResult(): HydrologyWorkerResult {
  const catchment: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      quad(-97.3192, 30.1008, 0.0004, { zone: "catchment" }),
      quad(-97.3202, 30.101, 0.0004, { zone: "catchment" }),
    ],
  };
  // Three NESTED concentration bands, as both hydrology backends now emit
  // them from their own D8 accumulation grid (widest = low, tightest = high).
  const concentrationBands: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      quad(-97.3202, 30.1006, 0.0016, {
        zone: "drainage-concentration",
        concentration: 2,
        concentrationBasis: "D8 flow accumulation at or above 900 upstream cells",
      }),
      quad(-97.3204, 30.1004, 0.0022, {
        zone: "drainage-concentration",
        concentration: 0,
        concentrationBasis: "modeled catchment extent",
      }),
      quad(-97.3203, 30.1005, 0.0019, {
        zone: "drainage-concentration",
        concentration: 1,
        concentrationBasis: "D8 flow accumulation at or above 300 upstream cells",
      }),
    ],
  };
  // One traced line starting inside the ring and leaving it eastward.
  const flowLines: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [-97.319, 30.101],
            [-97.3186, 30.1009],
            [-97.318, 30.1008],
            [-97.3175, 30.1008],
          ],
        },
        properties: { accumulation: 120 },
      },
    ],
  };
  const rainfall: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      // Fully inside the parcel ring → counts toward the headline stat.
      quad(-97.3192, 30.1008, 0.0002, { rainfallDepthMm: 241 }),
      // Far-field ponding (well outside the ring) → context only; must
      // NEVER inflate the parcel headline (the 2026-07-29 canary defect).
      quad(-97.325, 30.105, 0.001, { rainfallDepthMm: 241 }),
    ],
  };
  return {
    status: "ok",
    library: "pysheds",
    libraryVersion: "0.3",
    routing: "d8",
    accumulationThreshold: 50,
    drainageZonesGeoJson: catchment,
    concentrationBandsGeoJson: concentrationBands,
    flowLinesGeoJson: flowLines,
    rainfallResultGeoJson: rainfall,
    pourPoint: { lng: -97.319, lat: 30.101 },
  };
}

describe("paddedCatchmentBbox", () => {
  it("pads the parcel bbox by at least the minimum catchment pad on every side", () => {
    const padded = paddedCatchmentBbox(parcelBbox);
    const mLat = 110_574;
    const padSouthM = (parcelBbox.southLat - padded.southLat) * mLat;
    const padNorthM = (padded.northLat - parcelBbox.northLat) * mLat;
    expect(padSouthM).toBeGreaterThanOrEqual(249);
    expect(padNorthM).toBeGreaterThanOrEqual(249);
    expect(padded.westLng).toBeLessThan(parcelBbox.westLng);
    expect(padded.eastLng).toBeGreaterThan(parcelBbox.eastLng);
  });
});

describe("runFloodDrainageStudy", () => {
  it("maps worker outputs into the study: catchment, graded zones, ponding, flow lines, exits, briefing", async () => {
    const dem = slopedDem();
    const workerCalls: HydrologyWorkerRequest[] = [];
    const { fn: fetchDem } = fakeFetchDem();
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem,
      parseDem: async () => dem,
      runWorker: async (req) => {
        workerCalls.push(req);
        return mockWorkerResult();
      },
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });

    expect(study.honestEmpty).toBeUndefined();
    expect(study.catchmentGeoJson.features.length).toBe(2);
    // Zones are the THREE NESTED CONCENTRATION BANDS the backend derived from
    // its own D8 accumulation grid, ordered low → high for paint order.
    expect(study.drainageZonesGeoJson.features.length).toBe(3);
    const concentrations = study.drainageZonesGeoJson.features.map(
      (f) => (f.properties as { concentration: number }).concentration,
    );
    expect(concentrations).toEqual([0, 1, 2]);
    expect(study.rainfallResultGeoJson?.features.length).toBe(2);
    expect(study.flowLinesGeoJson.features.length).toBe(1);
    // The traced line leaves the ring eastward → exactly one exit.
    expect(study.stats.flowExitCount).toBe(1);
    expect(study.flowExits[0]!.bearingDeg).toBeGreaterThan(45);
    expect(study.flowExits[0]!.bearingDeg).toBeLessThan(135);
    // Areas derive from the real polygons, in square feet.
    expect(study.stats.catchmentAreaSqFt).toBeGreaterThan(0);
    // HEADLINE ponding = PARCEL-CLIPPED only. The in-ring quad is ~0.0002°
    // square (~470 sq ft-ish at this latitude); the far-field quad is 25x
    // larger and must NOT count toward the headline.
    expect(study.stats.pondedAreaSqFt).toBeGreaterThan(0);
    expect(study.stats.pondedAreaSqFt!).toBeLessThan(6_000);
    expect(study.stats.pondedAreaModeledRegionSqFt!).toBeGreaterThan(
      study.stats.pondedAreaSqFt! * 10,
    );
    // Every rainfall feature is tagged with the clip verdict for the
    // drawing/PE viz: in-ring true, far-field false.
    const tags = study.rainfallResultGeoJson!.features.map(
      (f) => (f.properties as { onParcel: boolean }).onParcel,
    );
    expect(tags).toEqual([true, false]);
    // Briefing is deterministic layman prose from the real values — §11
    // clean: no colons, no machine identifiers.
    expect(study.briefing).toContain("catchment");
    expect(study.briefing).toContain("design storm");
    expect(study.briefing).not.toContain(":");
    expect(study.briefing).not.toMatch(/[a-z]+[_/][a-z]+/i);
    // DEM provenance carries the resolution actually used.
    expect(study.demProvenance).toEqual({
      source: "USGS 3DEP",
      resolutionMeters: DEFAULT_DRAINAGE_RESOLUTION_METERS,
    });
    // Worker was fed the padded catchment bbox and parsed elevation grid.
    expect(workerCalls[0]!.width).toBe(GRID);
    expect(workerCalls[0]!.catchmentBbox.westLng).toBeLessThan(parcelBbox.westLng);
  });

  it("respects the hydrology resolution floor: a 1m request is clamped, never fed to the worker", async () => {
    const dem = slopedDem();
    const { fn: fetchDem, calls } = fakeFetchDem();
    const workerCalls: HydrologyWorkerRequest[] = [];
    await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      resolutionMeters: 1,
      fetchDem,
      parseDem: async () => dem,
      runWorker: async (req) => {
        workerCalls.push(req);
        return mockWorkerResult();
      },
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    expect(calls[0]!.resolutionMeters).toBeGreaterThanOrEqual(MIN_DRAINAGE_RESOLUTION_METERS);
    // The D8 threshold rescales with the resolution actually fetched.
    expect(workerCalls[0]!.accumulationThreshold).toBe(
      accumulationThresholdForResolution(calls[0]!.resolutionMeters),
    );
  });

  it("defaults to the drainage-calibrated resolution (10 m), not the 1 m terrain default", async () => {
    const dem = slopedDem();
    const { fn: fetchDem, calls } = fakeFetchDem();
    await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem,
      parseDem: async () => dem,
      runWorker: async () => mockWorkerResult(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    expect(calls[0]!.resolutionMeters).toBe(DEFAULT_DRAINAGE_RESOLUTION_METERS);
  });

  it("records rainfallSource honestly: parameter | noaa-atlas14 | default", async () => {
    const dem = slopedDem();
    const base = {
      parcelNodeId,
      resolver,
      parseDem: async () => dem,
      runWorker: async (req: HydrologyWorkerRequest) => {
        void req;
        return mockWorkerResult();
      },
    };

    const param = await runFloodDrainageStudy({
      ...base,
      fetchDem: fakeFetchDem().fn,
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 6.25,
    });
    expect(param.study.rainfallSource).toBe("parameter");
    expect(param.study.rainfallDepthInches).toBe(6.25);

    const atlas = await runFloodDrainageStudy({
      ...base,
      fetchDem: fakeFetchDem().fn,
      fetchRainfall: atlasRainfall,
    });
    expect(atlas.study.rainfallSource).toBe("noaa-atlas14");
    expect(atlas.study.rainfallDepthInches).toBe(9.8);

    const dflt = await runFloodDrainageStudy({
      ...base,
      fetchDem: fakeFetchDem().fn,
      fetchRainfall: failingRainfall,
    });
    expect(dflt.study.rainfallSource).toBe("default");
    expect(dflt.study.rainfallDepthInches).toBe(DEFAULT_RAINFALL_DEPTH_INCHES);
  });

  it("feeds the worker a PARCEL-AWARE pour point: max-accumulation cell touching the parcel, never the bbox center", async () => {
    const dem = slopedDem();
    const workerCalls: HydrologyWorkerRequest[] = [];
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem: fakeFetchDem().fn,
      parseDem: async () => dem,
      runWorker: async (req) => {
        workerCalls.push(req);
        return mockWorkerResult();
      },
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    const pour = { lng: workerCalls[0]!.pourLng, lat: workerCalls[0]!.pourLat };
    // The pour point sits ON or immediately ADJACENT to the parcel (within
    // ~1.5 drainage cells of the ring bbox), never the padded-bbox centre.
    const padded = workerCalls[0]!.catchmentBbox;
    const cellLng = (padded.eastLng - padded.westLng) / GRID;
    const cellLat = (padded.northLat - padded.southLat) / GRID;
    expect(pour.lng).toBeGreaterThan(parcelBbox.westLng - 1.5 * cellLng);
    expect(pour.lng).toBeLessThan(parcelBbox.eastLng + 1.5 * cellLng);
    expect(pour.lat).toBeGreaterThan(parcelBbox.southLat - 1.5 * cellLat);
    expect(pour.lat).toBeLessThan(parcelBbox.northLat + 1.5 * cellLat);
    const bboxCenter = {
      lng: (padded.westLng + padded.eastLng) / 2,
      lat: (padded.southLat + padded.northLat) / 2,
    };
    expect(pour.lng === bboxCenter.lng && pour.lat === bboxCenter.lat).toBe(false);
    // The method used is disclosed on the study stats.
    expect(study.stats.pourPointMethod).toBe("max-accumulation-on-parcel");
  });

  it("carries the WATER GRADIENT on the study (the PINNED contract the PE leg codes to)", async () => {
    const dem = slopedDem();
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem: fakeFetchDem().fn,
      parseDem: async () => dem,
      runWorker: async () => mockWorkerResult(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    // PINNED CONTRACT:
    //   gradient: { pngBase64: string,
    //     bbox: { westLng, southLat, eastLng, northLat }, note: string }
    expect(study.gradient).toMatchObject({
      pngBase64: expect.any(String),
      bbox: {
        westLng: expect.any(Number),
        southLat: expect.any(Number),
        eastLng: expect.any(Number),
        northLat: expect.any(Number),
      },
      note: expect.any(String),
    });
    // The raster drapes the padded catchment bbox exactly.
    expect(study.gradient!.bbox).toEqual(study.catchmentBbox);
    // The note records DEM resolution + design storm.
    expect(study.gradient!.note).toContain(`${DEFAULT_DRAINAGE_RESOLUTION_METERS} m per pixel`);
    expect(study.gradient!.note).toContain("8 inch");
  });

  it("honest-empty on flat terrain (real native D8 run): reason recorded, geometry EMPTY, never fabricated", async () => {
    // No runWorker seam: the real worker runs, prefers native under vitest,
    // and native D8 declines flat terrain.
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem: fakeFetchDem().fn,
      parseDem: async () => flatDem(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    expect(study.honestEmpty?.reason).toBe(HONEST_EMPTY_FLAT_TERRAIN);
    expect(study.catchmentGeoJson.features.length).toBe(0);
    expect(study.drainageZonesGeoJson.features.length).toBe(0);
    expect(study.flowLinesGeoJson.features.length).toBe(0);
    expect(study.rainfallResultGeoJson).toBeNull();
    expect(study.stats.catchmentAreaSqFt).toBe(0);
    expect(study.stats.pondedAreaSqFt).toBeNull();
    expect(study.stats.pondedAreaModeledRegionSqFt).toBeNull();
    expect(study.stats.flowExitCount).toBe(0);
    expect(study.briefing).toContain(HONEST_EMPTY_FLAT_TERRAIN);
    // No gradient is fabricated for an honest-empty study.
    expect(study.gradient).toBeUndefined();
  });

  it("AREA HONESTY on the REAL native path: parcel-clipped ponding never exceeds the parcel, catchment stays inside the modeled bbox", async () => {
    // No runWorker seam — the real hydrology backend runs (native D8 under
    // vitest) over a real bowl DEM, so these assertions grade the DISSOLVED
    // geometry the fix produces, not a hand-built fixture.
    //
    // WHY THIS TEST EXISTS: the old converters subsampled the mask, so their
    // area sums under-counted the truth. Dissolved tracing makes the areas
    // real, which MOVES the headline numbers. That is the fix — but the
    // headline ponding stat must stay PARCEL-CLIPPED, and the catchment must
    // stay bounded by the extent actually modeled. A prior canary caught a
    // parcel-scale stat reading like a whole-region number.
    const W = 48;
    const H = 48;
    const values = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const dx = col - 24;
        const dy = row - 24;
        values[row * W + col] = 180 + (dx * dx + dy * dy) * 0.02 + col * 0.002;
      }
    }
    const bowlDem = {
      width: W,
      height: H,
      values,
      minElevation: 180,
      maxElevation: 180 + 24 * 24 * 0.04,
      nodataCount: 0,
    };
    const fetchDem = (async (bboxArg: unknown, opts: { resolutionMeters: number }) => ({
      bytes: new Uint8Array(8),
      contentType: "image/tiff",
      bbox: bboxArg,
      resolutionMeters: opts.resolutionMeters,
      resolutionMetersRequested: opts.resolutionMeters,
      resolutionMetersActual: null,
      widthPx: W,
      heightPx: H,
      endpoint: "https://fake.usgs.example/exportImage",
      fetchedAt: new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem,
      parseDem: async () => bowlDem,
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    // The bowl DEM has real relief, so the run MUST produce geometry — a
    // vacuous pass on an honest-empty study would grade nothing.
    expect(study.honestEmpty).toBeUndefined();
    expect(study.catchmentGeoJson.features.length).toBeGreaterThan(0);
    expect(study.drainageZonesGeoJson.features.length).toBeGreaterThan(0);

    // 1) The headline ponding stat is PARCEL-CLIPPED: it can never exceed the
    // parcel's own area, no matter how much of the region ponds.
    const parcelAreaSqFt = ringAreaSqFtLocal(ringWgs84);
    expect(parcelAreaSqFt).toBeGreaterThan(0);
    if (study.stats.pondedAreaSqFt != null) {
      expect(study.stats.pondedAreaSqFt).toBeLessThanOrEqual(parcelAreaSqFt * 1.001);
      // ...and it is never the whole-region figure wearing a parcel label.
      if (study.stats.pondedAreaModeledRegionSqFt != null) {
        expect(study.stats.pondedAreaSqFt).toBeLessThanOrEqual(
          study.stats.pondedAreaModeledRegionSqFt * 1.001,
        );
      }
    }

    // 2) The catchment is bounded by the extent actually modeled — a traced
    // region cannot enclose more than the padded catchment bbox it came from.
    const bboxAreaSqFt = ringAreaSqFtLocal([
      [study.catchmentBbox.westLng, study.catchmentBbox.southLat],
      [study.catchmentBbox.eastLng, study.catchmentBbox.southLat],
      [study.catchmentBbox.eastLng, study.catchmentBbox.northLat],
      [study.catchmentBbox.westLng, study.catchmentBbox.northLat],
      [study.catchmentBbox.westLng, study.catchmentBbox.southLat],
    ]);
    expect(study.stats.catchmentAreaSqFt).toBeLessThanOrEqual(bboxAreaSqFt * 1.01);

    // 3) The geometry is DISSOLVED: a handful of traced polygons, not one
    // square per grid cell (a 48x48 grid would have yielded ~144 squares at
    // the old step, and hundreds at full resolution).
    expect(study.catchmentGeoJson.features.length).toBeLessThan(20);
    for (const feature of study.catchmentGeoJson.features) {
      if (feature.geometry.type !== "Polygon") continue;
      const ring = (feature.geometry.coordinates as Array<Array<[number, number]>>)[0]!;
      const isBareSquare =
        ring.length === 5 &&
        ring[0]![1] === ring[1]![1] &&
        ring[1]![0] === ring[2]![0];
      expect(isBareSquare).toBe(false);
    }

    // 4) Every zone feature carries a paintable concentration band.
    for (const feature of study.drainageZonesGeoJson.features) {
      const c = (feature.properties as { concentration?: number }).concentration;
      expect([0, 1, 2]).toContain(c);
    }
  });

  it("refuses a ringless parcel — no ring approximated from the bbox", async () => {
    const ringless: ParcelGeometryResolver = {
      async resolve() {
        return { bbox: parcelBbox, sourceRef: "txgio-parcel:48021:47595:stratmap25" };
      },
    };
    await expect(
      runFloodDrainageStudy({
        parcelNodeId,
        resolver: ringless,
        fetchDem: fakeFetchDem().fn,
        parseDem: async () => slopedDem(),
        runWorker: async () => mockWorkerResult(),
        fetchRainfall: failingRainfall,
      }),
    ).rejects.toThrow(/no boundary ring/);
  });
});

describe("resolveFlowExits", () => {
  it("dedupes exits within the merge radius and ignores lines that never leave the ring", () => {
    const insideOnly: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-97.319, 30.1008],
              [-97.3189, 30.101],
            ],
          },
          properties: {},
        },
        // Two nearly identical exits → merged to one.
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-97.3186, 30.101],
              [-97.318, 30.101],
            ],
          },
          properties: {},
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-97.3186, 30.10101],
              [-97.318, 30.10101],
            ],
          },
          properties: {},
        },
      ],
    };
    const exits = resolveFlowExits(insideOnly, ringWgs84);
    expect(exits.length).toBe(1);
  });
});

describe("clipPondingToParcel", () => {
  it("clips a straddling ponding cell exactly: only the in-ring fraction counts toward the headline", async () => {
    const { clipPondingToParcel } = await import("../flood-drainage-study.js");
    // Quad straddling the ring's east edge (-97.3184): exactly half its
    // longitude span lies inside.
    const straddling: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [quad(-97.3186, 30.1008, 0.0004, { rainfallDepthMm: 241 })],
    };
    const clip = clipPondingToParcel(straddling, ringWgs84);
    expect(clip.modeledRegionAreaSqFt).toBeGreaterThan(0);
    const fraction = clip.onParcelAreaSqFt / clip.modeledRegionAreaSqFt;
    expect(fraction).toBeGreaterThan(0.45);
    expect(fraction).toBeLessThan(0.55);
    expect((clip.taggedGeoJson.features[0]!.properties as { onParcel: boolean }).onParcel).toBe(true);
  });

  it("reports 0 on-parcel (never a guessed positive) when nothing intersects the ring", async () => {
    const { clipPondingToParcel } = await import("../flood-drainage-study.js");
    const farField: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [quad(-97.33, 30.11, 0.001, {})],
    };
    const clip = clipPondingToParcel(farField, ringWgs84);
    expect(clip.onParcelAreaSqFt).toBe(0);
    expect(clip.modeledRegionAreaSqFt).toBeGreaterThan(0);
    expect((clip.taggedGeoJson.features[0]!.properties as { onParcel: boolean }).onParcel).toBe(false);
  });
});

describe("resolvePourPoint (parcel-aware, fixture DEM matrix)", () => {
  // 40×40 grid over a 0.04°×0.04° box; a deep valley at column 30 drains
  // south and carries the GLOBAL max accumulation + the LOWEST cell in the
  // bbox — both far from the parcel. The parcel sits around columns 8–12,
  // rows 18–22. Parcel-awareness means the pour point lands at the parcel's
  // own flow concentration, never at the valley and never the bbox centre.
  const W = 40;
  const H = 40;
  const box = { westLng: -97.34, southLat: 30.09, eastLng: -97.3, northLat: 30.13 };
  const cellLng = (box.eastLng - box.westLng) / W;
  const cellLat = (box.northLat - box.southLat) / H;
  const lngOfCol = (col: number) => box.westLng + (col + 0.5) * cellLng;
  const latOfRow = (row: number) => box.northLat - (row + 0.5) * cellLat;
  // Parcel ring: cols 8..12, rows 18..22.
  const fixtureRing: Array<[number, number]> = [
    [lngOfCol(8) - cellLng / 2, latOfRow(22) - cellLat / 2],
    [lngOfCol(12) + cellLng / 2, latOfRow(22) - cellLat / 2],
    [lngOfCol(12) + cellLng / 2, latOfRow(18) + cellLat / 2],
    [lngOfCol(8) - cellLng / 2, latOfRow(18) + cellLat / 2],
    [lngOfCol(8) - cellLng / 2, latOfRow(22) - cellLat / 2],
  ];

  function valleyDem(): { width: number; height: number; values: Float32Array } {
    const values = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        values[row * W + col] = Math.abs(col - 30) * 3 + (H - row) * 0.2;
      }
    }
    return { width: W, height: H, values };
  }

  it("picks the max-accumulation cell on/adjacent to the parcel — not the global max, the lowest bbox cell, or the bbox centre", () => {
    const dem = valleyDem();
    const d8 = computeD8Field(dem.values, W, H);
    const pour = resolvePourPoint(dem, box, fixtureRing, d8.accumulation);
    expect(pour.method).toBe("max-accumulation-on-parcel");
    // On or immediately adjacent to the parcel (cols 8..12 ± 1 cell).
    expect(pour.lng).toBeGreaterThanOrEqual(lngOfCol(7) - cellLng / 2);
    expect(pour.lng).toBeLessThanOrEqual(lngOfCol(13) + cellLng / 2);
    expect(pour.lat).toBeGreaterThanOrEqual(latOfRow(23) - cellLat / 2);
    expect(pour.lat).toBeLessThanOrEqual(latOfRow(17) + cellLat / 2);
    // Far from the valley column (the global max-accumulation channel).
    expect(Math.abs(pour.lng - lngOfCol(30))).toBeGreaterThan(10 * cellLng);
    // Not the bbox centre.
    expect(pour.lng).not.toBeCloseTo((box.westLng + box.eastLng) / 2, 6);
  });

  it("falls back to the parcel's LOWEST BOUNDARY CELL when no accumulated flow touches the parcel", () => {
    const dem = valleyDem();
    const zeroAcc = new Uint32Array(W * H); // no modeled flow anywhere
    const pour = resolvePourPoint(dem, box, fixtureRing, zeroAcc);
    expect(pour.method).toBe("lowest-boundary-cell");
    // The fixture slopes down toward the EAST (toward the valley) and the
    // SOUTH within the parcel band — the lowest boundary cell is the ring's
    // south-east corner region (the ring edge itself may land in the cell
    // one over, so allow 1.5 cells of grid snap).
    expect(Math.abs(pour.lng - lngOfCol(12))).toBeLessThan(cellLng * 1.5);
    expect(Math.abs(pour.lat - latOfRow(22))).toBeLessThan(cellLat * 1.5);
  });

  it("last-resorts to the ring centroid on an all-nodata grid — deterministic, never a guessed outfall", () => {
    const values = new Float32Array(W * H).fill(Number.NaN);
    const pour = resolvePourPoint({ width: W, height: H, values }, box, fixtureRing, new Uint32Array(W * H));
    expect(pour.method).toBe("ring-centroid");
  });
});

/**
 * MECHANICAL COHERENCE (2026-07-30) — the study as a whole, driven end to end
 * through the REAL native hydrology backend rather than a mocked worker
 * result, so the assertion binds the actual criterion.
 *
 * Live parcel 48021:36249 (Bastrop, ~9.2 ac) is a local high point with a
 * negligible upstream catchment; the pre-fix payload reported 396,134 sq ft of
 * ponding against 398,813 sq ft of parcel — 99.3%. A parcel the model narrates
 * as shedding cannot also be almost entirely under water.
 */
describe("ponding coherence with the catchment narrative (end to end)", () => {
  const HP_GRID = 64;
  const RES = 10;

  /** A broad dome centred on the parcel — every cell has a downslope escape. */
  function highPointDem() {
    const values = new Float32Array(HP_GRID * HP_GRID);
    for (let row = 0; row < HP_GRID; row++) {
      for (let col = 0; col < HP_GRID; col++) {
        const d = Math.hypot((col - HP_GRID / 2) * RES, (row - HP_GRID / 2) * RES);
        values[row * HP_GRID + col] = 140 - d * 0.02 + (col - HP_GRID / 2) * RES * 0.001;
      }
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      width: HP_GRID,
      height: HP_GRID,
      values,
      minElevation: min,
      maxElevation: max,
      nodataCount: 0,
    };
  }

  /** Drive the genuine native D8 backend, not a canned worker payload. */
  const nativeWorker = async (req: HydrologyWorkerRequest): Promise<HydrologyWorkerResult> =>
    runHydrologyNative({
      width: req.width,
      height: req.height,
      elevation: req.elevation,
      catchmentBbox: req.catchmentBbox,
      pourLng: req.pourLng,
      pourLat: req.pourLat,
      rainfallDepthMm: req.rainfallDepthMm,
      accumulationThreshold: req.accumulationThreshold,
    }) as HydrologyWorkerResult;

  it("a shedding high point cannot report near-total parcel ponding", async () => {
    const { fn: fetchDem } = fakeFetchDem();
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem,
      parseDem: async () => highPointDem(),
      runWorker: nativeWorker,
      fetchRainfall: failingRainfall,
      rainfallDepthInches: DEFAULT_RAINFALL_DEPTH_INCHES,
    });

    const parcelSqFt = ringAreaSqFtLocal(ringWgs84);
    expect(parcelSqFt).toBeGreaterThan(0);

    // Every cell of this dome has a downslope escape, so nothing impounds.
    // THE COHERENCE ASSERTION: a parcel the model shows as shedding is not
    // almost entirely under water. The pre-fix live value was 99.3% of parcel.
    expect(study.stats.pondedAreaSqFt).not.toBeNull();
    expect(study.stats.pondedAreaSqFt! / parcelSqFt).toBeLessThan(0.1);

    // And the briefing agrees with the stat rather than contradicting it.
    expect(study.briefing).toContain("no modeled ponding intersects the parcel");
    expect(study.briefing).not.toMatch(/modeled ponding covers/);
  });

  it("a negligible catchment plus ponding is narrated coherently, never as delivered runoff", () => {
    // The exact live 48021:36249 shape: high-point narration AND a large
    // ponding figure in the same study. The briefing must not read as a
    // contradiction even if a future model produces this combination.
    const negligible = negligibleCatchmentThresholdSqFt(10);
    const briefing = buildFloodDrainageBriefing({
      stats: {
        catchmentAreaSqFt: negligible - 1,
        pondedAreaSqFt: 396_134,
        pondedAreaModeledRegionSqFt: 396_134,
        flowExitCount: 0,
        pourPoint: { lng: -97.319, lat: 30.101 },
        pourPointMethod: "lowest-boundary-cell",
      },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(briefing).toContain("local high point");
    expect(briefing).toContain("held in local depressions on the parcel itself");
    expect(briefing).not.toMatch(
      /modeled ponding covers about [\d.]+ acres on the parcel\./,
    );
  });

  it("still reports substantial ponding on a genuine depression — not a clamp", async () => {
    // Same parcel and ring, but the terrain is a closed basin around it.
    function bowlDem() {
      const values = new Float32Array(HP_GRID * HP_GRID);
      for (let row = 0; row < HP_GRID; row++) {
        for (let col = 0; col < HP_GRID; col++) {
          const d = Math.hypot(col - HP_GRID / 2, row - HP_GRID / 2);
          values[row * HP_GRID + col] =
            d < HP_GRID / 3 ? 100 - (HP_GRID / 3 - d) * 0.3 : 100 + (d - HP_GRID / 3) * 0.05;
        }
      }
      let min = Infinity;
      let max = -Infinity;
      for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return {
        width: HP_GRID,
        height: HP_GRID,
        values,
        minElevation: min,
        maxElevation: max,
        nodataCount: 0,
      };
    }

    const { fn: fetchDem } = fakeFetchDem();
    const { study } = await runFloodDrainageStudy({
      parcelNodeId,
      resolver,
      fetchDem,
      parseDem: async () => bowlDem(),
      runWorker: nativeWorker,
      fetchRainfall: failingRainfall,
      rainfallDepthInches: DEFAULT_RAINFALL_DEPTH_INCHES,
    });

    // The parcel sits in the basin floor, so real ponding must be reported.
    expect(study.stats.pondedAreaModeledRegionSqFt).not.toBeNull();
    expect(study.stats.pondedAreaModeledRegionSqFt!).toBeGreaterThan(0);
  });
});

describe("buildFloodDrainageBriefing (narration honesty)", () => {
  const baseStats: FloodDrainageStudyStats = {
    catchmentAreaSqFt: 0,
    pondedAreaSqFt: 0,
    pondedAreaModeledRegionSqFt: 0,
    flowExitCount: 0,
    pourPoint: { lng: -97.319, lat: 30.101 },
    pourPointMethod: "max-accumulation-on-parcel",
  };

  it("says the parcel sits near a local high point on a ~0 catchment — NEVER '0 square feet delivers runoff toward'", () => {
    const briefing = buildFloodDrainageBriefing({
      stats: baseStats,
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(briefing).toContain("local high point");
    expect(briefing).toContain("negligible upstream catchment");
    // The 2026-07-29 operator canary (live 1408 Chestnut): incoherent
    // "catchment of about 0 square feet delivers runoff toward the parcel".
    expect(briefing).not.toMatch(/about 0 (square feet|acres)/);
    expect(briefing).not.toContain("delivers runoff toward the parcel's low point");
    // §11 hygiene holds.
    expect(briefing).not.toContain(":");
  });

  it("uses the resolution-scaled negligible threshold: a few cells is negligible, a real catchment is not", () => {
    const threshold = negligibleCatchmentThresholdSqFt(10);
    expect(threshold).toBeGreaterThan(4_000);
    expect(threshold).toBeLessThan(5_000);
    const negligible = buildFloodDrainageBriefing({
      stats: { ...baseStats, catchmentAreaSqFt: threshold - 1 },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(negligible).toContain("negligible upstream catchment");
    const real = buildFloodDrainageBriefing({
      stats: { ...baseStats, catchmentAreaSqFt: 250_000 },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(real).toContain("delivers runoff toward the parcel's low point");
    expect(real).not.toContain("negligible upstream catchment");
  });

  /**
   * THE CONTRADICTION BAN (2026-07-30). The live 48021:36249 briefing said, in
   * consecutive sentences, that the parcel "sits at or near a local high point,
   * so negligible upstream catchment delivers runoff onto it and rainfall
   * landing on the parcel drains away from it" AND that "modeled ponding covers
   * about 9.1 acres on the parcel" — on a 9.2 acre parcel. Those cannot both be
   * true as written. The criterion fix stops the combination arising; this test
   * bans the SENTENCES from ever contradicting each other again.
   */
  it("cannot narrate a shedding high point and large delivered ponding at once", () => {
    const parcelSqFt = 398_813; // the live ~9.2 acre parcel
    const briefing = buildFloodDrainageBriefing({
      stats: {
        ...baseStats,
        catchmentAreaSqFt: 0, // negligible → the high-point narration
        pondedAreaSqFt: 396_134, // the live (wrong) figure
      },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(briefing).toContain("local high point");
    // If ponding is narrated alongside the high point, it MUST be qualified as
    // on-parcel depression storage, never as delivered upstream runoff.
    expect(briefing).toContain("held in local depressions on the parcel itself");
    expect(briefing).toContain("rather than fed by upstream runoff");
    // The bare unqualified sentence is what read as a contradiction.
    expect(briefing).not.toMatch(
      /modeled ponding covers about [\d.]+ acres on the parcel\./,
    );
    void parcelSqFt;
    expect(briefing).not.toContain(":");
  });

  it("still narrates ponding plainly when the parcel actually receives runoff", () => {
    const briefing = buildFloodDrainageBriefing({
      stats: {
        ...baseStats,
        catchmentAreaSqFt: 250_000, // a real catchment
        pondedAreaSqFt: 40_000,
      },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    expect(briefing).toContain("delivers runoff toward the parcel's low point");
    // No high point, so no qualifier — the plain sentence is correct here.
    expect(briefing).toContain("modeled ponding covers about 0.9 acres on the parcel.");
    expect(briefing).not.toContain("held in local depressions");
  });

  /**
   * The number is never suppressed or clamped to look nice — the guard changes
   * the WORDING, not the magnitude. A genuinely flooding parcel still reports.
   */
  it("never suppresses a large ponding figure — it qualifies it", () => {
    const briefing = buildFloodDrainageBriefing({
      stats: { ...baseStats, catchmentAreaSqFt: 0, pondedAreaSqFt: 396_134 },
      rainfallDepthInches: 9.5,
      demProvenance: { resolutionMeters: 10 },
    });
    // 396,134 sq ft ≈ 9.1 acres — still stated, just honestly framed.
    expect(briefing).toContain("about 9.1 acres");
  });
});

describe("deriveDrainageZones", () => {
  const catchment: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [quad(0, 0, 1, { zone: "catchment" }), quad(10, 10, 1, { zone: "catchment" })],
  };
  const flow: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0.1, 0.1],
            [0.4, 0.4],
            [0.7, 0.7],
          ],
        },
        properties: {},
      },
    ],
  };

  it("passes the backend's THREE NESTED bands through, ordered low to high for paint order", () => {
    // With dissolved regions the catchment is a handful of large polygons, so
    // counting flow-line vertices per polygon would grade everything "high".
    // The bands come from the model's own accumulation grid instead.
    const bands: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        quad(0, 0, 0.4, { concentration: 2, concentrationBasis: "acc >= 900" }),
        quad(0, 0, 1, { concentration: 0, concentrationBasis: "modeled catchment extent" }),
        quad(0, 0, 0.7, { concentration: 1, concentrationBasis: "acc >= 300" }),
      ],
    };
    const zones = deriveDrainageZones(catchment, flow, bands);
    expect(zones.features.length).toBe(3);
    expect(
      zones.features.map((f) => (f.properties as { concentration: number }).concentration),
    ).toEqual([0, 1, 2]);
    // Every band keeps its derivation basis — never an unexplained number.
    for (const f of zones.features) {
      expect((f.properties as { concentrationBasis?: string }).concentrationBasis).toBeTruthy();
    }
  });

  it("falls back to the catchment as band 0 — never invents a medium or high band", () => {
    const zones = deriveDrainageZones(catchment, flow, null);
    expect(zones.features.length).toBe(2);
    for (const f of zones.features) {
      const props = f.properties as { concentration: number; concentrationBasis: string };
      expect(props.concentration).toBe(0);
      expect(props.concentrationBasis).toBe("modeled catchment extent");
    }
  });

  it("treats an EMPTY band collection as no bands rather than an empty overlay", () => {
    const zones = deriveDrainageZones(catchment, flow, {
      type: "FeatureCollection",
      features: [],
    });
    expect(zones.features.length).toBe(2);
    expect(
      zones.features.every(
        (f) => (f.properties as { concentration: number }).concentration === 0,
      ),
    ).toBe(true);
  });
});
