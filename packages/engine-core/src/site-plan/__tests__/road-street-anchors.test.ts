import { describe, expect, it } from "vitest";

import { buildRowEdgesFromCenterline } from "../../road-intake/geometry.js";
import {
  streetAnchorFromRoadNode,
  streetAnchorsFromRoadNodes,
} from "../road-street-anchors.js";
import { composeSitePlanModel } from "../site-model.js";
import { buildProvenancePanelEntries } from "../pdf/provenance.js";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7,
    200.1, 200.5,
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
  sourceCodeAtomRef: {
    atomDid: "san_antonio_tx/udc/35-310.01/35-310.01",
    role: "rule",
    entityType: "code-section",
  },
};

const CENTERLINE: Array<[number, number]> = [
  [-98.4999, 29.4002],
  [-98.4995, 29.4002],
];

function fixtureRoadNode() {
  const { leftEdge, rightEdge } = buildRowEdgesFromCenterline(CENTERLINE, 50);
  return {
    roadNodeId: "48029:road:999001",
    displayName: "N PINE ST",
    centerline: { type: "LineString" as const, coordinates: CENTERLINE },
    row: {
      assumedWidthFt: 50,
      provenance: {
        kind: "approximate-assumed-per-class" as const,
        assumedWidthTableKey: "residential",
        osmHighwayTag: "residential",
      },
      leftEdge,
      rightEdge,
    },
    sourceCitation: "OpenStreetMap way/999001",
  };
}

describe("Track B1 STREET from road-node", () => {
  it("maps road-node centerline + ROW edges with approximate-assumed-per-class provenance", () => {
    const anchor = streetAnchorFromRoadNode(fixtureRoadNode());
    expect(anchor).not.toBeNull();
    expect(anchor!.name).toBe("N PINE ST");
    expect(anchor!.points).toHaveLength(2);
    expect(anchor!.leftEdgePoints!.length).toBeGreaterThanOrEqual(2);
    expect(anchor!.rightEdgePoints!.length).toBeGreaterThanOrEqual(2);
    expect(anchor!.rowProvenanceKind).toBe("approximate-assumed-per-class");
    expect(anchor!.assumedWidthFt).toBe(50);
    expect(anchor!.roadNodeId).toBe("48029:road:999001");
  });

  it("composes non-empty STREET with edges + provenance when road-node anchors are supplied", () => {
    const anchors = streetAnchorsFromRoadNodes([fixtureRoadNode()]);
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      streetAnchors: anchors,
    });

    expect(model.streets.honestAbsence).toBe(false);
    expect(model.streets.anchors).toHaveLength(1);
    expect(model.streets.anchors[0]!.pointsLocal.length).toBeGreaterThanOrEqual(2);
    expect(model.streets.anchors[0]!.leftEdgeLocal!.length).toBeGreaterThanOrEqual(2);
    expect(model.streets.anchors[0]!.rightEdgeLocal!.length).toBeGreaterThanOrEqual(2);
    expect(model.streets.anchors[0]!.rowProvenanceKind).toBe("approximate-assumed-per-class");

    // SHEET STANDARD §11/§13: the machine provenance kind stays on the MODEL
    // (rowProvenanceKind asserted above); the sheet confidence cell is the
    // fixed enum plus one qualifier.
    const provenance = buildProvenancePanelEntries(model);
    const streetEntry = provenance.find((e) => e.layer === "Street");
    expect(streetEntry).toBeDefined();
    expect(streetEntry!.confidence).toBe("centerline accurate · ROW assumed");
  });

  it("keeps honest absence when no road-node attaches (no fabricated STREET)", () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
    });
    expect(model.streets.honestAbsence).toBe(true);
    expect(model.streets.anchors).toHaveLength(0);
    expect(model.streets.reason).toMatch(/no road-node attaches/i);

    const provenance = buildProvenancePanelEntries(model);
    const streetEntry = provenance.find((e) => e.layer === "Street");
    expect(streetEntry!.confidence).toMatch(/honest absence/i);
  });
});
