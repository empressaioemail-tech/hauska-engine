import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { buildSitePlanDrawingLayout, projectPoint, type DrawingBox } from "../layout.js";

// Same fixture shape as site-model.test.ts: a ~70x110 ft lot inside a 4x4
// DEM, San Antonio R-6 setback (front=10, side=5, rear=20 ft) for
// 48029:105129.
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

function buildModel(streetAnchors?: Array<{ name: string; points: Array<[number, number]>; sourceRef?: string }>) {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    streetAnchors,
  });
}

const box: DrawingBox = { x: 36, y: 60, width: 540, height: 600 };

describe("buildSitePlanDrawingLayout", () => {
  it("projects every PROPERTY_LINE vertex through the exact same transform as the model's ringLocal points (hash/sampled-point parity)", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);

    expect(layout.propertyLine).toHaveLength(model.ringLocal.length);
    for (let i = 0; i < model.ringLocal.length; i++) {
      const expected = projectPoint(layout.transform, model.ringLocal[i]!);
      expect(layout.propertyLine[i]!.x).toBeCloseTo(expected.x, 6);
      expect(layout.propertyLine[i]!.y).toBeCloseTo(expected.y, 6);
    }
  });

  it("projects the SETBACK offset ring through the same transform as the model's offsetRingLocal", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(model.setback.offsetRingLocal).not.toBeNull();
    expect(layout.setback.offsetRing).not.toBeNull();
    const offsetRing = model.setback.offsetRingLocal!;
    for (let i = 0; i < offsetRing.length; i++) {
      const expected = projectPoint(layout.transform, offsetRing[i]!);
      expect(layout.setback.offsetRing![i]!.x).toBeCloseTo(expected.x, 6);
      expect(layout.setback.offsetRing![i]!.y).toBeCloseTo(expected.y, 6);
    }
  });

  it("keeps every projected point inside the drawing box (fit-to-box did not overflow)", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    for (const p of layout.propertyLine) {
      expect(p.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(p.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(p.y).toBeLessThanOrEqual(box.y + box.height + 1);
    }
  });

  it("carries dimension labels with the model's exact per-segment lengthFeet values", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.dimensions).toHaveLength(model.propertySegments.length);
    for (let i = 0; i < model.propertySegments.length; i++) {
      expect(layout.dimensions[i]!.lengthFeet).toBe(model.propertySegments[i]!.lengthFeet);
    }
  });

  it("reflects street honest-absence in the layout with no fabricated anchors", () => {
    const model = buildModel();
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.streets.honestAbsence).toBe(true);
    expect(layout.streets.anchors).toHaveLength(0);
  });

  it("projects supplied street anchors through the same transform when present", () => {
    const model = buildModel([{ name: "N PINE ST", points: [[-98.4999, 29.4002], [-98.4995, 29.4002]], sourceRef: "osm:way/123" }]);
    const layout = buildSitePlanDrawingLayout(model, box);
    expect(layout.streets.honestAbsence).toBe(false);
    expect(layout.streets.anchors).toHaveLength(1);
    expect(layout.streets.anchors[0]!.points).toHaveLength(2);
    const expected = model.streets.anchors[0]!.pointsLocal.map((p) => projectPoint(layout.transform, p));
    for (let i = 0; i < expected.length; i++) {
      expect(layout.streets.anchors[0]!.points[i]!.x).toBeCloseTo(expected[i]!.x, 6);
      expect(layout.streets.anchors[0]!.points[i]!.y).toBeCloseTo(expected[i]!.y, 6);
    }
  });
});
