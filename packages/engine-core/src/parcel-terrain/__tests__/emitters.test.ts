import { describe, expect, it } from "vitest";

import { emitDxf3dFace, emitDxfContours } from "../emitters.js";
import { buildTerrainMeshGeometry, emitGlb } from "../mesh.js";

const bbox = { westLng: -97.1, southLat: 30.1, eastLng: -97.09, northLat: 30.11 };
const dem = {
  width: 3,
  height: 3,
  values: new Float32Array([100, 101, 102, 103, 104, 105, 106, 107, 108]),
  minElevation: 100,
  maxElevation: 108,
  nodataCount: 0,
};

describe("parcel terrain emitters", () => {
  it("uses the shared triangulation for GLB and 3DFACE counts", async () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const glb = await emitGlb(mesh);
    const dxf = new TextDecoder().decode(emitDxf3dFace(mesh));
    expect(glb.byteLength).toBeGreaterThan(0);
    expect(mesh.triangleCount).toBe(8);
    expect(mesh.vertexCount).toBe(9);
    expect((dxf.match(/\n3DFACE\n/g) ?? []).length).toBe(mesh.triangleCount);
  });

  it("emits contour polylines, never 3DFACE entities", () => {
    const dxf = new TextDecoder().decode(emitDxfContours(dem, bbox, 2).bytes);
    expect(dxf).toContain("LWPOLYLINE");
    expect(dxf).not.toContain("3DFACE");
  });
});
