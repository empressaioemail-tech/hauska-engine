import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { authorParcelSitePlanExport, composeSitePlanModelForParcel } from "../author.js";
import { authorParcelFeasibilityExport } from "../feasibility-author.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";

/**
 * End-to-end guard for the narrow-parcel outage.
 *
 * The unit tests in `terrain-window.test.ts` prove the window helper is
 * correct. They do not prove it is WIRED. This file runs the real
 * `composeSitePlanModelForParcel` / `authorParcelSitePlanExport` /
 * `authorParcelFeasibilityExport` with only the network stubbed, so the real
 * `selectAdaptiveResolutionMeters` guard is exercised. On the code this fixes,
 * every test here throws.
 *
 * Parcel geometry is 1007 Water St Unit, Bastrop TX 78602 — approximately
 * 27m x 9m, the parcel from the production report failure.
 */

const CENTER_LAT = 30.1105;
const CENTER_LNG = -97.3153;
const METERS_PER_DEG_LAT = 111_320;
const METERS_PER_DEG_LNG = METERS_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180);

const NARROW_WIDTH_M = 27;
const NARROW_HEIGHT_M = 9;

const halfLng = NARROW_WIDTH_M / 2 / METERS_PER_DEG_LNG;
const halfLat = NARROW_HEIGHT_M / 2 / METERS_PER_DEG_LAT;

const narrowBbox = {
  westLng: CENTER_LNG - halfLng,
  eastLng: CENTER_LNG + halfLng,
  southLat: CENTER_LAT - halfLat,
  northLat: CENTER_LAT + halfLat,
};

// A real closed ring inside the narrow bbox (slightly inset on every side).
const inset = 0.08;
const ringWgs84: Array<[number, number]> = [
  [CENTER_LNG - halfLng * (1 - inset), CENTER_LAT - halfLat * (1 - inset)],
  [CENTER_LNG + halfLng * (1 - inset), CENTER_LAT - halfLat * (1 - inset)],
  [CENTER_LNG + halfLng * (1 - inset), CENTER_LAT + halfLat * (1 - inset)],
  [CENTER_LNG - halfLng * (1 - inset), CENTER_LAT + halfLat * (1 - inset)],
  [CENTER_LNG - halfLng * (1 - inset), CENTER_LAT - halfLat * (1 - inset)],
];

const parcelNodeId = "48021:47595";

const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    120.0, 120.4, 120.8, 121.0, 119.8, 120.2, 120.6, 120.9, 119.5, 119.9, 120.3, 120.7, 119.2,
    119.6, 120.0, 120.4,
  ]),
  minElevation: 119.2,
  maxElevation: 121.0,
  nodataCount: 0,
};

const narrowResolver: ParcelGeometryResolver = {
  async resolve() {
    return {
      bbox: narrowBbox,
      sourceRef: `txgio-parcel:${parcelNodeId}:stratmap25-landparcels_48021_2025`,
      ring: ringWgs84,
    };
  },
};

function fakeArtifactStore(): TerrainArtifactStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(input) {
      const key = `memory://${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
  };
}

/**
 * Records the bbox the DEM was actually requested over, so the test can prove
 * the widened window reached the fetch rather than only the helper.
 */
function recordingFetchDem() {
  const calls: Array<{ westLng: number; eastLng: number; southLat: number; northLat: number }> = [];
  const fn = (async (bboxArg: any, opts: { resolutionMeters: number }) => {
    calls.push(bboxArg);
    return {
      bytes: new Uint8Array(0),
      contentType: "image/tiff",
      bbox: bboxArg,
      resolutionMeters: opts.resolutionMeters,
      resolutionMetersRequested: opts.resolutionMeters,
      resolutionMetersActual: null,
      widthPx: dem.width,
      heightPx: dem.height,
      endpoint: "https://fake.usgs.example/exportImage",
      fetchedAt: new Date().toISOString(),
    };
  }) as any;
  return { fn, calls };
}

const fakeParseDem = async () => dem;
const stubAerialFetch = async (): Promise<Uint8Array> => {
  throw new Error("test stub: no aerial imagery fetch in unit tests");
};
const stubFloodZone = async () => ({
  honestUnavailable: true as const,
  reason: "test stub: no live FEMA NFHL call in this fixture",
});

function baseOptions() {
  const fetchDem = recordingFetchDem();
  return {
    fetchDem,
    options: {
      parcelNodeId,
      resolver: narrowResolver,
      storage: new InMemoryStorage(),
      artifactStore: fakeArtifactStore(),
      fetchAerialImage: stubAerialFetch,
      fetchDem: fetchDem.fn,
      parseDem: fakeParseDem,
      fetchFloodZone: stubFloodZone,
    },
  };
}

describe("narrow parcel (~27m x 9m): the site plan and Feasibility report must exist", () => {
  it("composes a site model instead of throwing the raster-floor decline", async () => {
    const { options } = baseOptions();
    const composed = await composeSitePlanModelForParcel(options as any);
    expect(composed.model).toBeTruthy();
    expect(composed.mesh).toBeTruthy();
  });

  it("declares the widened window rather than reporting a normal export", async () => {
    const { options } = baseOptions();
    const composed = await composeSitePlanModelForParcel(options as any);
    expect(composed.terrainWindowExpanded).toBe(true);
    expect(composed.terrainWindowReason).toMatch(/north-south from 9\.0m to 16m/);
  });

  it("WIRING: the widened bbox is what actually reached the DEM fetch", async () => {
    // Guards the dormant-mechanism case: a correct helper whose result is
    // computed and then not used would pass every unit test in the sibling
    // file and still leave production broken.
    const { fetchDem, options } = baseOptions();
    await composeSitePlanModelForParcel(options as any);
    expect(fetchDem.calls).toHaveLength(1);
    const used = fetchDem.calls[0]!;
    const usedHeightM = (used.northLat - used.southLat) * METERS_PER_DEG_LAT;
    expect(usedHeightM).toBeCloseTo(16, 3);
    // The long axis was NOT touched.
    const usedWidthM = (used.eastLng - used.westLng) * METERS_PER_DEG_LNG;
    expect(usedWidthM).toBeCloseTo(NARROW_WIDTH_M, 3);
  });

  it("authors real DXF/IFC/PDF site-plan artifacts for the narrow parcel", async () => {
    const { options } = baseOptions();
    const result = await authorParcelSitePlanExport(options as any);
    expect(result.atom.artifacts["dxf-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["ifc-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["pdf-site-plan"]?.byteCount).toBeGreaterThan(0);
  });

  it("records the expansion on the atom's coverage, so it is not silent", async () => {
    const { options } = baseOptions();
    const result = await authorParcelSitePlanExport(options as any);
    const coverage = result.atom.coverage as Record<string, unknown>;
    expect(coverage.terrainWindowExpanded).toBe(true);
    expect(String(coverage.terrainWindowReason)).toMatch(/extend past the property line/i);
  });

  it("produces a Feasibility PDF, which previously failed closed on this parcel", async () => {
    const { options } = baseOptions();
    const result = await authorParcelFeasibilityExport(options as any);
    expect(result.sitePlanAppended).toBe(true);
    expect(result.sitePlanUnavailableReason).toBeUndefined();
    expect(result.pageCount).toBeGreaterThan(0);
  });
});
