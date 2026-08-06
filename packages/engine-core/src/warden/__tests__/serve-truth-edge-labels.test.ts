import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";

import { labelEdgesFromRoads } from "../../depth-warm/edgeLabeling.js";
import type { Ring } from "../depth-warm/geometry.js";
import { classifyServeTruthEdgeLabels, certVsServedEdgeMismatches } from "../serve-truth-edge-labels.js";

const RING: Ring = [
  [-97.0, 30.0],
  [-97.001, 30.0],
  [-97.001, 30.001],
  [-97.0, 30.001],
  [-97.0, 30.0],
];

const ROAD = {
  osmWayId: 1,
  osmHighwayTag: "residential",
  classification: "residential" as const,
  polyline: [
    [-97.0005, 29.999],
    [-97.0005, 30.002],
  ] as [number, number][],
};

function storedEdge(index: number, role: BoundaryEdgeAtomInstance["role"]): BoundaryEdgeAtomInstance {
  return {
    entityType: "property-boundary-edge",
    atomDid: `did:test:edge:${index}`,
    boundaryEdgeId: `48021:1:${index}`,
    entityId: `48021:1:${index}`,
    parcelNodeId: "48021:1",
    countyFips: "48021",
    propId: "1",
    edgeIndex: index,
    role,
    adjacencyKind: "ROW",
    parcelNeighborPropId: null,
    facingRoad: null,
    setback: { feet: 25, provenance: "test", atomCitation: "test" },
    interior: {
      ringCcw: true,
      centroidInside: true,
      inwardNormal: { x: 0, y: 1 },
      edgeEndpoints: [
        [0, 0],
        [1, 0],
      ],
    },
    propertyLineTags: { front: "N", rear: "S", left: "W", right: "E" },
    effectiveDate: "2026-08-06",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "public-free",
    sourceCitation: "test",
    extractedAt: "2026-08-06T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: "bastrop_tx",
    fetchedAt: "2026-08-06T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test",
    contentHash: "test",
    readContract: {} as BoundaryEdgeAtomInstance["readContract"],
  };
}

describe("certVsServedEdgeMismatches", () => {
  it("detects role divergence at cert-graded edge indices", () => {
    const cert = labelEdgesFromRoads({ parcelRing: RING, roads: [ROAD], situsAddress: null });
    expect(cert.ok).toBe(true);
    const frontIndex = cert.edgeLabels.find((e) => e.label === "front")!.index;
    const served = cert.edgeLabels.map((e) => ({
      edgeIndex: e.index,
      role: e.index === frontIndex ? "rear" : e.label,
    }));
    const mismatches = certVsServedEdgeMismatches(cert.edgeLabels, served);
    expect(mismatches).toEqual([
      { edgeIndex: frontIndex, certRole: "front", servedRole: "rear" },
    ]);
  });
});

describe("classifyServeTruthEdgeLabels", () => {
  it("emits no finding when cert and served roles agree after export prep", async () => {
    const cert = labelEdgesFromRoads({ parcelRing: RING, roads: [ROAD], situsAddress: null });
    expect(cert.ok).toBe(true);
    const aligned = cert.edgeLabels.map((e) => storedEdge(e.index, e.label));

    const findings = await classifyServeTruthEdgeLabels({
      sweepId: "test-sweep-clean",
      fips: "48021",
      rowId: "Bastrop",
      now: () => new Date("2026-08-06T12:00:00.000Z"),
      parcels: [
        {
          parcelNodeId: "48021:1",
          parcelRing: RING,
          storedEdges: aligned,
          setbackRule: null,
          envelopeBody: {
            depthWarmPromotion: "depth-warm-promoted-v1",
            outcome: { kind: "buildable", areaSqFt: 1000 },
          },
          roads: [ROAD],
        },
      ],
    });

    expect(findings.length).toBe(0);
  });
});
