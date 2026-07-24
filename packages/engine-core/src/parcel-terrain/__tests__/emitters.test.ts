import { describe, expect, it } from "vitest";

import { emitDxf3dFace, emitDxfContours, emitIfc } from "../emitters.js";
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

/** Structure Revit Link CAD needs; AutoCAD repairs missing pieces on open/save. */
function assertRevitValidR2000(dxf: string): void {
  expect(dxf).toContain("$ACADVER");
  expect(dxf).toContain("AC1015");
  expect(dxf).toMatch(/\$INSUNITS[\r\n]+\s*70[\r\n]+\s*6/);
  expect(dxf).toContain("BLOCK_RECORD");
  expect(dxf).toContain("*Model_Space");
  expect(dxf).toContain("*Paper_Space");
  expect(dxf).toContain("OBJECTS");
  expect(dxf).toContain("LAYOUT");
  expect(dxf).toMatch(/[\r\n]\s*5[\r\n]/); // entity handles (group code 5)
  expect(dxf).toContain("ENTITIES");
  expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
}

describe("parcel terrain emitters", () => {
  it("uses the shared triangulation for GLB and 3DFACE counts", async () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const glb = await emitGlb(mesh);
    const dxf = new TextDecoder().decode(await emitDxf3dFace(mesh));
    expect(glb.byteLength).toBeGreaterThan(0);
    expect(mesh.triangleCount).toBe(8);
    expect(mesh.vertexCount).toBe(9);
    expect(dxf.split(/\r?\n/).filter((line) => line.trim() === "3DFACE").length).toBe(
      mesh.triangleCount,
    );
    assertRevitValidR2000(dxf);
    expect(dxf).toContain("TERRAIN");
  });

  it("emits classic 3D POLYLINE contours, never faces or LWPOLYLINE", async () => {
    const dxf = new TextDecoder().decode((await emitDxfContours(dem, bbox, 2)).bytes);
    expect(dxf).toContain("POLYLINE");
    expect(dxf).toContain("VERTEX");
    expect(dxf).toContain("SEQEND");
    expect(dxf).not.toContain("LWPOLYLINE");
    expect(dxf).not.toContain("3DFACE");
    assertRevitValidR2000(dxf);
    expect(dxf).toContain("TERRAIN_CONTOURS");
  });

  it("authors a complete IFC Project→Site→placed terrain tree with MapConversion", async () => {
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const ifc = await emitIfc(mesh, "USGS 3DEP");
    expect(ifc.status).toBe("ok");
    expect(ifc.ifcText).toBeTruthy();
    expect(ifc.spatialValidation?.ok).toBe(true);
    expect(ifc.spatialValidation?.IfcSite).toBeGreaterThanOrEqual(1);
    expect(ifc.spatialValidation?.IfcRelAggregates).toBeGreaterThanOrEqual(1);
    expect(ifc.spatialValidation?.IfcRelContainedInSpatialStructure).toBeGreaterThanOrEqual(1);
    expect(ifc.spatialValidation?.IfcLocalPlacement).toBeGreaterThanOrEqual(1);
    expect(ifc.spatialValidation?.IfcMapConversion).toBeGreaterThanOrEqual(1);
    expect(ifc.spatialValidation?.projectAggregatesSite).toBe(true);
    expect(ifc.spatialValidation?.siteContainsElement).toBe(true);
    expect(ifc.spatialValidation?.elementHasPlacement).toBe(true);
    expect(ifc.triangleCount).toBe(mesh.triangleCount);
    expect(ifc.ifcText).toContain("IFCSITE");
    expect(ifc.ifcText).toContain("IFCRELAGGREGATES");
    expect(ifc.ifcText).toContain("IFCRELCONTAINEDINSPATIALSTRUCTURE");
    expect(ifc.ifcText).toContain("IFCLOCALPLACEMENT");
    expect(ifc.ifcText).toContain("IFCMAPCONVERSION");
  });
});

