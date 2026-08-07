/**
 * S2-U3 — offset consumes boundary primitive (U3.1–U3.4 fixtures).
 */

import { describe, expect, it, vi } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

import {
  BOUNDARY_PRIMITIVE_WARM_AGENT_ID,
  computeWarmCandidateFromBoundary,
  setbackFeetFromBoundaryAtom,
} from "../consume.js";
import { computeParcelInteriorFacts } from "../interior.js";
import * as polygonInset from "../../geometry/polygon-inset.js";
import { computeWarmCandidate } from "../../depth-warm/warm-compute.js";
import { PARCEL_28286_LIVE_TXGIO } from "../../depth-warm/fixtures/parcelRings.js";
import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  ringHasSelfTouch,
  type PlanarPoint,
} from "../../geometry/polygon-inset.js";

const COUNTY_FIPS = "48021";
const PROP_28286 = "28286";

function buildTestBoundaryAtom(
  ring: typeof PARCEL_28286_LIVE_TXGIO,
  spec: {
    edgeIndex: number;
    role: BoundaryEdgeAtomInstance["role"];
    adjacencyKind: BoundaryEdgeAtomInstance["adjacencyKind"];
    setbackFeet?: number;
    setbackKind?: "unmapped-adjacency";
  },
): BoundaryEdgeAtomInstance {
  const facts = computeParcelInteriorFacts(ring);
  expect(facts).not.toBeNull();
  const edgeInterior = facts!.edges.find((e) => e.edgeIndex === spec.edgeIndex);
  expect(edgeInterior).toBeDefined();

  const boundaryEdgeId = `${COUNTY_FIPS}:${PROP_28286}:boundary:${spec.edgeIndex}`;
  const setback =
    spec.setbackKind === "unmapped-adjacency"
      ? {
          kind: "unmapped-adjacency" as const,
          reason: "No parcel or ROW adjacency mapped for this edge.",
        }
      : {
          feet: spec.setbackFeet ?? 0,
          provenance: "road-class-setback-table",
          atomCitation: bastropDescriptor.key,
        };

  return {
    entityType: "property-boundary-edge",
    atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
    boundaryEdgeId,
    entityId: boundaryEdgeId,
    parcelNodeId: `${COUNTY_FIPS}:${PROP_28286}`,
    countyFips: COUNTY_FIPS,
    propId: PROP_28286,
    edgeIndex: spec.edgeIndex,
    role: spec.role,
    adjacencyKind: spec.adjacencyKind,
    parcelNeighborPropId: null,
    facingRoad:
      spec.adjacencyKind === "ROW"
        ? {
            roadNodeId: `${COUNTY_FIPS}:road:123456789`,
            classification: "residential",
            provenance: "osm-overpass-v1",
            osmHighwayTag: "residential",
          }
        : null,
    setback,
    interior: {
      ringCcw: edgeInterior!.ringCcw,
      centroidInside: edgeInterior!.centroidInside,
      inwardNormal: edgeInterior!.inwardNormal,
      edgeEndpoints: edgeInterior!.edgeEndpoints,
    },
    effectiveDate: "2026-07-27",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "platform-internal",
    sourceCitation: "S2-U3 unit fixture",
    extractedAt: "2026-07-27T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: bastropDescriptor.jurisdictionTenant,
    fetchedAt: "2026-07-27T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test://",
    contentHash: "fixture",
  };
}

/** Live-verified 28286 boundary shape (planner U2 verify 2026-07-27). */
function boundaryAtoms28286(): BoundaryEdgeAtomInstance[] {
  const ring = PARCEL_28286_LIVE_TXGIO;
  return [
    buildTestBoundaryAtom(ring, {
      edgeIndex: 0,
      role: "rear",
      adjacencyKind: "unmapped",
      setbackKind: "unmapped-adjacency",
    }),
    buildTestBoundaryAtom(ring, {
      edgeIndex: 1,
      role: "side",
      adjacencyKind: "neighbor-parcel",
    }),
    buildTestBoundaryAtom(ring, {
      edgeIndex: 2,
      role: "front",
      adjacencyKind: "ROW",
      setbackFeet: 15,
    }),
    buildTestBoundaryAtom(ring, {
      edgeIndex: 3,
      role: "side_corner",
      adjacencyKind: "ROW",
    }),
  ];
}

describe("S2-U3 offset consumes boundary primitive", () => {
  it("U3.1 28286 front@edge2 via primitive yields ~7316 sqft (orientation-invariant)", () => {
    const atoms = boundaryAtoms28286();
    const candidate = computeWarmCandidateFromBoundary({
      parcelNodeId: `${COUNTY_FIPS}:${PROP_28286}`,
      district: "P-3",
      parcelRing: PARCEL_28286_LIVE_TXGIO,
      boundaryEdges: atoms,
    });

    expect(candidate.warmAgentId).toBe(BOUNDARY_PRIMITIVE_WARM_AGENT_ID);
    expect(candidate.empty, candidate.emptyReason).toBe(false);
    expect(candidate.insetFeetPerEdge).toEqual([0, 0, 15, 0]);
    expect(candidate.buildableAreaSqFt).toBeGreaterThan(6000);
    expect(candidate.buildableAreaSqFt).toBeLessThan(7600);
    expect(Math.round(candidate.buildableAreaSqFt ?? 0)).toBeGreaterThanOrEqual(7300);
  });

  it("U3.2 offset reads primitive — uses stored normals via the joined clipper input, not default insetRingMeters", () => {
    // 2026-08-07 (joined-structure invariant, master planner ruling): the
    // stored-normals path now routes through buildInsetClipperInput ->
    // insetRingMetersFromClipperInput, which calls insetRingMetersWithNormals
    // as a same-module internal call — invisible to a spy on the exported
    // binding (a standard ESM spy limitation, not a behavior change). Spy on
    // insetRingMetersFromClipperInput instead to observe the same "stored
    // normals, not derived normals" assertion this test exists to make.
    const spyDefault = vi.spyOn(polygonInset, "insetRingMeters");
    const spyStored = vi.spyOn(polygonInset, "insetRingMetersFromClipperInput");

    const atoms = boundaryAtoms28286();
    computeWarmCandidate({
      parcelNodeId: `${COUNTY_FIPS}:${PROP_28286}`,
      district: "P-3",
      parcelRing: PARCEL_28286_LIVE_TXGIO,
      descriptor: bastropDescriptor,
      roads: [],
      edgeLabels: [],
      boundaryEdges: atoms,
    });

    expect(spyDefault).not.toHaveBeenCalled();
    expect(spyStored).toHaveBeenCalled();

    spyDefault.mockRestore();
    spyStored.mockRestore();
  });

  it("U3.3 unmapped edge declines honestly — no fabricated setback feet", () => {
    const ring = PARCEL_28286_LIVE_TXGIO;
    const unmapped = buildTestBoundaryAtom(ring, {
      edgeIndex: 0,
      role: "rear",
      adjacencyKind: "unmapped",
      setbackKind: "unmapped-adjacency",
    });

    expect(setbackFeetFromBoundaryAtom(unmapped)).toBe(0);
    expect("feet" in unmapped.setback).toBe(false);

    const candidate = computeWarmCandidateFromBoundary({
      parcelNodeId: `${COUNTY_FIPS}:${PROP_28286}`,
      district: "P-3",
      parcelRing: ring,
      boundaryEdges: [unmapped, ...boundaryAtoms28286().slice(1)],
    });

    expect(candidate.insetFeetPerEdge[0]).toBe(0);
    expect(candidate.edges.find((e) => e.index === 0)?.insetFeet).toBe(0);
  });

  it("U3.4 genuine-self-touch negative fixture still rejected (guard not weakened)", () => {
    const orig: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const genuine: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 10, y: 0 },
      { x: 0, y: 20 },
    ];
    expect(ringHasSelfTouch(genuine)).toBe(true);
    expect(
      polygonInset.isInsetDegenerate(orig, genuine, [0, 0, 0, 0]),
    ).toBe(true);
  });
});
