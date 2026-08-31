/**
 * S2-U3 — offset consumes boundary primitive (adjacency-FACT + stored interior).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { classifyBoundaryEdgeSetback } from "@hauska-engine/adapters";

import {
  insetPerEdgeFromPrimitive,
  ringAreaSqFt,
  type Ring,
} from "../depth-warm/geometry.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import {
  buildFlatSetbackFallback,
  resolveInsetFeetForEdge,
} from "../depth-warm/warm-compute.js";
import type { WarmCandidate, WarmEdgeInfo, WarmRoadSource } from "../depth-warm/types.js";

export const BOUNDARY_PRIMITIVE_WARM_AGENT_ID =
  "depth-warm-boundary-primitive-v1" as const;

/**
 * Honest setback feet from a stored boundary atom.
 * Unmapped / no-row absence is 0 (declared empty inset).
 * Retired road-class and placeholder provenances must not return their feet —
 * callers that need a number after a refuse must handle the verdict first.
 */
export function setbackFeetFromBoundaryAtom(
  atom: BoundaryEdgeAtomInstance,
): number {
  const verdict = classifyBoundaryEdgeSetback(atom.setback);
  if (verdict.disposition === "absent") return 0;
  if (verdict.disposition !== "value") {
    throw new Error(
      `setbackFeetFromBoundaryAtom: ${verdict.disposition} (${verdict.basis})`,
    );
  }
  if ("kind" in atom.setback) return 0;
  return atom.setback.feet;
}

function refusedBoundarySetback(
  atoms: ReadonlyArray<BoundaryEdgeAtomInstance>,
): { disposition: "refused" | "unknown"; basis: string } | null {
  for (const atom of atoms) {
    const verdict = classifyBoundaryEdgeSetback(atom.setback);
    if (verdict.disposition === "refused" || verdict.disposition === "unknown") {
      return { disposition: verdict.disposition, basis: verdict.basis };
    }
  }
  return null;
}

/** Map persisted boundary edges to warm edge info (label = adjacency-FACT role). */
export function boundaryEdgesToWarmEdgeInfo(
  atoms: ReadonlyArray<BoundaryEdgeAtomInstance>,
): WarmEdgeInfo[] {
  const refused = refusedBoundarySetback(atoms);
  if (refused) {
    throw new Error(
      `boundaryEdgesToWarmEdgeInfo: ${refused.disposition} (${refused.basis})`,
    );
  }
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
  /** When per-parcel layer 23 overlays the table, use descriptor feet not stored atom feet. */
  descriptor?: JurisdictionDescriptor;
  /** GROUND-TRUTH FRAME LAW — see WarmCandidate.rawParcelRing. */
  rawParcelRing?: Ring;
}

function perParcelDescriptorSetbacks(descriptor?: JurisdictionDescriptor): boolean {
  return descriptor?.sourceAdapter === "bastrop-per-parcel-record-layer-23";
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

  const overlayDimensional = perParcelDescriptorSetbacks(input.descriptor);
  if (!overlayDimensional) {
    const refused = refusedBoundarySetback(sorted);
    if (refused) {
      return {
        parcelNodeId: input.parcelNodeId,
        district: input.district,
        parcelRing: input.parcelRing,
        insetRing: null,
        insetFeetPerEdge: [],
        edges: [],
        roads: [...(input.roads ?? [])],
        buildableAreaSqFt: 0,
        parcelAreaSqFt: ringAreaSqFt(input.parcelRing),
        empty: true,
        emptyReason: refused.basis,
        warmAt,
        warmAgentId,
        rawParcelRing: input.rawParcelRing ?? input.parcelRing,
      };
    }
  }

  const flatFallback =
    input.descriptor && overlayDimensional
      ? buildFlatSetbackFallback(input.descriptor, input.district)
      : null;

  const edges: WarmEdgeInfo[] = sorted.map((atom) => {
    const insetFeet =
      flatFallback && input.descriptor
        ? resolveInsetFeetForEdge(
            input.descriptor,
            input.district,
            {
              label: atom.role,
              roadClass: atom.facingRoad?.classification,
            },
            flatFallback,
          )
        : setbackFeetFromBoundaryAtom(atom);
    return {
      index: atom.edgeIndex,
      label: atom.role,
      roadClass: atom.facingRoad?.classification,
      osmHighwayTag: atom.facingRoad?.osmHighwayTag,
      insetFeet,
    };
  });

  const edgeCount = sorted.length;

  const storedInset = sorted.map((atom) => ({
    edgeIndex: atom.edgeIndex,
    insetFeet:
      edges.find((e) => e.index === atom.edgeIndex)?.insetFeet ??
      setbackFeetFromBoundaryAtom(atom),
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
    miterPointsWgs84: inset.miterPointsWgs84,
    rawParcelRing: input.rawParcelRing ?? input.parcelRing,
  };
}
