import { describe, it, expect, vi } from "vitest";

import { resolveContourSource } from "../contour-source.js";
import type { ParsedDem } from "../../site-topography/index.js";
import type { BboxWgs84 } from "@hauska-engine/adapters";

const BASTROP_BBOX: BboxWgs84 = {
  westLng: -97.35,
  southLat: 30.41,
  eastLng: -97.34,
  northLat: 30.43,
};

const MOAB_BBOX: BboxWgs84 = {
  westLng: -109.5625,
  southLat: 38.5675,
  eastLng: -109.5375,
  northLat: 38.5775,
};

/** A trivial DEM — only used by the 3DEP-derived fallback path. */
function fakeDem(): ParsedDem {
  const width = 4;
  const height = 4;
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = 150 + i;
  return { width, height, values, minElevation: 150, maxElevation: 165, nodataCount: 0 };
}

describe("resolveContourSource", () => {
  it("falls back to 3DEP-derived contours outside the Bastrop footprint", async () => {
    const collectDerived = vi.fn(() => [
      { elevation: 1500, points: [[0, 0], [1, 1]] as Array<[number, number]> },
    ]);
    const fetchCounty = vi.fn();
    const result = await resolveContourSource({
      dem: fakeDem(),
      bbox: MOAB_BBOX,
      contourIntervalMeters: 1,
      fetchCountyContours: fetchCounty as never,
      collectDerived: collectDerived as never,
    });
    expect(fetchCounty).not.toHaveBeenCalled();
    expect(collectDerived).toHaveBeenCalledOnce();
    expect(result.provenance.tier).toBe("derived-3dep");
    expect(result.provenance.source).toBe("usgs:3dep-dem");
    expect(result.provenance.fallbackReason).toMatch(/outside Bastrop/i);
  });

  it("uses authoritative 1-ft county contours where covered, projected to local-ENU", async () => {
    const fetchCounty = vi.fn(async () => ({
      polylines: [
        {
          elevationMeters: 168.25,
          elevationFeet: 552,
          index: true,
          points: [
            [-97.347, 30.421],
            [-97.348, 30.422],
          ] as Array<[number, number]>,
        },
      ],
      featureCount: 1,
      pagesFetched: 1,
      elapsedMs: 5,
      sourceUrl: "x",
      source: "bastrop-county:Contour1Ft2017",
      vintage: "2017 StratMap LiDAR",
      intervalLabel: "1-ft vertical interval",
      verticalUnitConverted: "us-survey-foot->metre" as const,
      bbox: BASTROP_BBOX,
    }));
    const collectDerived = vi.fn();
    const result = await resolveContourSource({
      dem: fakeDem(),
      bbox: BASTROP_BBOX,
      contourIntervalMeters: 1,
      fetchCountyContours: fetchCounty as never,
      collectDerived: collectDerived as never,
    });
    expect(fetchCounty).toHaveBeenCalledOnce();
    expect(collectDerived).not.toHaveBeenCalled();
    expect(result.provenance.tier).toBe("authoritative-1ft");
    expect(result.provenance.source).toBe("bastrop-county:Contour1Ft2017");
    expect(result.polylines).toHaveLength(1);
    // Elevation carried through unchanged (already metres).
    expect(result.polylines[0]!.elevation).toBeCloseTo(168.25, 6);
    // Points projected to local-ENU: origin (SW corner) maps near (0,0)-ish;
    // x/y are metres, finite, and not the raw lng/lat.
    for (const [x, y] of result.polylines[0]!.points) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Math.abs(x)).toBeLessThan(1e5);
    }
  });

  it("degrades to 3DEP with a recorded reason when the county fetch fails", async () => {
    const fetchCounty = vi.fn(async () => {
      throw new Error("upstream 503");
    });
    const collectDerived = vi.fn(() => [
      { elevation: 150, points: [[0, 0], [1, 1]] as Array<[number, number]> },
    ]);
    const result = await resolveContourSource({
      dem: fakeDem(),
      bbox: BASTROP_BBOX,
      contourIntervalMeters: 1,
      fetchCountyContours: fetchCounty as never,
      collectDerived: collectDerived as never,
    });
    expect(result.provenance.tier).toBe("derived-3dep");
    expect(result.provenance.fallbackReason).toMatch(/503/);
    expect(collectDerived).toHaveBeenCalledOnce();
  });

  it("degrades to 3DEP when the county service returns no contours for the bbox", async () => {
    const fetchCounty = vi.fn(async () => ({
      polylines: [],
      featureCount: 0,
      pagesFetched: 1,
      elapsedMs: 1,
      sourceUrl: "x",
      source: "bastrop-county:Contour1Ft2017",
      vintage: "2017 StratMap LiDAR",
      intervalLabel: "1-ft vertical interval",
      verticalUnitConverted: "us-survey-foot->metre" as const,
      bbox: BASTROP_BBOX,
    }));
    const collectDerived = vi.fn(() => [
      { elevation: 150, points: [[0, 0], [1, 1]] as Array<[number, number]> },
    ]);
    const result = await resolveContourSource({
      dem: fakeDem(),
      bbox: BASTROP_BBOX,
      contourIntervalMeters: 1,
      fetchCountyContours: fetchCounty as never,
      collectDerived: collectDerived as never,
    });
    expect(result.provenance.tier).toBe("derived-3dep");
    expect(result.provenance.fallbackReason).toMatch(/no contours/i);
  });
});
