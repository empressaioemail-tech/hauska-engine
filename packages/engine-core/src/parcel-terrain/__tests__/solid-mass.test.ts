import { describe, expect, it } from "vitest";

import { buildTerrainMeshGeometry } from "../mesh.js";
import {
  DEFAULT_SKIRT_DEPTH_METERS,
  FEET_TO_METERS,
  buildTerrainSolidMass,
} from "../solid-mass.js";

const bbox = { westLng: -97.1, southLat: 30.1, eastLng: -97.09, northLat: 30.11 };
const dem = {
  width: 3,
  height: 3,
  values: new Float32Array([100, 101, 102, 103, 104, 105, 106, 107, 108]),
};

function vec3(positions: Float32Array, id: number): [number, number, number] {
  return [positions[id * 3]!, positions[id * 3 + 1]!, positions[id * 3 + 2]!];
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

describe("terrain solid mass", () => {
  it("closes the terrain into top+skirt+bottom using the shared boundary loop", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    expect(mesh.boundaryLoopIndices.length).toBe(8); // perimeter of a 3x3 grid (center excluded)

    const solid = buildTerrainSolidMass(mesh);
    const n = mesh.boundaryLoopIndices.length;
    expect(solid.vertexCount).toBe(mesh.vertexCount + n);
    // top faces (unchanged) + 2*n skirt triangles + cap triangles (collinear-simplified fan)
    const capTriangleCount = solid.triangleCount - mesh.triangleCount - 2 * n;
    expect(capTriangleCount).toBeGreaterThan(0);
    expect(capTriangleCount).toBeLessThanOrEqual(n - 2);
    expect(solid.topVertexCount).toBe(mesh.vertexCount);
  });

  it("converts the ~1.5 ft skirt depth to metres explicitly, never reading it as metres", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh);
    expect(solid.skirtDepthMeters).toBeCloseTo(1.5 * FEET_TO_METERS, 6);
    expect(solid.skirtDepthMeters).toBeCloseTo(DEFAULT_SKIRT_DEPTH_METERS, 6);
    expect(solid.skirtDepthMeters).toBeLessThan(0.5); // ~0.4572 m, not 1.5 m
    expect(solid.bottomZ).toBeCloseTo(solid.minZ - solid.skirtDepthMeters, 6);
  });

  it("flat-bottom: every bottom vertex sits at exactly bottomZ (not per-vertex offset)", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh);
    for (let i = solid.topVertexCount; i < solid.vertexCount; i++) {
      // Float32Array storage rounds the f64 bottomZ; 4 decimal places is
      // sub-millimetre precision, well within terrain-export tolerance.
      expect(solid.positions[i * 3 + 2]).toBeCloseTo(solid.bottomZ, 4);
    }
  });

  it("skirt walls face outward (horizontal normal points away from the parcel centroid)", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh);
    const n = mesh.boundaryLoopIndices.length;

    // centroid of the top boundary loop, used only as an "away from center" probe
    let cx = 0, cy = 0;
    for (const id of mesh.boundaryLoopIndices) {
      cx += mesh.positions[id * 3]!;
      cy += mesh.positions[id * 3 + 1]!;
    }
    cx /= n; cy /= n;

    const skirtTriStart = mesh.triangleCount;
    let checked = 0;
    for (let t = skirtTriStart; t < skirtTriStart + 2 * n; t++) {
      const a = vec3(solid.positions, solid.indices[t * 3]!);
      const b = vec3(solid.positions, solid.indices[t * 3 + 1]!);
      const c = vec3(solid.positions, solid.indices[t * 3 + 2]!);
      const normal = cross(sub(b, a), sub(c, a));
      const midX = (a[0] + b[0] + c[0]) / 3;
      const midY = (a[1] + b[1] + c[1]) / 3;
      const outward = [midX - cx, midY - cy];
      const dot = normal[0] * outward[0] + normal[1] * outward[1];
      expect(dot).toBeGreaterThan(0); // normal's horizontal component points away from centroid
      checked++;
    }
    expect(checked).toBe(2 * n);
  });

  it("bottom cap faces downward", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh);
    const n = mesh.boundaryLoopIndices.length;
    const capTriStart = mesh.triangleCount + 2 * n;
    let checked = 0;
    for (let t = capTriStart; t < solid.triangleCount; t++) {
      const a = vec3(solid.positions, solid.indices[t * 3]!);
      const b = vec3(solid.positions, solid.indices[t * 3 + 1]!);
      const c = vec3(solid.positions, solid.indices[t * 3 + 2]!);
      const normal = cross(sub(b, a), sub(c, a));
      expect(normal[2]).toBeLessThan(0);
      checked++;
    }
    // Collinear-simplified cap fan: for this rectangular 3x3 fixture the 8
    // perimeter points collapse to 4 corners -> 2 triangles, not n-2 (6).
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBeLessThanOrEqual(n - 2);
  });

  it("refuses to fabricate a solid when the boundary loop is empty (nodata perimeter)", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const brokenMesh = { ...mesh, boundaryLoopIndices: [] };
    expect(() => buildTerrainSolidMass(brokenMesh)).toThrow(/boundary loop/i);
  });

  it("accepts an explicit skirtDepthFeet override, converted to metres", () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh, { skirtDepthFeet: 2 });
    expect(solid.skirtDepthMeters).toBeCloseTo(2 * FEET_TO_METERS, 6);
  });
});
