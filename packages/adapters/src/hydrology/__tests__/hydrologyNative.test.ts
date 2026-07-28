import { describe, it, expect } from "vitest";
import {
  runHydrologyNative,
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
