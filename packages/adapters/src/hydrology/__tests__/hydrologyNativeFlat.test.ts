import { describe, expect, it } from "vitest";
import { runHydrologyNative } from "../hydrologyNative.js";

describe("runHydrologyNative flat terrain", () => {
  it("returns error instead of garbage on flat DEM", () => {
    const width = 10;
    const height = 10;
    const elevation = new Float32Array(width * height).fill(100);
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
    });
    expect(result.status).toBe("error");
    expect(result.code).toBe("flat-terrain");
  });
});
