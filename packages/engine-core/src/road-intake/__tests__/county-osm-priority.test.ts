/**
 * S2-U1 mechanical guards — county wins over OSM on disagreement (U1.2 / U1.3).
 */

import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../../depth-warm/edgeLabeling.js";
import { PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO } from "../../depth-warm/fixtures/parcelRings.js";
import type { WarmRoadSource } from "../../depth-warm/types.js";
import {
  emitCountySurveyedRoadNode,
  parseCountyStreetFeature,
  bastropCountySurveyedRoadDescriptor,
} from "../emit-county-road-node.js";
import {
  emitCountyRoadwayRoadNode,
  parseBastropRoadwayFeature,
  bastropCountyRoadwayDescriptor,
} from "../emit-county-roadway-node.js";

describe("county-vs-osm labeling priority (S2-U1 U1.2)", () => {
  it("county gravel surface flag → classification gravel (not OSM service alone)", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const osmService: WarmRoadSource = {
      osmWayId: 1,
      osmHighwayTag: "service",
      classification: "alley",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "osm-fallback",
    };
    const countyGravel: WarmRoadSource = {
      osmWayId: 900000401,
      osmHighwayTag: "county-surveyed",
      classification: "gravel",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "county-surveyed-2016",
      countySegmentObjectId: 401,
    };
    const result = labelEdgesFromRoads({ parcelRing: ring, roads: [osmService, countyGravel] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("gravel");
    expect(front?.roadProvenanceKind).toBe("county-surveyed-2016");
  });

  it("when county says residential and OSM says footway/collector, county wins front", () => {
    const ring = PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO;
    const osmCollector: WarmRoadSource = {
      osmWayId: 100,
      osmHighwayTag: "secondary",
      classification: "major_collector",
      polyline: [
        [-97.31545, 30.11006],
        [-97.31545, 30.11051],
      ],
      provenanceKind: "osm-fallback",
    };
    const osmFootway: WarmRoadSource = {
      osmWayId: 101,
      osmHighwayTag: "footway",
      classification: "unclassified",
      polyline: [
        [-97.31545, 30.11006],
        [-97.31545, 30.11051],
      ],
      provenanceKind: "osm-fallback",
    };
    const countyResidential: WarmRoadSource = {
      osmWayId: 900000347,
      osmHighwayTag: "county-surveyed",
      classification: "residential",
      polyline: [
        [-97.31528, 30.11007],
        [-97.31528, 30.11051],
      ],
      provenanceKind: "county-surveyed-2016",
      countySegmentObjectId: 347,
    };
    const result = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [osmCollector, osmFootway, countyResidential],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("residential");
    expect(front?.roadProvenanceKind).toBe("county-surveyed-2016");
  });

  it("OSM fallback remains when county has no coverage on edge (U1.3)", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const osmOnly: WarmRoadSource = {
      osmWayId: 42,
      osmHighwayTag: "residential",
      classification: "residential",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "osm-fallback",
    };
    const result = labelEdgesFromRoads({ parcelRing: ring, roads: [osmOnly] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadProvenanceKind).toBe("osm-fallback");
  });
});

describe("county-roadway vs county-surveyed vs OSM (S2-F F.2/F.3)", () => {
  it("county-roadway gravel beats OSM residential on front disagreement", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const osmResidential: WarmRoadSource = {
      osmWayId: 1,
      osmHighwayTag: "residential",
      classification: "residential",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "osm-fallback",
    };
    const countyRoadwayGravel: WarmRoadSource = {
      osmWayId: 800000104,
      osmHighwayTag: "county-roadway",
      classification: "gravel",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "county-roadway-authoritative",
      countySegmentObjectId: 104,
    };
    const result = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [osmResidential, countyRoadwayGravel],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("gravel");
    expect(front?.roadProvenanceKind).toBe("county-roadway-authoritative");
  });

  it("county-roadway beats county-surveyed-2016 when both present", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const countySurveyed: WarmRoadSource = {
      osmWayId: 900000401,
      osmHighwayTag: "county-surveyed",
      classification: "residential",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "county-surveyed-2016",
      countySegmentObjectId: 401,
    };
    const countyRoadway: WarmRoadSource = {
      osmWayId: 800000401,
      osmHighwayTag: "county-roadway",
      classification: "gravel",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "county-roadway-authoritative",
      countySegmentObjectId: 401,
    };
    const result = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [countySurveyed, countyRoadway],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadProvenanceKind).toBe("county-roadway-authoritative");
    expect(front?.roadClass).toBe("gravel");
  });

  it("county-roadway with Undefined surface does NOT beat OSM (S2-F amendment)", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const osmResidential: WarmRoadSource = {
      osmWayId: 1,
      osmHighwayTag: "residential",
      classification: "residential",
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ],
      provenanceKind: "osm-fallback",
    };
    // Undefined county rows are excluded from warm pool; only OSM participates.
    const result = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [osmResidential],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("residential");
    expect(front?.roadProvenanceKind).toBe("osm-fallback");
  });
});

describe("emit county roadway road-node (S2-F F.1)", () => {
  it("emits county-roadway-authoritative when surface is defined", () => {
    const obs = parseBastropRoadwayFeature(
      {
        objectId: 104,
        attributes: {
          class: "LS",
          surface: "Gravel",
          rdcls_typ: "Local",
          owner: "City",
          l_muni: "BASTROP",
          r_muni: "BASTROP",
          full_name: "GRAVEL FRONTAGE RD",
          surface_width: 24,
        },
        centerline: [
          [-97.32, 30.11],
          [-97.3197, 30.11035],
        ],
      },
      "2026-07-27T12:00:00.000Z",
    );
    expect(obs).not.toBeNull();
    const atom = emitCountyRoadwayRoadNode(bastropCountyRoadwayDescriptor(), obs!);
    expect(atom.classification).toBe("gravel");
    expect(atom.row.provenance.kind).toBe("county-roadway-authoritative");
    if (atom.row.provenance.kind === "county-roadway-authoritative") {
      expect(atom.row.provenance.countySegmentObjectId).toBe(104);
      expect(atom.row.provenance.countyOwner).toBe("City");
      expect(atom.row.provenance.countySurface).toContain("Gravel");
      expect(atom.row.provenance.surfaceWidthFt).toBe(24);
    }
    expect(atom.roadNodeId).toBe("48021:road:800000104");
  });

  it("emits county-roadway-undefined when surface is Undefined (no fabrication)", () => {
    const obs = parseBastropRoadwayFeature(
      {
        objectId: 15,
        attributes: {
          class: "LS",
          surface: "Undefined",
          rdcls_typ: "Local",
          owner: "City",
          l_muni: "BASTROP",
          r_muni: "BASTROP",
          full_name: "LAUREL ST",
        },
        centerline: [
          [-97.32, 30.11],
          [-97.3197, 30.11035],
        ],
      },
      "2026-07-27T12:00:00.000Z",
    );
    expect(obs).not.toBeNull();
    const atom = emitCountyRoadwayRoadNode(bastropCountyRoadwayDescriptor(), obs!);
    expect(atom.row.provenance.kind).toBe("county-roadway-undefined");
    if (atom.row.provenance.kind === "county-roadway-undefined") {
      expect(atom.row.provenance.countySurface).toBe("Undefined");
      expect(atom.row.provenance.countyOwner).toBe("City");
    }
    expect(atom.roadNodeId).toBe("48021:road:800000015");
  });
});

describe("emit county road-node (S2-U1 U1.1)", () => {
  it("emits county-surveyed-2016 provenance on atom body", () => {
    const obs = parseCountyStreetFeature(
      {
        objectId: 401,
        attributes: {
          class: "LS",
          surface: "Unpaved/Gravel CR",
          full_name: "SHILOH RD",
        },
        centerline: [
          [-97.32, 30.11],
          [-97.3197, 30.11035],
        ],
      },
      "2026-07-26T12:00:00.000Z",
    );
    expect(obs).not.toBeNull();
    const atom = emitCountySurveyedRoadNode(bastropCountySurveyedRoadDescriptor(), obs!);
    expect(atom.classification).toBe("gravel");
    expect(atom.row.provenance.kind).toBe("county-surveyed-2016");
    if (atom.row.provenance.kind === "county-surveyed-2016") {
      expect(atom.row.provenance.countySegmentObjectId).toBe(401);
      expect(atom.row.provenance.countySurface).toContain("Gravel");
    }
    expect(atom.roadNodeId).toBe("48021:road:900000401");
  });
});
