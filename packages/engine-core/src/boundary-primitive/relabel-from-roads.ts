/**
 * R30 — re-derive boundary-edge ROLES from fresh road labeling on re-warm.
 *
 * The stored primitive carries correct inward normals but stale role/facingRoad
 * when ring vertex count or winding changed since the primitive was baked.
 * Re-warm must apply fresh labelEdgesFromRoads output to the stored atoms —
 * never reuse stale roles (same class as R28 winding fix for normals).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { roadNodeIdFromParts } from "@hauska-engine/atoms";

import type { EdgeLabelDraft } from "../depth-warm/edgeLabeling.js";
import type { WarmRoadSource } from "../depth-warm/types.js";

export interface RelabelBoundaryEdgesInput {
  storedEdges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  edgeLabels: ReadonlyArray<EdgeLabelDraft>;
  roads: ReadonlyArray<WarmRoadSource>;
  countyFips: string;
}

function facingRoadFromLabel(
  label: EdgeLabelDraft,
  roads: ReadonlyArray<WarmRoadSource>,
  countyFips: string,
): BoundaryEdgeAtomInstance["facingRoad"] {
  if (!label.roadClass || typeof label.osmWayId !== "number") return null;
  const matched =
    roads.find((r) => r.osmWayId === label.osmWayId) ??
    roads.find(
      (r) =>
        r.classification === label.roadClass &&
        (!label.osmHighwayTag || r.osmHighwayTag === label.osmHighwayTag),
    );
  if (!matched) return null;
  return {
    roadNodeId: roadNodeIdFromParts(countyFips, matched.osmWayId),
    classification: matched.classification,
    provenance: "osm-overpass-v1",
    osmHighwayTag: matched.osmHighwayTag,
  };
}

/**
 * Apply fresh road labels to stored boundary edges (geometry/interior unchanged).
 * Edges without a label draft keep their stored role.
 */
export function relabelBoundaryEdgesFromRoadLabels(
  input: RelabelBoundaryEdgesInput,
): BoundaryEdgeAtomInstance[] {
  const labelByIndex = new Map(input.edgeLabels.map((e) => [e.index, e]));
  return [...input.storedEdges]
    .sort((a, b) => a.edgeIndex - b.edgeIndex)
    .map((atom) => {
      const label = labelByIndex.get(atom.edgeIndex);
      if (!label) return atom;
      const facingRoad = facingRoadFromLabel(label, input.roads, input.countyFips);
      const { frontBasis: _priorBasis, ...rest } = atom;
      return {
        ...rest,
        role: label.label,
        ...(label.label === "front" && label.frontBasis
          ? { frontBasis: label.frontBasis }
          : {}),
        facingRoad,
      };
    });
}
