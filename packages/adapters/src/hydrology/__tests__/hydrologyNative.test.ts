import { describe, it, expect } from "vitest";
import { runHydrologyNative } from "../hydrologyNative.js";

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
