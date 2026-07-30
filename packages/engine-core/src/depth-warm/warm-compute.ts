/**
 * Background warm writer (27c R3 WDLL 6): roads label edges; district table
 * supplies setback VALUES (WDLL 7 / RULING 2 — road-class VALUE path retired).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import type { RoadClassification } from "@hauska-engine/atoms";

import { computeWarmCandidateFromBoundary } from "../boundary-primitive/consume.js";
import { resolveDistrictEdgeSetback } from "../property-reasoning/resolve-road-class-setback.js";
import type { JurisdictionDescriptor, RoadEdgeRole } from "../property-reasoning/types.js";
import {
  insetPerEdge,
  openRing,
  projectRing,
  ringAreaSqFt,
  type Ring,
} from "./geometry.js";
import type { WarmCandidate, WarmEdgeInfo, WarmRoadSource } from "./types.js";

export interface WarmComputeInput {
  parcelNodeId: string;
  district: string;
  parcelRing: Ring;
  descriptor: JurisdictionDescriptor;
  roads: WarmRoadSource[];
  /** Per-edge labeling from road proximity (warm agent output). */
  edgeLabels: Array<{
    index: number;
    label: WarmEdgeInfo["label"];
    roadClass?: RoadClassification;
    osmHighwayTag?: string;
    osmSurfaceTag?: string;
    roadProvenanceKind?: WarmEdgeInfo["roadProvenanceKind"];
  }>;
  /** When present, offset consumes stored boundary primitive (S2-U3). */
  boundaryEdges?: ReadonlyArray<BoundaryEdgeAtomInstance>;
  warmAgentId?: string;
  warmAt?: string;
}

export interface FlatSetbackFallback {
  front: number;
  side: number;
  rear: number;
  sideCorner: number;
}

/**
 * Shared warm + verify inset lookup from flat district setbackTable only.
 * Honest absence → 0 (never invent a legacy B3 front fallback).
 */
export function buildFlatSetbackFallback(
  descriptor: JurisdictionDescriptor,
  district: string,
): FlatSetbackFallback {
  const axis = (role: RoadEdgeRole): number => {
    const hit = resolveDistrictEdgeSetback(descriptor, district, role);
    return "kind" in hit ? 0 : hit.value;
  };
  return {
    front: axis("front"),
    side: axis("side"),
    rear: axis("rear"),
    sideCorner: axis("side_corner"),
  };
}

/**
 * Inset feet for an edge ROLE from the flat district table.
 * Road class on the edge is ignored for the NUMBER (may still be stored for twin).
 */
export function resolveInsetFeetForEdge(
  _descriptor: JurisdictionDescriptor,
  _district: string,
  edge: {
    label: WarmEdgeInfo["label"];
    roadClass?: RoadClassification;
  },
  flatFallback: FlatSetbackFallback,
): number {
  if (edge.label === "front") return flatFallback.front;
  if (edge.label === "rear") return flatFallback.rear;
  if (edge.label === "side_corner") return flatFallback.sideCorner;
  return flatFallback.side;
}

type EdgeLabelDraft = WarmComputeInput["edgeLabels"][number];

/**
 * Honest partial inset (R3.1 / R4.1): when full road labeling collapses the
 * lot, keep only the front edge's roadClass metadata — never fabricate
 * not_specified axes. After WDLL 7, roadClass no longer changes inset feet;
 * retained for twin/provenance continuity on the retry path.
 */
export function stripNonFrontRoadClass(edgeLabels: EdgeLabelDraft[]): EdgeLabelDraft[] {
  return edgeLabels.map((e) => {
    if (e.label === "front" && e.roadClass) {
      return {
        index: e.index,
        label: e.label,
        roadClass: e.roadClass,
        osmHighwayTag: e.osmHighwayTag,
        osmSurfaceTag: e.osmSurfaceTag,
        roadProvenanceKind: e.roadProvenanceKind,
      };
    }
    return { index: e.index, label: e.label };
  });
}

function computeWarmCandidateWithLabels(
  input: WarmComputeInput,
  edgeLabels: EdgeLabelDraft[],
): WarmCandidate {
  const warmAt = input.warmAt ?? new Date().toISOString();
  const warmAgentId = input.warmAgentId ?? "depth-warm-agent-v1";
  const proj = projectRing(input.parcelRing);
  const edgeCount = proj?.points.length ?? openRing(input.parcelRing).length;

  const flatFallback = buildFlatSetbackFallback(input.descriptor, input.district);

  const edges: WarmEdgeInfo[] = edgeLabels.map((e) => ({
    index: e.index,
    label: e.label,
    roadClass: e.roadClass,
    osmHighwayTag: e.osmHighwayTag,
    osmSurfaceTag: e.osmSurfaceTag,
    roadProvenanceKind: e.roadProvenanceKind,
    insetFeet: resolveInsetFeetForEdge(
      input.descriptor,
      input.district,
      e,
      flatFallback,
    ),
  }));

  const insetFeetPerEdge = Array.from({ length: edgeCount }, (_, i) => {
    const hit = edges.find((e) => e.index === i);
    return hit?.insetFeet ?? flatFallback.side;
  });

  const inset = insetPerEdge(input.parcelRing, insetFeetPerEdge);

  return {
    parcelNodeId: input.parcelNodeId,
    district: input.district,
    parcelRing: input.parcelRing,
    insetRing: inset.ring,
    insetFeetPerEdge,
    edges,
    roads: input.roads,
    buildableAreaSqFt: inset.areaSqFt,
    parcelAreaSqFt: inset.parcelAreaSqFt || ringAreaSqFt(input.parcelRing),
    empty: inset.empty,
    emptyReason: inset.emptyReason,
    warmAt,
    warmAgentId,
  };
}

/**
 * Warm-compute envelope geometry + per-edge setbacks from flat district table.
 * Roads label which edge is front; they do not supply the setback NUMBER.
 * When boundaryEdges are supplied, consumes stored primitive (no proxy re-derive).
 */
export function computeWarmCandidate(input: WarmComputeInput): WarmCandidate {
  if (input.boundaryEdges && input.boundaryEdges.length > 0) {
    return computeWarmCandidateFromBoundary({
      parcelNodeId: input.parcelNodeId,
      district: input.district,
      parcelRing: input.parcelRing,
      boundaryEdges: input.boundaryEdges,
      roads: input.roads,
      warmAgentId: input.warmAgentId,
      warmAt: input.warmAt,
    });
  }
  const full = computeWarmCandidateWithLabels(input, input.edgeLabels);
  if (!full.empty && full.insetRing) {
    return full;
  }
  const partialLabels = stripNonFrontRoadClass(input.edgeLabels);
  const changed = partialLabels.some((p) => {
    const orig = input.edgeLabels.find((e) => e.index === p.index);
    return p.roadClass !== orig?.roadClass || p.osmHighwayTag !== orig?.osmHighwayTag;
  });
  if (!changed) {
    return full;
  }
  const partial = computeWarmCandidateWithLabels(input, partialLabels);
  if (!partial.empty && partial.insetRing) {
    return partial;
  }
  return full;
}

/** Inject a known-bad warm result (parcel ring passed off as inset) for verify RED demo. */
export function injectBadWarmCandidate(
  good: WarmCandidate,
  reason = "injected-bad-inset",
): WarmCandidate {
  return {
    ...good,
    insetRing: good.parcelRing,
    buildableAreaSqFt: good.parcelAreaSqFt,
    empty: false,
    emptyReason: reason,
    warmAgentId: "depth-warm-bad-inject-demo",
  };
}
