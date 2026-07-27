/**
 * S2-U3 — offset consumes boundary primitive (adjacency-FACT + stored interior).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";

import {
  insetPerEdgeFromPrimitive,
  openRing,
  ringAreaSqFt,
  type Ring,
} from "../depth-warm/geometry.js";
import type { WarmCandidate, WarmEdgeInfo, WarmRoadSource } from "../depth-warm/types.js";

export const BOUNDARY_PRIMITIVE_WARM_AGENT_ID =
  "depth-warm-boundary-primitive-v1" as const;

/** Honest setback feet from stored boundary atom — never fabricate on unmapped. */
export function setbackFeetFromBoundaryAtom(
  atom: BoundaryEdgeAtomInstance,
): number {
  if ("kind" in atom.setback) return 0;
  return atom.setback.feet;
}

/** Map persisted boundary edges to warm edge info (label = adjacency-FACT role). */
export function boundaryEdgesToWarmEdgeInfo(
  atoms: ReadonlyArray<BoundaryEdgeAtomInstance>,
): WarmEdgeInfo[] {
  return [...atoms]
    .sort((a, b) => a.edgeIndex - b.edgeIndex)
    .map((atom) => ({
      index: atom.edgeIndex,
      label: atom.role,
      roadClass: atom.facingRoad?.classification,
      osmHighwayTag: atom.facingRoad?.osmHighwayTag,
      insetFeet: setbackFeetFromBoundaryAtom(atom),
    }));
}

export interface WarmFromBoundaryInput {
  parcelNodeId: string;
  district: string;
  parcelRing: Ring;
  boundaryEdges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  roads?: ReadonlyArray<WarmRoadSource>;
  warmAgentId?: string;
  warmAt?: string;
}

/**
 * Warm-compute from stored boundary primitive — no road-proximity re-label,
 * no inward re-derive at offset time.
 */
export function computeWarmCandidateFromBoundary(
  input: WarmFromBoundaryInput,
): WarmCandidate {
  const warmAt = input.warmAt ?? new Date().toISOString();
  const warmAgentId = input.warmAgentId ?? BOUNDARY_PRIMITIVE_WARM_AGENT_ID;
  const sorted = [...input.boundaryEdges].sort(
    (a, b) => a.edgeIndex - b.edgeIndex,
  );

  const edges = boundaryEdgesToWarmEdgeInfo(sorted);
  const edgeCount = openRing(input.parcelRing).length;

  const storedInset = sorted.map((atom) => ({
    edgeIndex: atom.edgeIndex,
    insetFeet: setbackFeetFromBoundaryAtom(atom),
    inwardNormal: atom.interior.inwardNormal,
  }));

  const insetFeetPerEdge = Array.from({ length: edgeCount }, (_, i) => {
    const hit = edges.find((e) => e.index === i);
    return hit?.insetFeet ?? 0;
  });

  const inset = insetPerEdgeFromPrimitive(input.parcelRing, storedInset);

  return {
    parcelNodeId: input.parcelNodeId,
    district: input.district,
    parcelRing: input.parcelRing,
    insetRing: inset.ring,
    insetFeetPerEdge,
    edges,
    roads: [...(input.roads ?? [])],
    buildableAreaSqFt: inset.areaSqFt,
    parcelAreaSqFt: inset.parcelAreaSqFt || ringAreaSqFt(input.parcelRing),
    empty: inset.empty,
    emptyReason: inset.emptyReason,
    warmAt,
    warmAgentId,
  };
}
