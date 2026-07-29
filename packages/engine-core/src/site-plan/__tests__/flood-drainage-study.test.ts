import { describe, expect, it } from "vitest";

import type {
  GeoJsonFeatureCollection,
  HydrologyWorkerRequest,
  HydrologyWorkerResult,
} from "@hauska-engine/adapters/hydrology";
import { accumulationThresholdForResolution } from "@hauska-engine/adapters/hydrology";

import {
  DEFAULT_DRAINAGE_RESOLUTION_METERS,
  DEFAULT_RAINFALL_DEPTH_INCHES,
  HONEST_EMPTY_FLAT_TERRAIN,
  MIN_DRAINAGE_RESOLUTION_METERS,
  deriveDrainageZones,
  paddedCatchmentBbox,
  pointInRing,
  resolveFlowExits,
  runFloodDrainageStudy,
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
      // Covers the flow-line start vertex → grades to concentration ≥ 1.
      quad(-97.3192, 30.1008, 0.0004, { zone: "catchment" }),
      quad(-97.3202, 30.101, 0.0004, { zone: "catchment" }),
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
    features: [quad(-97.3192, 30.1008, 0.0002, { rainfallDepthMm: 241 })],
  };
  return {
    status: "ok",
    library: "pysheds",
    libraryVersion: "0.3",
    routing: "d8",
    accumulationThreshold: 50,
    drainageZonesGeoJson: catchment,
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
    // Zones are the catchment cells re-graded by REAL flow-vertex density.
    expect(study.drainageZonesGeoJson.features.length).toBe(2);
    const concentrations = study.drainageZonesGeoJson.features.map(
      (f) => (f.properties as { concentration: number }).concentration,
    );
    expect(Math.max(...concentrations)).toBeGreaterThanOrEqual(1);
    expect(study.rainfallResultGeoJson?.features.length).toBe(1);
    expect(study.flowLinesGeoJson.features.length).toBe(1);
    // The traced line leaves the ring eastward → exactly one exit.
    expect(study.stats.flowExitCount).toBe(1);
    expect(study.flowExits[0]!.bearingDeg).toBeGreaterThan(45);
    expect(study.flowExits[0]!.bearingDeg).toBeLessThan(135);
    // Areas derive from the real polygons, in square feet.
    expect(study.stats.catchmentAreaSqFt).toBeGreaterThan(0);
    expect(study.stats.pondedAreaSqFt).toBeGreaterThan(0);
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

  it("feeds the worker a pour point inside the parcel ring (the parcel's low cell)", async () => {
    const dem = slopedDem();
    const workerCalls: HydrologyWorkerRequest[] = [];
    await runFloodDrainageStudy({
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
    expect(pointInRing(workerCalls[0]!.pourLng, workerCalls[0]!.pourLat, ringWgs84)).toBe(true);
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
    expect(study.stats.flowExitCount).toBe(0);
    expect(study.briefing).toContain(HONEST_EMPTY_FLAT_TERRAIN);
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

describe("deriveDrainageZones", () => {
  it("grades cells by real flow-vertex density and invents nothing when no flow crosses them", () => {
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
    const zones = deriveDrainageZones(catchment, flow);
    const props = zones.features.map((f) => f.properties as { concentration: number });
    expect(props[0]!.concentration).toBe(2);
    expect(props[1]!.concentration).toBe(0);
  });
});
