/**
 * Automated per-edge road proximity labeling for depth-warm (27c R4).
 *
 * Honest rules:
 * - roadClass + osmHighwayTag only when an edge is within proximity of a road centerline.
 * - At most one primary front (closest non-alley road).
 * - Alley-backed edges may carry alley roadClass on rear only.
 * - Unroaded edges stay side/rear without roadClass — never fabricate setbacks.
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import { projectRing, type Ring } from "./geometry.js";
import type { WarmEdgeRole, WarmRoadSource } from "./types.js";

/** Default max metres from edge midpoint to road centerline. */
export const DEFAULT_ROAD_PROXIMITY_THRESHOLD_M = 25;

/** OSM highway tags that must never win front labeling (pedestrian / non-ROW). */
export const FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS = new Set([
  "footway",
  "path",
  "steps",
  "cycleway",
  "pedestrian",
  "bridleway",
  "corridor",
  "platform",
  "bus_guideway",
  "proposed",
  "construction",
]);

export function isFrontEligibleRoad(road: WarmRoadSource): boolean {
  const tag = road.osmHighwayTag?.trim().toLowerCase() ?? "";
  if (!tag) return true;
  return !FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS.has(tag);
}

export interface EdgeLabelDraft {
  index: number;
  label: WarmEdgeRole;
  roadClass?: RoadClassification;
  osmHighwayTag?: string;
}

export type LabelEdgesResult =
  | { ok: true; edgeLabels: EdgeLabelDraft[] }
  | { ok: false; decline: string };

interface XY {
  x: number;
  y: number;
}

interface EdgeRoadHit {
  edgeIndex: number;
  distanceM: number;
  road: WarmRoadSource;
}

function midpoint(a: XY, b: XY): XY {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distPointToSegment(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function projectPolylineInFrame(
  polyline: Ring,
  frame: ReturnType<typeof projectRing>,
): XY[] | null {
  if (!frame) return null;
  return polyline.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

function minDistanceEdgeToPolyline(a: XY, b: XY, poly: XY[]): number {
  const mid = midpoint(a, b);
  let minD = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distPointToSegment(mid, poly[i]!, poly[i + 1]!);
    if (d < minD) minD = d;
  }
  if (poly.length === 1) {
    minD = Math.hypot(mid.x - poly[0]!.x, mid.y - poly[0]!.y);
  }
  return minD;
}

function isAlleyClassification(classification: RoadClassification): boolean {
  return classification === "alley";
}

function frontStreetPreference(classification: RoadClassification): number {
  if (classification === "residential") return 5;
  if (classification === "unclassified") return 4;
  if (classification === "minor_collector") return 3;
  if (classification === "major_collector") return 2;
  if (classification === "highway") return 1;
  return 0;
}

/**
 * Label parcel edges from road proximity. Returns decline when no edge is road-adjacent.
 */
export function labelEdgesFromRoads(input: {
  parcelRing: Ring;
  roads: ReadonlyArray<WarmRoadSource>;
  proximityThresholdM?: number;
}): LabelEdgesResult {
  const threshold = input.proximityThresholdM ?? DEFAULT_ROAD_PROXIMITY_THRESHOLD_M;
  const proj = projectRing(input.parcelRing);
  if (!proj || proj.points.length < 3) {
    return { ok: false, decline: "invalid-parcel-ring" };
  }
  if (input.roads.length === 0) {
    return { ok: false, decline: "no-roads-available" };
  }

  const n = proj.points.length;
  const hits: EdgeRoadHit[] = [];

  for (let i = 0; i < n; i++) {
    const a = proj.points[i]!;
    const b = proj.points[(i + 1) % n]!;
    for (const road of input.roads) {
      const poly = projectPolylineInFrame(road.polyline, proj);
      if (!poly || poly.length < 1) continue;
      const distanceM = minDistanceEdgeToPolyline(a, b, poly);
      if (distanceM <= threshold) {
        hits.push({ edgeIndex: i, distanceM, road });
      }
    }
  }

  if (hits.length === 0) {
    return { ok: false, decline: "no-road-adjacency" };
  }

  // Best hit per edge (closest road).
  const bestByEdge = new Map<number, EdgeRoadHit>();
  for (const hit of hits) {
    const prior = bestByEdge.get(hit.edgeIndex);
    if (!prior || hit.distanceM < prior.distanceM) {
      bestByEdge.set(hit.edgeIndex, hit);
    }
  }

  const nonAlleyHits = [...bestByEdge.values()].filter(
    (h) =>
      !isAlleyClassification(h.road.classification) &&
      isFrontEligibleRoad(h.road),
  );
  const alleyHits = [...bestByEdge.values()].filter((h) =>
    isAlleyClassification(h.road.classification),
  );

  let frontHit: EdgeRoadHit | null = null;
  if (nonAlleyHits.length > 0) {
    nonAlleyHits.sort((a, b) => {
      const dp = a.distanceM - b.distanceM;
      if (Math.abs(dp) > 2) return dp;
      return frontStreetPreference(b.road.classification) - frontStreetPreference(a.road.classification);
    });
    frontHit = nonAlleyHits[0]!;
  }

  let rearHit: EdgeRoadHit | null = null;
  if (alleyHits.length > 0) {
    alleyHits.sort((a, b) => a.distanceM - b.distanceM);
    rearHit =
      alleyHits.find((h) => h.edgeIndex !== frontHit?.edgeIndex) ?? alleyHits[0]!;
  } else if (frontHit && n >= 4) {
    const frontMid = midpoint(
      proj.points[frontHit.edgeIndex]!,
      proj.points[(frontHit.edgeIndex + 1) % n]!,
    );
    let maxDist = -1;
    for (const [edgeIndex] of bestByEdge) {
      if (edgeIndex === frontHit.edgeIndex) continue;
      const a = proj.points[edgeIndex]!;
      const b = proj.points[(edgeIndex + 1) % n]!;
      const mid = midpoint(a, b);
      const d = Math.hypot(mid.x - frontMid.x, mid.y - frontMid.y);
      if (d > maxDist) {
        maxDist = d;
        rearHit = { edgeIndex, distanceM: bestByEdge.get(edgeIndex)!.distanceM, road: bestByEdge.get(edgeIndex)!.road };
      }
    }
  }

  const edgeLabels: EdgeLabelDraft[] = [];
  for (let i = 0; i < n; i++) {
    if (frontHit && i === frontHit.edgeIndex) {
      edgeLabels.push({
        index: i,
        label: "front",
        roadClass: frontHit.road.classification,
        osmHighwayTag: frontHit.road.osmHighwayTag,
      });
      continue;
    }
    if (rearHit && i === rearHit.edgeIndex && isAlleyClassification(rearHit.road.classification)) {
      edgeLabels.push({
        index: i,
        label: "rear",
        roadClass: rearHit.road.classification,
        osmHighwayTag: rearHit.road.osmHighwayTag,
      });
      continue;
    }
    if (rearHit && i === rearHit.edgeIndex) {
      edgeLabels.push({ index: i, label: "rear" });
      continue;
    }
    const hit = bestByEdge.get(i);
    if (
      hit &&
      frontHit &&
      hit.road.osmWayId !== frontHit.road.osmWayId &&
      !isAlleyClassification(hit.road.classification)
    ) {
      edgeLabels.push({
        index: i,
        label: "side_corner",
        roadClass: hit.road.classification,
        osmHighwayTag: hit.road.osmHighwayTag,
      });
      continue;
    }
    edgeLabels.push({ index: i, label: "side" });
  }

  return { ok: true, edgeLabels };
}
