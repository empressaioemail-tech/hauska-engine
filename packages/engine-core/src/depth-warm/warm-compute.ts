/**
 * Background warm writer (27c R3 WDLL 6): roads + road-class setbacks + envelope.
 * Depth-over-breadth — caller supplies parcel ring + district + edge labeling inputs.
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import { resolveRoadClassSetback } from "../property-reasoning/resolve-road-class-setback.js";
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
  }>;
  warmAgentId?: string;
  warmAt?: string;
}

function warmEdgeRoleToRoadRole(label: WarmEdgeInfo["label"]): RoadEdgeRole {
  if (label === "side_corner") return "side_corner";
  return label;
}

function resolveInsetFeetForEdge(
  descriptor: JurisdictionDescriptor,
  district: string,
  edge: WarmComputeInput["edgeLabels"][number],
  flatFallback: { front: number; side: number; rear: number },
): number {
  if (edge.roadClass) {
    const hit = resolveRoadClassSetback(
      descriptor,
      district,
      edge.roadClass,
      warmEdgeRoleToRoadRole(edge.label),
    );
    if (!("kind" in hit)) return hit.value;
  }
  if (edge.label === "front") return flatFallback.front;
  if (edge.label === "rear") return flatFallback.rear;
  return flatFallback.side;
}

type EdgeLabelDraft = WarmComputeInput["edgeLabels"][number];

/**
 * Honest partial inset (R3.1 / R4.1): when full road-class labeling collapses the
 * lot, keep only the front edge's roadClass — never fabricate not_specified axes.
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

  const flatFront = resolveRoadClassSetback(
    input.descriptor,
    input.district,
    "residential",
    "front",
  );
  const flatSide = resolveRoadClassSetback(
    input.descriptor,
    input.district,
    "residential",
    "side",
  );
  const flatRear = resolveRoadClassSetback(
    input.descriptor,
    input.district,
    "residential",
    "rear",
  );
  const flatFallback = {
    front: "kind" in flatFront ? 15 : flatFront.value,
    side: "kind" in flatSide ? 0 : flatSide.value,
    rear: "kind" in flatRear ? 0 : flatRear.value,
  };

  const edges: WarmEdgeInfo[] = edgeLabels.map((e) => ({
    index: e.index,
    label: e.label,
    roadClass: e.roadClass,
    osmHighwayTag: e.osmHighwayTag,
    osmSurfaceTag: e.osmSurfaceTag,
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
 * Warm-compute envelope geometry + per-edge setbacks from road-class table.
 * Retries with honest partial inset when full labeling leaves no buildable area.
 */
export function computeWarmCandidate(input: WarmComputeInput): WarmCandidate {
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
