import { describe, expect, it } from "vitest";

import { buildDxfPreamble, emitDxf3dFace, emitDxfContours } from "../emitters.js";
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

function assertRevitFriendlyDxf(dxf: string): void {
  expect(dxf.startsWith("0\nSECTION\n2\nHEADER\n")).toBe(true);
  expect(dxf).toContain("$ACADVER");
  expect(dxf).toContain("AC1015");
  expect(dxf).toMatch(/\$INSUNITS\n70\n6\n/);
  expect(dxf).toContain("\n2\nLTYPE\n");
  expect(dxf).toContain("\n2\nCONTINUOUS\n");
  expect(dxf).toContain("\n2\nBLOCKS\n");
  expect(dxf).toContain("TABLES");
  expect(dxf).toContain("ENTITIES");
  expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
}

describe("parcel terrain emitters", () => {
  it("uses the shared triangulation for GLB and 3DFACE counts", async () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const glb = await emitGlb(mesh);
    const dxf = new TextDecoder().decode(emitDxf3dFace(mesh));
    expect(glb.byteLength).toBeGreaterThan(0);
    expect(mesh.triangleCount).toBe(8);
    expect(mesh.vertexCount).toBe(9);
    expect(dxf.split("\n").filter((line) => line === "3DFACE").length).toBe(
      mesh.triangleCount,
    );
    assertRevitFriendlyDxf(dxf);
    expect(dxf).toContain("TERRAIN");
  });

  it("emits classic 3D POLYLINE contours, never faces or LWPOLYLINE", () => {
    const dxf = new TextDecoder().decode(emitDxfContours(dem, bbox, 2).bytes);
    expect(dxf).toContain("POLYLINE");
    expect(dxf).toContain("VERTEX");
    expect(dxf).toContain("SEQEND");
    expect(dxf).not.toContain("LWPOLYLINE");
    expect(dxf).not.toContain("3DFACE");
    assertRevitFriendlyDxf(dxf);
    expect(dxf).toContain("TERRAIN_CONTOURS");
  });

  it("buildDxfPreamble registers LTYPE CONTINUOUS before layers", () => {
    const text = buildDxfPreamble(["TERRAIN", "TERRAIN_CONTOURS"]).join("\n");
    const ltypeAt = text.indexOf("\n2\nLTYPE\n");
    const layerAt = text.indexOf("\n2\nLAYER\n");
    expect(ltypeAt).toBeGreaterThan(-1);
    expect(layerAt).toBeGreaterThan(ltypeAt);
    expect(text).toContain("\n2\nCONTINUOUS\n");
    expect(text).toContain("\n2\nBLOCKS\n");
  });
});
