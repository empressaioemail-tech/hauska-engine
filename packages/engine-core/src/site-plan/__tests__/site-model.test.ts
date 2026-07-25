import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../site-model.js";

// Synthetic bbox + DEM sized to contain a realistic San Antonio R-6 lot
// (48029:105129 real setback values: front=10, side=5, rear=20 ft).
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

// A ~70x110 ft rectangle sitting inside the bbox, closed ring (repeats first point).
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

describe("composeSitePlanModel", () => {
  it("composes one shared model with ring, setback, contours, honest-absence streets, north/scale", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
    });

    expect(model.parcelNodeId).toBe("48029:105129");
    expect(model.ringLocal).toHaveLength(4); // closing duplicate dropped
    expect(model.propertySegments).toHaveLength(4);
    for (const seg of model.propertySegments) {
      expect(seg.lengthFeet).toBeGreaterThan(0);
    }

    expect(model.setback.front).toBe(10);
    expect(model.setback.side).toBe(5);
    expect(model.setback.rear).toBe(20);
    expect(model.setback.sourceCodeAtomRef.atomDid).toBe("san_antonio_tx/udc/35-310.01/35-310.01");
    expect(model.setback.degenerate).toBe(false);
    expect(model.setback.offsetRingLocal).not.toBeNull();

    expect(model.contours.length).toBeGreaterThan(0);
    expect(model.elevationLabels.some((l) => l.role === "corner")).toBe(true);

    expect(model.streets.honestAbsence).toBe(true);
    expect(model.streets.anchors).toHaveLength(0);
    expect(model.streets.reason).toMatch(/no road-anchor atom/i);

    expect(model.north.directionLocal).toEqual({ x: 0, y: 1 });
    expect(model.scaleBar.lengthMeters).toBeGreaterThan(0);
    expect(model.verticalDatum.name).toBe("NAVD88");
  });

  it("uses supplied street anchors instead of honest-absence when provided", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      streetAnchors: [{ name: "N PINE ST", points: [[-98.4999, 29.4002], [-98.4995, 29.4002]], sourceRef: "osm:way/123" }],
    });
    expect(model.streets.honestAbsence).toBe(false);
    expect(model.streets.anchors).toHaveLength(1);
    expect(model.streets.anchors[0]!.name).toBe("N PINE ST");
    expect(model.streets.anchors[0]!.pointsLocal).toHaveLength(2);
  });

  it("refuses to fabricate a ring from fewer than 3 points", () => {
    expect(() =>
      composeSitePlanModel({
        parcelNodeId: "48029:105129",
        bbox,
        ringWgs84: [[-98.4998, 29.4001]],
        dem,
        contourIntervalMeters: 0.5,
        setback,
      }),
    ).toThrow(/boundary ring/i);
  });

  it("passes an explicit frontEdgeIndex hint through to the setback basis", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      frontEdgeIndex: 0,
    });
    expect(model.setback.basis).toBe("front-edge-hint");
  });
});
