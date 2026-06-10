import { describe, expect, it } from "vitest";
import { deriveContoursGeoJson, type ParsedDem } from "../derivation.js";

function syntheticDem(
  width: number,
  height: number,
  fn: (x: number, y: number) => number,
): ParsedDem {
  const values = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      values[y * width + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    width,
    height,
    values,
    minElevation: min,
    maxElevation: max,
    nodataCount: 0,
  };
}

describe("deriveContoursGeoJson", () => {
  const bbox = {
    westLng: -97.8,
    southLat: 30.1,
    eastLng: -97.7,
    northLat: 30.2,
  };

  it("produces contour features for a sloped DEM", () => {
    const dem = syntheticDem(20, 20, (x) => 100 + x * 2);
    const result = deriveContoursGeoJson(dem, bbox, 10);
    expect(result.thresholds.length).toBeGreaterThan(0);
    expect(result.featureCollection.features.length).toBeGreaterThan(0);
    expect(result.featureCollection.features[0]?.properties.elevationMeters).toBe(
      result.thresholds[0],
    );
  });

  it("returns empty collection when elevation range is narrower than interval", () => {
    const dem = syntheticDem(10, 10, () => 100.5);
    const result = deriveContoursGeoJson(dem, bbox, 10);
    expect(result.thresholds).toHaveLength(0);
    expect(result.featureCollection.features).toHaveLength(0);
  });

  it("remaps contour coordinates into WGS84 bbox", () => {
    const dem = syntheticDem(10, 10, (x, y) => 100 + x + y);
    const result = deriveContoursGeoJson(dem, bbox, 5);
    const coords =
      result.featureCollection.features[0]?.geometry.coordinates[0]?.[0]?.[0];
    expect(coords).toBeDefined();
    expect(coords![0]).toBeGreaterThanOrEqual(bbox.westLng);
    expect(coords![0]).toBeLessThanOrEqual(bbox.eastLng);
    expect(coords![1]).toBeGreaterThanOrEqual(bbox.southLat);
    expect(coords![1]).toBeLessThanOrEqual(bbox.northLat);
  });
});
