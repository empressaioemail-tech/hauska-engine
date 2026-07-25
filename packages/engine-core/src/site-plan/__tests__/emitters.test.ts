import { describe, expect, it } from "vitest";

import { buildTerrainMeshGeometry } from "../../parcel-terrain/mesh.js";
import { composeSitePlanModel } from "../site-model.js";
import { buildDxfSitePlanRequest, emitDxfSitePlan, emitIfcSitePlan } from "../emitters.js";

// Same fixture shape as site-model.test.ts: a ~70x110 ft lot inside a 4x4 DEM,
// San Antonio R-6 setback (front=10, side=5, rear=20 ft) for 48029:105129.
const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2,
    199.8, 200.2, 200.7, 201.0,
    199.5, 200.0, 200.4, 200.8,
    199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};

const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
  [-98.4998, 29.4001],
];

const setback = {
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: { atomDid: "san_antonio_tx/udc/35-310.01/35-310.01", role: "rule", entityType: "code-section" },
};

function buildModel() {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
  });
}

function buildModelWithStreet() {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    streetAnchors: [{ name: "N PINE ST", points: [[-98.4999, 29.4002], [-98.4995, 29.4002]], sourceRef: "osm:way/123" }],
  });
}

function meshMinZ(positions: Float32Array): number {
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!;
    if (z < minZ) minZ = z;
  }
  return minZ;
}

/** Rolling-layer DXF group-code scan: same technique the parcel-terrain
 * emitters test uses for 3DFACE Z extraction, generalized to any layer.
 * Skips the classic POLYLINE header entity's own 10/20/30 (a legacy
 * "elevation point" stub ezdxf always writes as (0,0,0) — real coordinates
 * live in the VERTEX/TEXT sub-entities' AcDbVertex/AcDbText subclass). */
function extractZValuesForLayer(dxf: string, layer: string): number[] {
  const lines = dxf.split(/\r?\n/);
  const zs: number[] = [];
  let currentLayer: string | null = null;
  let currentSubclass: string | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!;
    if (code === "8") currentLayer = value.trim();
    if (code === "100") currentSubclass = value.trim();
    const capturesRealPoint =
      currentSubclass === "AcDbVertex" ||
      currentSubclass === "AcDb3dPolylineVertex" ||
      currentSubclass === "AcDbText";
    if (code === "30" && currentLayer === layer && capturesRealPoint) {
      const z = Number(value);
      if (Number.isFinite(z)) zs.push(z);
    }
  }
  return zs;
}

describe("site-plan DXF/IFC emitters", () => {
  it("builds a DXF worker request sourced entirely from the shared site model", () => {
    const model = buildModel();
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const request = buildDxfSitePlanRequest(model, mesh) as Record<string, any>;
    expect(request.kind).toBe("site_plan");
    expect(request.propertyLine.points).toHaveLength(model.ringLocal.length);
    expect(request.propertyLine.citation).toBe(model.citations.propertyLine);
    expect(request.setback.offsetPoints).toBeTruthy();
    expect(request.street.honestAbsence).toBe(true);
  });

  it("emits a layered R2000 DXF site plan citing source atoms via XDATA", async () => {
    const model = buildModel();
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const { bytes, entityCount } = await emitDxfSitePlan(model, mesh);
    const dxf = new TextDecoder().decode(bytes);

    expect(dxf).toContain("$ACADVER");
    expect(dxf).toContain("AC1015");
    for (const layer of ["PROPERTY_LINE", "DIMENSION", "SETBACK", "CONTOUR", "ELEVATION_LABEL", "STREET", "NORTH"]) {
      expect(dxf).toContain(layer);
    }
    expect(dxf).toContain("NAVD88");
    expect(dxf).toContain("HAUSKA");
    expect(dxf).toContain(model.citations.propertyLine);
    expect(dxf).toContain("san_antonio_tx/udc/35-310.01");
    expect(entityCount).toBeGreaterThan(0);
  });

  it("emits a closed-solid IFC terrain mass with property/setback/contour annotation layers", async () => {
    const model = buildModel();
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const result = await emitIfcSitePlan(model, mesh, "USGS 3DEP");

    expect(result.status).toBe("ok");
    expect(result.ifcText).toBeTruthy();
    expect(result.spatialValidation?.ok).toBe(true);
    const ifc = result.ifcText ?? "";
    expect(ifc).toContain("IFCPROJECT");
    expect(ifc).toContain("IFCSITE");
    expect(ifc).toContain("IFCPRESENTATIONLAYERASSIGNMENT");
    expect(ifc).toContain("'PROPERTY_LINE'");
    expect(ifc).toContain("'SETBACK'");
    expect(ifc).toContain("'CONTOUR'");
    expect(ifc).toContain("NAVD88");
    expect(ifc).toContain(model.setback.sourceCodeAtomRef.atomDid);

    // Closed solid, not the thin-surface offer: vertex count exceeds the bare
    // top-triangulation count (top + boundary-loop bottom vertices).
    expect(result.vertexCount).toBeGreaterThan(mesh.vertexCount);
  });

  it("draws no fabricated STREET geometry when the site model reports honest absence", async () => {
    const model = buildModel();
    expect(model.streets.honestAbsence).toBe(true);
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const { bytes } = await emitDxfSitePlan(model, mesh);
    const dxf = new TextDecoder().decode(bytes);
    // STREET layer exists (declared) but carries no polyline/text drawn from
    // invented road geometry — the honest-absence comment is what "STREET"
    // matches against the LAYER table entry only.
    const streetEntityLines = dxf
      .split(/\r?\n/)
      .filter((line, i, all) => all[i - 1]?.trim() === "8" && line.trim() === "STREET");
    expect(streetEntityLines.length).toBe(0);
  });

  it("draws STREET at the same grade Z as PROPERTY_LINE/SETBACK in DXF, and IFC honors the same grade (HOLD 2 regression)", async () => {
    const model = buildModelWithStreet();
    expect(model.streets.honestAbsence).toBe(false);
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const expectedGradeZ = meshMinZ(mesh.positions);
    expect(expectedGradeZ).not.toBe(0);

    const { bytes } = await emitDxfSitePlan(model, mesh);
    const dxf = new TextDecoder().decode(bytes);
    const propertyLineZs = extractZValuesForLayer(dxf, "PROPERTY_LINE");
    const streetZs = extractZValuesForLayer(dxf, "STREET");
    expect(propertyLineZs.length).toBeGreaterThan(0);
    expect(streetZs.length).toBeGreaterThan(0);
    for (const z of streetZs) {
      expect(z).toBeCloseTo(expectedGradeZ, 3);
    }
    for (const z of propertyLineZs) {
      expect(z).toBeCloseTo(expectedGradeZ, 3);
    }

    const ifc = await emitIfcSitePlan(model, mesh, "USGS 3DEP");
    expect(ifc.status).toBe("ok");
    // Before the fix this read a nonexistent base["grade_z"] and was always
    // 0.0 regardless of the shared model's actual grade.
    expect(ifc.streetGradeZ).not.toBe(0);
    expect(ifc.streetGradeZ).toBeCloseTo(expectedGradeZ, 3);
    expect(ifc.streetGradeZ).toBeCloseTo(streetZs[0]!, 3);
  });
});
