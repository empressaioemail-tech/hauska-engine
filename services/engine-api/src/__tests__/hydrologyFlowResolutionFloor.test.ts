/**
 * Hydrology resolution floor + resolution-scaled accumulation threshold
 * (fix/hydrology-resolution-floor, 2026-07-28).
 *
 * REGRESSION UNDER TEST: the topo-fidelity swap made the shared map raster
 * plan resolve 1m at parcel scale. Terrain slots want that; the hydrology-flow
 * slot does NOT — a 1m DEM is ~100x the cells of 10m, and with the D8
 * accumulation threshold fixed at 50 CELLS the flow-seed count exploded
 * ~100x, pushing the pysheds worker past PE's 60s proxy budget → HTTP 504
 * ("Flow lines degraded — hydrology: HTTP 504").
 *
 * Pinned here:
 *  - resolveHydrologyRasterPlan clamps the shared plan's resolution UP to the
 *    floor (default 10m, env HYDROLOGY_MIN_RESOLUTION_METERS) and recomputes
 *    the pixel grid, so the DEM FETCH is sized at the clamped resolution.
 *  - Tiny viewports relax the floor finer (never under the DEM client's 16px
 *    minimum axis); no-fit (zoomed-out) plans pass through unchanged.
 *  - The slot passes a resolution-scaled accumulation threshold to the
 *    hydrology worker (both pysheds + native receive it via the same field).
 *  - METADATA HONESTY: the slot reports the ACTUAL clamped resolution used
 *    (`resolutionMetersAdapted`), the active floor, and the worker wall time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MapLayersAssembleRequest } from "@hauska-engine/engine-core/map-layers";
import {
  accumulationThresholdForResolution,
  type HydrologyWorkerResult,
} from "@hauska-engine/adapters/hydrology";
import {
  resolveMapLayerRasterPlan,
  resolveHydrologyRasterPlan,
  resolveHydrologyMinResolutionMeters,
  HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT,
} from "../lib/mapLayerBboxGuard.js";

// Partial-mock the hydrology adapter: the worker is stubbed (no pysheds/D8
// compute in unit tests) but the threshold helper stays REAL.
vi.mock("@hauska-engine/adapters/hydrology", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hauska-engine/adapters/hydrology")>();
  return {
    ...actual,
    runHydrologyWorker: vi.fn(),
  };
});

// Partial-mock DEM parsing: the fetch stub returns dummy bytes, so parsing is
// stubbed to a plausible grid; everything else in site-topography stays real.
vi.mock("@hauska-engine/engine-core/site-topography", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@hauska-engine/engine-core/site-topography")
    >();
  return {
    ...actual,
    parseDemBytes: vi.fn(),
  };
});

import { runHydrologyWorker } from "@hauska-engine/adapters/hydrology";
import { parseDemBytes } from "@hauska-engine/engine-core/site-topography";
import { resolveWave3MapLayerSlot } from "../lib/mapLayersWave3.js";

const EMPTY_OUTCOMES = new Map();

// Gold-parcel viewport bbox in Bastrop County (~0.4 km per side) — small
// enough that the SHARED plan resolves the 1m rung (the pre-fix exposure).
const bastropBbox = {
  westLng: -97.322,
  southLat: 30.108,
  eastLng: -97.318,
  northLat: 30.112,
};

// Zoomed-out viewport (~60 km per side) — over budget even at 30m.
const zoomedOutBbox = {
  westLng: -97.6,
  southLat: 30.0,
  eastLng: -97.0,
  northLat: 30.5,
};

// Tiny viewport (~67m per side): 10m floor would give a <16px raster, which
// the DEM client rejects (raster-too-small) — the floor must relax finer.
const tinyBbox = {
  westLng: -97.3203,
  southLat: 30.1097,
  eastLng: -97.3197,
  northLat: 30.1103,
};

function requestFor(bbox: typeof bastropBbox): MapLayersAssembleRequest {
  return {
    parcel: {
      latitude: (bbox.southLat + bbox.northLat) / 2,
      longitude: (bbox.westLng + bbox.eastLng) / 2,
      parcelKey: "test-parcel",
    },
    jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
    bbox,
  };
}

function okWorkerResult(threshold: number): HydrologyWorkerResult {
  return {
    status: "ok",
    library: "native-d8",
    libraryVersion: "1.0.0",
    routing: "d8",
    accumulationThreshold: threshold,
    drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
    flowLinesGeoJson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-97.32, 30.109],
              [-97.319, 30.11],
            ],
          },
          properties: { accumulation: threshold + 1 },
        },
      ],
    },
    rainfallResultGeoJson: null,
    pourPoint: { lng: -97.32, lat: 30.11 },
  };
}

beforeEach(() => {
  vi.mocked(runHydrologyWorker).mockReset();
  vi.mocked(parseDemBytes).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HYDROLOGY_MIN_RESOLUTION_METERS;
});

describe("resolveHydrologyMinResolutionMeters", () => {
  it("defaults to 10m when the env var is unset or degenerate", () => {
    expect(resolveHydrologyMinResolutionMeters({})).toBe(
      HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT,
    );
    expect(
      resolveHydrologyMinResolutionMeters({
        HYDROLOGY_MIN_RESOLUTION_METERS: "not-a-number",
      }),
    ).toBe(HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT);
    expect(
      resolveHydrologyMinResolutionMeters({
        HYDROLOGY_MIN_RESOLUTION_METERS: "0",
      }),
    ).toBe(HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT);
  });

  it("is env-tunable, clamped to [1, 30]", () => {
    expect(
      resolveHydrologyMinResolutionMeters({
        HYDROLOGY_MIN_RESOLUTION_METERS: "5",
      }),
    ).toBe(5);
    expect(
      resolveHydrologyMinResolutionMeters({
        HYDROLOGY_MIN_RESOLUTION_METERS: "100",
      }),
    ).toBe(30);
    expect(
      resolveHydrologyMinResolutionMeters({
        HYDROLOGY_MIN_RESOLUTION_METERS: "0.25",
      }),
    ).toBe(1);
  });
});

describe("resolveHydrologyRasterPlan (resolution floor)", () => {
  it("clamps a parcel-scale 1m shared plan UP to the 10m floor with recomputed pixels", () => {
    const shared = resolveMapLayerRasterPlan(bastropBbox);
    expect(shared.fit).toBe(true);
    if (!shared.fit) return;
    // Pin the exposure: the SHARED plan resolves 1m here (topo fidelity).
    expect(shared.resolutionMeters).toBe(1);

    const hydro = resolveHydrologyRasterPlan(bastropBbox, {});
    expect(hydro.fit).toBe(true);
    if (!hydro.fit) return;
    expect(hydro.resolutionMeters).toBe(10);
    // Pixel grid recomputed at the clamped resolution — ~1/10 per axis,
    // ~1/100 the cells of the 1m fetch.
    expect(hydro.widthPx).toBeLessThan(shared.widthPx / 5);
    expect(hydro.heightPx).toBeLessThan(shared.heightPx / 5);
    expect(hydro.widthPx).toBeGreaterThanOrEqual(16);
    expect(hydro.heightPx).toBeGreaterThanOrEqual(16);
  });

  it("honors an env-tuned floor", () => {
    const hydro = resolveHydrologyRasterPlan(bastropBbox, {
      HYDROLOGY_MIN_RESOLUTION_METERS: "5",
    });
    expect(hydro.fit).toBe(true);
    if (hydro.fit) expect(hydro.resolutionMeters).toBe(5);
  });

  it("leaves a plan already at/above the floor unchanged", () => {
    const hydro = resolveHydrologyRasterPlan(bastropBbox, {
      HYDROLOGY_MIN_RESOLUTION_METERS: "1",
    });
    const shared = resolveMapLayerRasterPlan(bastropBbox);
    expect(hydro).toEqual(shared);
  });

  it("passes a no-fit (zoomed-out) plan through unchanged", () => {
    const hydro = resolveHydrologyRasterPlan(zoomedOutBbox, {});
    expect(hydro.fit).toBe(false);
  });

  it("relaxes the floor FINER for a tiny viewport so the raster clears the 16px DEM minimum", () => {
    const hydro = resolveHydrologyRasterPlan(tinyBbox, {});
    expect(hydro.fit).toBe(true);
    if (!hydro.fit) return;
    // 10m over ~67m of extent would be ~7px — under the DEM client's 16px
    // minimum axis (fetch would throw raster-too-small). The plan must pick a
    // finer rung that clears 16px instead of a doomed 10m fetch.
    expect(hydro.resolutionMeters).toBeLessThan(10);
    expect(hydro.widthPx).toBeGreaterThanOrEqual(16);
    expect(hydro.heightPx).toBeGreaterThanOrEqual(16);
  });
});

describe("hydrology-flow slot (floor + threshold + honest metadata)", () => {
  it("fetches the DEM at the clamped resolution, scales the threshold, and reports honestly", async () => {
    const hydroPlan = resolveHydrologyRasterPlan(bastropBbox);
    expect(hydroPlan.fit).toBe(true);
    if (!hydroPlan.fit) return;
    expect(hydroPlan.resolutionMeters).toBe(10);

    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchedUrls.push(String(url));
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/tiff" },
        });
      }),
    );

    // DEM grid matching the clamped plan; gentle slope, all finite.
    const cells = hydroPlan.widthPx * hydroPlan.heightPx;
    const values = new Float32Array(cells);
    for (let i = 0; i < cells; i++) values[i] = 100 + (i % hydroPlan.widthPx) * 0.1;
    vi.mocked(parseDemBytes).mockResolvedValue({
      width: hydroPlan.widthPx,
      height: hydroPlan.heightPx,
      values,
      minElevation: 100,
      maxElevation: 100 + (hydroPlan.widthPx - 1) * 0.1,
      nodataCount: 0,
    });

    const expectedThreshold = accumulationThresholdForResolution(
      hydroPlan.resolutionMeters,
    );
    vi.mocked(runHydrologyWorker).mockResolvedValue(
      okWorkerResult(expectedThreshold),
    );

    const slot = await resolveWave3MapLayerSlot(
      "hydrology-flow",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    // The DEM FETCH is sized at the CLAMPED resolution, not the shared 1m plan.
    expect(fetchedUrls.length).toBe(1);
    const sizeParam = new URL(fetchedUrls[0]!).searchParams.get("size");
    expect(sizeParam).toBe(`${hydroPlan.widthPx},${hydroPlan.heightPx}`);
    const sharedPlan = resolveMapLayerRasterPlan(bastropBbox);
    if (sharedPlan.fit) {
      expect(sizeParam).not.toBe(`${sharedPlan.widthPx},${sharedPlan.heightPx}`);
    }

    // The worker receives the resolution-scaled threshold (same field feeds
    // both the pysheds payload and the native D8 fallback). At the 10m floor
    // this is the long-standing 50-cell default.
    expect(expectedThreshold).toBe(50);
    expect(vi.mocked(runHydrologyWorker)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(runHydrologyWorker).mock.calls[0]![0].accumulationThreshold,
    ).toBe(expectedThreshold);

    // METADATA HONESTY: the slot reports the ACTUAL clamped resolution used,
    // the active floor, and an observable worker wall time.
    expect(slot.status).toBe("ok");
    const attributes = (
      slot.envelope!.payload as unknown as {
        attributes: {
          resolutionMetersAdapted: number;
          resolutionFloorMeters: number;
          accumulationThreshold: number;
          workerWallMs: number;
          channelCount: number;
        };
      }
    ).attributes;
    expect(attributes.resolutionMetersAdapted).toBe(10);
    expect(attributes.resolutionFloorMeters).toBe(
      HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT,
    );
    expect(attributes.accumulationThreshold).toBe(expectedThreshold);
    expect(typeof attributes.workerWallMs).toBe("number");
    expect(attributes.channelCount).toBe(1);
  });

  it("scales the threshold up when a finer resolution is in play (future finer-res calls)", async () => {
    process.env.HYDROLOGY_MIN_RESOLUTION_METERS = "1";
    const hydroPlan = resolveHydrologyRasterPlan(bastropBbox);
    expect(hydroPlan.fit).toBe(true);
    if (!hydroPlan.fit) return;
    expect(hydroPlan.resolutionMeters).toBe(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "content-type": "image/tiff" },
          }),
      ),
    );
    const cells = hydroPlan.widthPx * hydroPlan.heightPx;
    const values = new Float32Array(cells);
    for (let i = 0; i < cells; i++) values[i] = 100 + (i % hydroPlan.widthPx) * 0.1;
    vi.mocked(parseDemBytes).mockResolvedValue({
      width: hydroPlan.widthPx,
      height: hydroPlan.heightPx,
      values,
      minElevation: 100,
      maxElevation: 100 + (hydroPlan.widthPx - 1) * 0.1,
      nodataCount: 0,
    });
    vi.mocked(runHydrologyWorker).mockResolvedValue(okWorkerResult(5000));

    await resolveWave3MapLayerSlot(
      "hydrology-flow",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    // 1m cells: same physical cutoff = 50 * (10/1)^2 = 5000 cells.
    expect(
      vi.mocked(runHydrologyWorker).mock.calls[0]![0].accumulationThreshold,
    ).toBe(5000);
  });
});
