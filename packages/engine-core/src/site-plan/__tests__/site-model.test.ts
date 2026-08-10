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
      frontEdgeIndex: 0,
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
    expect(model.streets.reason).toMatch(/no road-node attaches/i);

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

  it("computes lot area and buildable area (Wave 2 summary) from the SAME ring/offset points, honest fallbacks when descriptors are absent", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      frontEdgeIndex: 0,
    });

    // ~64x73 ft rectangle once reprojected through local-ENU -> ~4600 sq ft
    // lot; loose bounds, not an exact rectangle assertion.
    expect(model.summary.lotAreaSqFt).toBeGreaterThan(3500);
    expect(model.summary.lotAreaSqFt).toBeLessThan(6000);
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    expect(model.summary.buildableAreaSqFt!).toBeLessThan(model.summary.lotAreaSqFt);

    expect(model.summary.countyFips).toBe("48029");
    expect(model.summary.countyName).toBeUndefined();
    expect(model.summary.address).toBeUndefined();
    expect(model.summary.zoningDistrict).toBeUndefined();
    expect(model.summary.zoningHonestAbsenceReason).toBeUndefined();

    expect(model.summary.elevationRangeMeters).toEqual({ min: 199.2, max: 201.2 });
    expect(model.summary.verticalDatumSummary).toMatch(/NAVD88/);

    // No floodZone input supplied -> honest-unavailable, never fabricated.
    expect("honestUnavailable" in model.summary.floodZone).toBe(true);
  });

  it("carries caller-supplied descriptor, zoning, and flood-zone inputs through to the summary and citations", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
      zoning: { district: "R-6" },
      floodZone: {
        zone: "X",
        inSpecialFloodHazardArea: false,
        sourceCitation: "FEMA National Flood Hazard Layer (NFHL)",
        asOfIso: "2026-07-25T00:00:00.000Z",
      },
    });

    expect(model.summary.address).toBe("1127 N PINE ST, SAN ANTONIO, TX 78202");
    expect(model.summary.countyName).toBe("Bexar County");
    expect(model.summary.zoningDistrict).toBe("R-6");
    expect(model.citations.zoning).toBeTruthy();
    expect("zone" in model.summary.floodZone && model.summary.floodZone.zone).toBe("X");
    expect(model.citations.flood).toBe("FEMA National Flood Hazard Layer (NFHL)");
  });

  it("reports an honest buildable-area note (not a fabricated area) when the setback offset degenerates", () => {
    // front+rear far larger than the lot's short dimension (~64 ft) collapses the offset.
    const consumingSetback = {
      front: 100,
      side: 100,
      rear: 100,
      sourceCodeAtomRef: setback.sourceCodeAtomRef,
    };
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: consumingSetback,
      frontEdgeIndex: 0,
    });
    expect(model.setback.degenerate).toBe(true);
    expect(model.summary.buildableAreaSqFt).toBeNull();
    expect(model.summary.buildableAreaHonestNote).toBeTruthy();
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

  // 2026-07-28 architecture directive: the geometric heuristic and the
  // uniform-min fabrication are RETIRED. With a rule on file and no boundary
  // primitive / front-edge anchor, NOTHING envelope-shaped is drawn, the
  // state is provisional (not degenerate), and the honesty note says why.
  it("draws nothing and flags the provisional honesty note when the front edge is unresolved (no primitive, no hint)", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      // No boundaryEdges and no frontEdgeIndex -> honest unresolved.
    });
    expect(model.setback.basis).toBe("unresolved-front-edge");
    expect(model.setback.frontEdgeUnresolved).toBe(true);
    expect(model.setback.degenerate).toBe(false);
    expect(model.setback.offsetRingLocal).toBeNull();
    expect(model.summary.buildableAreaSqFt).toBeNull();
    expect(model.summary.buildableAreaHonestNote).toBeTruthy();
    expect(model.summary.buildableAreaHonestNote).toMatch(/provisional/i);
    expect(model.summary.buildableAreaHonestNote).toMatch(/front-edge resolution/i);
    expect(model.summary.buildableDisplayKind).toBe("provisional");
  });

  it("does not flag the honesty note when the front edge is caller-resolved and no envelope outcome contradicts it", () => {
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
    expect(model.summary.buildableAreaHonestNote).toBeUndefined();
  });

  it("CONSUMES the boundary primitive when present: basis boundary-primitive, roles from stored edges, drawable envelope, no provisional note when every edge is resolved", async () => {
    const { boundaryEdgesForRing } = await import("./boundary-edge-fixture.js");
    const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
      { role: "front", feet: 10 },
      { role: "side", feet: 5 },
      { role: "rear", feet: 20 },
      { role: "side", feet: 5 },
    ]);
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
    });
    expect(model.setback.basis).toBe("boundary-primitive");
    expect(model.setback.degenerate).toBe(false);
    expect(model.setback.offsetRingLocal).not.toBeNull();
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    expect(model.summary.buildableAreaSqFt!).toBeLessThan(model.summary.lotAreaSqFt);
    expect(model.summary.buildableAreaHonestNote).toBeUndefined();
    expect(model.setback.segments.map((s) => s.role)).toEqual(["front", "side", "rear", "side"]);
    expect(model.setback.segments.map((s) => s.distanceFt)).toEqual([10, 5, 20, 5]);
  });

  // Operator ruling 2026-07-28: stored setback ABSENCE (build-to-line
  // governs / unmapped adjacency) = ZERO inset on those edges + PROVISIONAL
  // envelope. Never a fabricated side/rear value.
  it("applies zero inset on stored-absence edges and labels the envelope PROVISIONAL (build-to-line ruling)", async () => {
    const { boundaryEdgesForRing } = await import("./boundary-edge-fixture.js");
    const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
      { role: "front", feet: 15 },
      { role: "side", absent: true },
      { role: "rear", absent: true },
      { role: "side_corner", feet: 5 },
    ]);
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: { ...setback, front: 15, side: 0, rear: 0, notSpecified: { side: true, rear: true } },
      boundaryEdges,
    });
    expect(model.setback.basis).toBe("boundary-primitive");
    expect(model.setback.primitiveEdgeAbsence).toBe(true);
    expect(model.setback.offsetRingLocal).not.toBeNull();
    expect(model.setback.segments.map((s) => s.distanceFt)).toEqual([15, 0, 0, 5]);
    expect(model.setback.segments[1]!.notSpecified).toBe(true);
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    expect(model.summary.buildableAreaHonestNote).toMatch(/provisional/i);
    expect(model.summary.buildableAreaHonestNote).toMatch(/no value was fabricated/i);
    expect(model.summary.buildableDisplayKind).toBe("provisional");
  });

  it("falls back to the honest unresolved treatment when the primitive does not cover the ring (edge-count mismatch)", async () => {
    const { boundaryEdgesForRing } = await import("./boundary-edge-fixture.js");
    const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
      { role: "front", feet: 10 },
      { role: "side", feet: 5 },
      { role: "rear", feet: 20 },
      { role: "side", feet: 5 },
    ]).slice(0, 2); // stale/partial primitive
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
    });
    expect(model.setback.basis).toBe("unresolved-front-edge");
    expect(model.setback.frontEdgeUnresolved).toBe(true);
    expect(model.setback.offsetRingLocal).toBeNull();
    expect(model.summary.buildableAreaSqFt).toBeNull();
  });

  it("flags the honesty note when the buildable-envelope atom independently reports provisional-front-edge, even on a resolved front-edge-hint basis", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      frontEdgeIndex: 0,
      envelopeOutcome: { kind: "provisional-front-edge", reason: "front-edge-anchor atom unresolved" },
    });
    expect(model.setback.basis).toBe("front-edge-hint");
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    expect(model.summary.buildableAreaHonestNote).toBeTruthy();
    expect(model.summary.buildableAreaHonestNote).toMatch(/provisional-front-edge/i);
    expect(model.summary.buildableAreaHonestNote).toMatch(/front-edge-anchor atom unresolved/);
  });

  it("reports null buildable area (not lot area) when no setback-rule atom is on file — zero inset offset ring equals property line", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48113:007701000B0010000",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: {
        front: 0,
        side: 0,
        rear: 0,
        sourceCodeAtomRef: {
          atomDid: "no-setback-rule-atom",
          role: "honest-absence",
          entityType: "setback-rule",
        },
        honestAbsence: true,
      },
    });
    expect(model.setback.honestAbsence).toBe(true);
    expect(model.setback.offsetRingLocal).not.toBeNull();
    expect(model.setback.degenerate).toBe(false);
    expect(model.summary.buildableAreaSqFt).toBeNull();
    expect(model.summary.lotAreaSqFt).toBeGreaterThan(0);
  });
});
