import { describe, expect, it } from "vitest";

import {
  assertTerrainElevationIntegrity,
  TERRAIN_VERTICAL_DATUM,
} from "../elevation.js";
import { buildTerrainMeshGeometry } from "../mesh.js";

const bbox = { westLng: -97.1, southLat: 30.1, eastLng: -97.09, northLat: 30.11 };

describe("terrain elevation integrity", () => {
  it("declares NAVD88 orthometric metres", () => {
    expect(TERRAIN_VERTICAL_DATUM.name).toBe("NAVD88");
    expect(TERRAIN_VERTICAL_DATUM.kind).toBe("orthometric");
    expect(TERRAIN_VERTICAL_DATUM.units).toBe("metre");
  });

  it("accepts a mesh whose Z band matches the DEM", () => {
    const dem = {
      width: 3,
      height: 3,
      values: new Float32Array([145, 146, 147, 148, 149, 150, 151, 152, 153]),
      minElevation: 145,
      maxElevation: 153,
      nodataCount: 0,
    };
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const stats = assertTerrainElevationIntegrity(mesh, dem);
    expect(stats.minZ).toBeGreaterThanOrEqual(145);
    expect(stats.maxZ).toBeLessThanOrEqual(153);
  });

  it("rejects a nodata-as-zero spike below real ground", () => {
    const dem = {
      width: 3,
      height: 3,
      values: new Float32Array([145, 146, 147, 148, 149, 150, 151, 152, 153]),
      minElevation: 145,
      maxElevation: 153,
      nodataCount: 0,
    };
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    // Corrupt one vertex to 0.0 — the class of defect surveyors see as a 150 m hole.
    mesh.positions[2] = 0;
    expect(() => assertTerrainElevationIntegrity(mesh, dem)).toThrow(/nodata-as-zero|outside DEM band/);
  });
});
