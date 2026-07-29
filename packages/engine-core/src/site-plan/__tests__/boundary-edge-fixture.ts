/**
 * Test fixture helper: build the export's boundary-primitive geometry input
 * from a parcel ring the same way the bake does — stored inward normals come
 * from `computeParcelInteriorFacts` (S2-U2), never re-derived ad hoc.
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

import { computeParcelInteriorFacts } from "../../boundary-primitive/interior.js";
import type { Ring } from "../../depth-warm/geometry.js";
import type { BoundaryEdgeGeometryInput } from "../ring-geometry.js";

export interface BoundaryEdgeSpec {
  role: "front" | "side" | "rear" | "side_corner";
  /** Stored resolved setback feet. Omit (with `absent`) for honest absence. */
  feet?: number;
  /** Stored setback absence (no-setback-row / unmapped-adjacency). */
  absent?: boolean;
}

/** One spec per ring edge, in edge-index order (open-ring indexing). */
export function boundaryEdgesForRing(
  ring: Ring,
  specs: ReadonlyArray<BoundaryEdgeSpec>,
): BoundaryEdgeGeometryInput[] {
  const facts = computeParcelInteriorFacts(ring);
  if (!facts) throw new Error("fixture ring is not a valid polygon");
  if (facts.edges.length !== specs.length) {
    throw new Error(
      `fixture spec count ${specs.length} != ring edge count ${facts.edges.length}`,
    );
  }
  return specs.map((spec, i) => {
    const edge = facts.edges.find((e) => e.edgeIndex === i)!;
    return {
      edgeIndex: i,
      role: spec.role,
      insetFeet: spec.absent ? 0 : spec.feet ?? 0,
      setbackAbsent: spec.absent === true,
      inwardNormal: edge.inwardNormal,
    };
  });
}

export interface BoundaryAtomSpec {
  role: BoundaryEdgeAtomInstance["role"];
  adjacencyKind: BoundaryEdgeAtomInstance["adjacencyKind"];
  setbackFeet?: number;
  absent?: boolean;
}

/** Full persisted-shape boundary atoms (stored interior from the bake path). */
export function boundaryAtomInstancesForRing(
  countyFips: string,
  propId: string,
  ring: Ring,
  specs: ReadonlyArray<BoundaryAtomSpec>,
): BoundaryEdgeAtomInstance[] {
  const facts = computeParcelInteriorFacts(ring);
  if (!facts) throw new Error("fixture ring is not a valid polygon");
  if (facts.edges.length !== specs.length) {
    throw new Error(`spec count ${specs.length} != ring edge count ${facts.edges.length}`);
  }
  return specs.map((spec, i) => {
    const edgeInterior = facts.edges.find((e) => e.edgeIndex === i)!;
    const boundaryEdgeId = `${countyFips}:${propId}:boundary:${i}`;
    return {
      entityType: "property-boundary-edge",
      atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: `${countyFips}:${propId}`,
      countyFips,
      propId,
      edgeIndex: i,
      role: spec.role,
      adjacencyKind: spec.adjacencyKind,
      parcelNeighborPropId: null,
      facingRoad: null,
      setback: spec.absent
        ? { kind: "no-setback-row" as const, reason: "fixture: code silent on this edge" }
        : {
            feet: spec.setbackFeet ?? 0,
            provenance: "road-class-setback-table",
            atomCitation: "bastrop-tx",
          },
      interior: {
        ringCcw: edgeInterior.ringCcw,
        centroidInside: edgeInterior.centroidInside,
        inwardNormal: edgeInterior.inwardNormal,
        edgeEndpoints: edgeInterior.edgeEndpoints,
      },
      effectiveDate: "2026-07-28",
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy: "platform-internal",
      sourceCitation: "site-plan primitive fixture",
      extractedAt: "2026-07-28T00:00:00.000Z",
      atomTier: "data",
      jurisdictionTenant: "bastrop-tx",
      fetchedAt: "2026-07-28T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "test://",
      contentHash: "fixture",
    };
  });
}
