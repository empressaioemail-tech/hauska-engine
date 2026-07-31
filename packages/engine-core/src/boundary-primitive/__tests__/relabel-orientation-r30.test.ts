/**
 * R30/R31 — Block-13 edge orientation: relabel + verify gates.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";

import { relabelBoundaryEdgesFromRoadLabels } from "../relabel-from-roads.js";
import { labelEdgesFromRoads } from "../../depth-warm/edgeLabeling.js";
import {
  verifyFrontEdgeOrientation,
  verifyWarmCandidateMechanically,
} from "../../depth-warm/verify-mechanical.js";
import { computeWarmCandidate } from "../../depth-warm/warm-compute.js";
import type { WarmRoadSource } from "../../depth-warm/types.js";
import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json";

const COUNTY = "48021";

/** Corner lot — edge 0 south faces Pine (906 Pine St specimen shape). */
const CORNER_RING: [number, number][] = [
  [-97.32, 30.11],
  [-97.3194, 30.11],
  [-97.3194, 30.1104],
  [-97.32, 30.1104],
  [-97.32, 30.11],
];

const PINE_ROAD: WarmRoadSource = {
  osmWayId: 15113284,
  osmHighwayTag: "residential",
  name: "Pine Street",
  classification: "residential",
  polyline: [
    [-97.3202, 30.10995],
    [-97.3192, 30.10995],
  ],
};

const PECAN_ROAD: WarmRoadSource = {
  osmWayId: 1001,
  osmHighwayTag: "residential",
  name: "Pecan Street",
  classification: "residential",
  polyline: [
    [-97.32008, 30.1098],
    [-97.32008, 30.1106],
  ],
};

function stubBoundaryEdge(
  edgeIndex: number,
  role: BoundaryEdgeAtomInstance["role"],
): BoundaryEdgeAtomInstance {
  return {
    entityType: "property-boundary-edge",
    atomDid: `did:${edgeIndex}`,
    boundaryEdgeId: `${COUNTY}:34169:${edgeIndex}`,
    entityId: `${COUNTY}:34169:${edgeIndex}`,
    parcelNodeId: `${COUNTY}:34169`,
    countyFips: COUNTY,
    propId: "34169",
    edgeIndex,
    role,
    adjacencyKind: "ROW",
    parcelNeighborPropId: null,
    facingRoad: null,
    setback: { feet: 5, provenance: "district-setback-table", atomCitation: "test" },
    interior: {
      ringCcw: true,
      centroidInside: true,
      inwardNormal: { x: 0, y: 1 },
      edgeEndpoints: [
        [-97.31672, 30.11048],
        [-97.31652, 30.11048],
      ],
    },
    propertyLineTags: [],
    effectiveDate: "2026-07-31",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "platform-internal",
    sourceCitation: "test",
    extractedAt: "2026-07-31T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: "bastrop-city-tx",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test://",
    contentHash: "test",
    readContract: {} as BoundaryEdgeAtomInstance["readContract"],
  };
}

describe("R30 relabelBoundaryEdgesFromRoadLabels", () => {
  it("906 Pine: stale west-front → situs relabel puts front on Pine (south) edge", () => {
    const roads = [PINE_ROAD, PECAN_ROAD];
    const labelResult = labelEdgesFromRoads({
      parcelRing: CORNER_RING,
      roads,
      situsAddress: "906 PINE ST , BASTROP, TX 78602",
    });
    expect(labelResult.ok).toBe(true);
    if (!labelResult.ok) return;
    const freshFront = labelResult.edgeLabels.find((e) => e.label === "front");
    expect(freshFront?.index).toBe(0);
    expect(freshFront?.frontBasis).toBe("situs-street-match");

    const stale = [0, 1, 2, 3].map((i) =>
      stubBoundaryEdge(i, i === 3 ? "front" : "side"),
    );
    const relabeled = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: stale,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY,
    });
    expect(relabeled.find((e) => e.role === "front")?.edgeIndex).toBe(0);
    expect(relabeled.find((e) => e.edgeIndex === 3)?.role).not.toBe("front");
  });
});

describe("R31 verifyFrontEdgeOrientation", () => {
  const descriptor = {
    ...bastropDescriptor,
    sourceAdapter: "bastrop-per-parcel-record-layer-23",
  };

  it("fails when warm front edge disagrees with fresh situs labeling", () => {
    const roads = [PINE_ROAD, PECAN_ROAD];
    const labelResult = labelEdgesFromRoads({
      parcelRing: CORNER_RING,
      roads,
      situsAddress: "906 PINE ST , BASTROP, TX 78602",
    });
    expect(labelResult.ok).toBe(true);
    if (!labelResult.ok) return;

    const staleEdges = [0, 1, 2, 3].map((i) =>
      stubBoundaryEdge(i, i === 3 ? "front" : "side"),
    );
    const wrong = computeWarmCandidate({
      parcelNodeId: `${COUNTY}:34169`,
      district: "SF-1",
      parcelRing: CORNER_RING,
      descriptor,
      roads,
      edgeLabels: labelResult.edgeLabels,
      boundaryEdges: staleEdges,
    });

    const check = verifyFrontEdgeOrientation(wrong, descriptor, {
      situsAddress: "906 PINE ST , BASTROP, TX 78602",
      roads,
    });
    expect(check.pass).toBe(false);
    expect(check.reasons.some((r) => r.includes("front edge index"))).toBe(true);
  });

  it("passes when relabeled boundary edges match fresh situs front", () => {
    const roads = [PINE_ROAD, PECAN_ROAD];
    const labelResult = labelEdgesFromRoads({
      parcelRing: CORNER_RING,
      roads,
      situsAddress: "906 PINE ST , BASTROP, TX 78602",
    });
    expect(labelResult.ok).toBe(true);
    if (!labelResult.ok) return;

    const stale = [0, 1, 2, 3].map((i) =>
      stubBoundaryEdge(i, i === 3 ? "front" : "side"),
    );
    const relabeled = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: stale,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY,
    });
    const candidate = computeWarmCandidate({
      parcelNodeId: `${COUNTY}:34169`,
      district: "SF-1",
      parcelRing: CORNER_RING,
      descriptor,
      roads,
      edgeLabels: labelResult.edgeLabels,
      boundaryEdges: relabeled,
    });

    const verify = verifyWarmCandidateMechanically(candidate, descriptor, {
      situsAddress: "906 PINE ST , BASTROP, TX 78602",
      roads,
    });
    expect(verify.gates.frontOrientation.pass).toBe(true);
  });
});
