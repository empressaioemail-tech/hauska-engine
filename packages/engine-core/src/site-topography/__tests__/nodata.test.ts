import { describe, expect, it } from "vitest";
import { deriveContoursGeoJson, type ParsedDem } from "../derivation.js";

describe("deriveContoursGeoJson nodata", () => {
  it("does not emit spurious contours along nodata boundaries", () => {
    const width = 20;
    const height = 20;
    const values = new Float32Array(width * height);
    let min = Infinity;
    let max = -Infinity;
    let nodataCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x < 5) {
          values[i] = Number.NaN;
          nodataCount++;
        } else {
          values[i] = 100 + x;
          min = Math.min(min, values[i]!);
          max = Math.max(max, values[i]!);
        }
      }
    }
    const dem: ParsedDem = {
      width,
      height,
      values,
      minElevation: min,
      maxElevation: max,
      nodataCount,
    };
    const bbox = {
      westLng: -97.8,
      southLat: 30.1,
      eastLng: -97.7,
      northLat: 30.2,
    };
    const result = deriveContoursGeoJson(dem, bbox, 5);
    expect(result.featureCollection.features.length).toBeGreaterThan(0);
    for (const feature of result.featureCollection.features) {
      expect(feature.properties.elevationMeters).toBeGreaterThanOrEqual(100);
    }
  });
});
