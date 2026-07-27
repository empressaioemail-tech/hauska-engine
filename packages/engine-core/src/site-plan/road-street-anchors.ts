/**
 * Map road-node atoms → site-plan STREET anchors (Track B1 / WDLL 1).
 *
 * Reuses the road-node centerline + baked ROW edges (assumed-per-class width).
 * No second road model — edges carry the live provenance kind from the atom.
 */

import type { RoadNodeAtomInstance } from "@hauska-engine/atoms";

import type { StreetAnchorInput } from "./site-model.js";

/** Minimal road-node shape the STREET mapper needs (full atom or test fixture). */
export interface RoadNodeStreetSource {
  roadNodeId: string;
  displayName?: string;
  centerline: { coordinates: ReadonlyArray<readonly [number, number]> };
  row: {
    assumedWidthFt: number;
    provenance: { kind: string };
    leftEdge: { coordinates: ReadonlyArray<readonly [number, number]> };
    rightEdge: { coordinates: ReadonlyArray<readonly [number, number]> };
  };
  sourceCitation?: string;
}

function toPairs(
  coords: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  return coords.map(([lng, lat]) => [lng, lat] as [number, number]);
}

/** Convert one road-node into a STREET anchor (centerline + ROW edges + provenance). */
export function streetAnchorFromRoadNode(road: RoadNodeStreetSource): StreetAnchorInput | null {
  const centerline = road.centerline?.coordinates;
  if (!Array.isArray(centerline) || centerline.length < 2) return null;
  const left = road.row?.leftEdge?.coordinates;
  const right = road.row?.rightEdge?.coordinates;
  if (!Array.isArray(left) || left.length < 2) return null;
  if (!Array.isArray(right) || right.length < 2) return null;
  const provenanceKind = road.row?.provenance?.kind;
  if (typeof provenanceKind !== "string" || provenanceKind.length === 0) return null;

  return {
    name: road.displayName?.trim() || road.roadNodeId,
    points: toPairs(centerline),
    leftEdgePoints: toPairs(left),
    rightEdgePoints: toPairs(right),
    roadNodeId: road.roadNodeId,
    rowProvenanceKind: provenanceKind,
    assumedWidthFt: road.row.assumedWidthFt,
    sourceRef: road.sourceCitation ?? road.roadNodeId,
  };
}

/** Map many road-nodes → STREET anchors; skips malformed atoms (never fabricates). */
export function streetAnchorsFromRoadNodes(
  roads: ReadonlyArray<RoadNodeStreetSource | RoadNodeAtomInstance>,
): StreetAnchorInput[] {
  const out: StreetAnchorInput[] = [];
  const seen = new Set<string>();
  for (const road of roads) {
    if (seen.has(road.roadNodeId)) continue;
    const anchor = streetAnchorFromRoadNode(road);
    if (!anchor) continue;
    seen.add(road.roadNodeId);
    out.push(anchor);
  }
  return out;
}
