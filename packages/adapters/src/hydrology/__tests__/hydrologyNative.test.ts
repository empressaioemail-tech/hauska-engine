import { describe, it, expect } from "vitest";
import {
  runHydrologyNative,
  deriveConcentrationBands,
  accumulationThresholdForResolution,
  ACCUMULATION_THRESHOLD_BASE_CELLS,
} from "../hydrologyNative.js";

describe("runHydrologyNative", () => {
  it("produces drainage zones and flow lines on a sloped grid", () => {
    const width = 12;
    const height = 12;
    const elevation = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        elevation[row * width + col] = 100 + col * 0.5 + row * 0.2;
      }
    }
    const result = runHydrologyNative({
      width,
      height,
      elevation,
      catchmentBbox: {
        westLng: -97.68,
        southLat: 30.5,
        eastLng: -97.67,
        northLat: 30.51,
      },
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 101.6,
      accumulationThreshold: 2,
    });
    expect(result.status).toBe("ok");
    expect(result.drainageZonesGeoJson.features.length).toBeGreaterThan(0);
    expect(result.flowLinesGeoJson.features.length).toBeGreaterThan(0);
    expect(result.rainfallResultGeoJson?.features.length).toBeGreaterThan(0);
  });

  it("emits DISSOLVED regions, not one square per subsampled cell", () => {
    // A bowl: a broad basin that drains to the centre, so the catchment mask
    // is a large contiguous blob. The OLD converter emitted one axis-aligned
    // square per sampled cell at step = min(w,h)/12; the dissolved converter
    // emits a handful of traced polygons for the same mask.
    const width = 48;
    const height = 48;
    const elevation = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const dx = col - 24;
        const dy = row - 24;
        elevation[row * width + col] = 100 + (dx * dx + dy * dy) * 0.01 + col * 0.001;
      }
    }
    const bbox = { westLng: -97.68, southLat: 30.5, eastLng: -97.67, northLat: 30.51 };
    const result = runHydrologyNative({
      width,
      height,
      elevation,
      catchmentBbox: bbox,
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 101.6,
      accumulationThreshold: 5,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const zones = result.drainageZonesGeoJson.features;
    expect(zones.length).toBeGreaterThan(0);
    // Dissolved: a handful of features for a mask of hundreds of cells.
    expect(zones.length).toBeLessThan(20);

    for (const feature of zones) {
      const ring = (feature.geometry.coordinates as Array<Array<[number, number]>>)[0]!;
      // No feature is a bare 5-point axis-aligned square (the lattice
      // signature); a traced region carries a real boundary.
      const isSquare =
        ring.length === 5 &&
        ring[0]![1] === ring[1]![1] &&
        ring[1]![0] === ring[2]![0] &&
        ring[2]![1] === ring[3]![1];
      expect(isSquare).toBe(false);
    }
  });
});

describe("deriveConcentrationBands", () => {
  const bbox = { westLng: -97.68, southLat: 30.5, eastLng: -97.67, northLat: 30.51 };
  const W = 30;
  const H = 30;

  it("emits three NESTED bands from the accumulation grid, ordered low to high", () => {
    const mask = new Uint8Array(W * H).fill(1);
    const acc = new Uint32Array(W * H);
    // A radial accumulation field: highest at the centre, so the 70th and
    // 90th percentile bands are concentric discs inside the full extent.
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const d = Math.hypot(col - 15, row - 15);
        acc[row * W + col] = Math.max(0, Math.round(400 - d * 20));
      }
    }
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox, { library: "test" });
    const bands = fc.features.map(
      (f) => (f.properties as { concentration: number }).concentration,
    );
    expect(new Set(bands)).toEqual(new Set([0, 1, 2]));

    // NESTING: each higher band encloses strictly less area than the one
    // below it — three concentration rings, not three copies of the extent.
    const areaOf = (concentration: number): number => {
      let total = 0;
      for (const f of fc.features) {
        if ((f.properties as { concentration: number }).concentration !== concentration) continue;
        const ring = (f.geometry.coordinates as Array<Array<[number, number]>>)[0]!;
        let sum = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
        }
        total += Math.abs(sum / 2);
      }
      return total;
    };
    expect(areaOf(0)).toBeGreaterThan(areaOf(1));
    expect(areaOf(1)).toBeGreaterThan(areaOf(2));

    // Every band carries the derivation basis — never an unexplained number.
    for (const f of fc.features) {
      expect((f.properties as { concentrationBasis?: string }).concentrationBasis).toBeTruthy();
    }
  });

  it("emits only band 0 on a flat accumulation field — never a fabricated band", () => {
    const mask = new Uint8Array(W * H).fill(1);
    const acc = new Uint32Array(W * H).fill(7); // every quantile is the same
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox);
    const bands = new Set(
      fc.features.map((f) => (f.properties as { concentration: number }).concentration),
    );
    expect(bands).toEqual(new Set([0]));
  });

  it("returns nothing for an empty catchment mask", () => {
    const fc = deriveConcentrationBands(
      new Uint8Array(W * H),
      new Uint32Array(W * H),
      W,
      H,
      bbox,
    );
    expect(fc.features.length).toBe(0);
  });
});

describe("accumulationThresholdForResolution", () => {
  it("stays at the 50-cell base at the 10m reference resolution", () => {
    expect(accumulationThresholdForResolution(10)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });

  it("scales quadratically finer so channel density is resolution-invariant", () => {
    // Same PHYSICAL drainage-area cutoff: threshold * res^2 is constant.
    expect(accumulationThresholdForResolution(1)).toBe(5000); // 50 * 10^2
    expect(accumulationThresholdForResolution(2)).toBe(1250); // 50 * 5^2
    expect(accumulationThresholdForResolution(5)).toBe(200); // 50 * 2^2
  });

  it("never drops below the base for coarse DEMs (min 50)", () => {
    expect(accumulationThresholdForResolution(30)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });

  it("falls back to the base on degenerate resolutions", () => {
    expect(accumulationThresholdForResolution(0)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
    expect(accumulationThresholdForResolution(-1)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
    expect(accumulationThresholdForResolution(Number.NaN)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });
});
