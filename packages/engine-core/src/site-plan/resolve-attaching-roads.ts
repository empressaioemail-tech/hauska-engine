/**
 * Resolve road-node atoms that attach to a parcel frontage (Track B1).
 *
 * Prefer property-boundary-edge facingRoad refs. Fallback: county road-nodes
 * whose centerline intersects an expanded parcel bbox, then proximity-filter
 * against parcel edges (same 25 m threshold as depth-warm edge labeling).
 * Honest absence when neither path yields an attach — never fabricate STREET.
 */

import type {
  BoundaryEdgeAtomInstance,
  RoadNodeAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import {
  DEFAULT_ROAD_PROXIMITY_THRESHOLD_M,
  labelEdgesFromRoads,
} from "../depth-warm/edgeLabeling.js";
import { roadAtomToWarmSource } from "../road-intake/road-to-warm-source.js";
import { streetAnchorsFromRoadNodes } from "./road-street-anchors.js";
import type { StreetAnchorInput } from "./site-model.js";

const METERS_PER_DEG_LAT = 111_320;
/** ~50 m buffer so ROW edges near the parcel still enter the bbox candidate set. */
const BBOX_BUFFER_M = 50;

export interface ParcelBboxWgs84 {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export function expandRingBbox(
  ringWgs84: ReadonlyArray<readonly [number, number]>,
  bufferMeters = BBOX_BUFFER_M,
): ParcelBboxWgs84 | null {
  if (ringWgs84.length < 3) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lng, lat] of ringWgs84) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const midLat = (south + north) / 2;
  const dLat = bufferMeters / METERS_PER_DEG_LAT;
  const dLng =
    bufferMeters /
    (METERS_PER_DEG_LAT * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return {
    westLng: west - dLng,
    eastLng: east + dLng,
    southLat: south - dLat,
    northLat: north + dLat,
  };
}

function parseCountyFips(parcelNodeId: string): string | null {
  const match = /^(\d{5}):/.exec(parcelNodeId.trim());
  return match ? match[1]! : null;
}

export function roadIdsFromBoundaryEdges(
  edges: ReadonlyArray<BoundaryEdgeAtomInstance>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.adjacencyKind !== "ROW" && edge.adjacencyKind !== "alley") continue;
    const id = edge.facingRoad?.roadNodeId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function loadRoadsByIds(
  storage: StoragePort,
  roadNodeIds: ReadonlyArray<string>,
): Promise<RoadNodeAtomInstance[]> {
  const out: RoadNodeAtomInstance[] = [];
  const seen = new Set<string>();
  for (const id of roadNodeIds) {
    const rows = await storage.listRoadAtomsByRoadNodeId(id);
    const road = rows[0];
    if (!road || seen.has(road.roadNodeId)) continue;
    seen.add(road.roadNodeId);
    out.push(road);
  }
  return out;
}

/**
 * Keep road-nodes whose centerline is within proximity of any parcel edge
 * (depth-warm threshold). Pure — used by storage-backed resolve and tests.
 */
export function filterRoadsAttachingByProximity(
  ringWgs84: ReadonlyArray<readonly [number, number]>,
  candidates: ReadonlyArray<RoadNodeAtomInstance>,
  proximityThresholdM = DEFAULT_ROAD_PROXIMITY_THRESHOLD_M,
): RoadNodeAtomInstance[] {
  const ring = ringWgs84.map(([lng, lat]) => [lng, lat] as [number, number]);
  const attached: RoadNodeAtomInstance[] = [];
  for (const candidate of candidates) {
    const warm = roadAtomToWarmSource(candidate);
    if (!warm) continue;
    const solo = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [warm],
      proximityThresholdM,
    });
    if (!solo.ok) continue;
    if (solo.edgeLabels.some((e) => e.roadClass != null)) {
      attached.push(candidate);
    }
  }
  return attached;
}

export interface ResolveAttachingRoadNodesResult {
  roads: RoadNodeAtomInstance[];
  streetAnchors: StreetAnchorInput[];
  source: "boundary-edge" | "proximity" | "none";
  reason?: string;
}

/**
 * Load attaching road-nodes for a parcel and map them to STREET anchors.
 */
export async function resolveAttachingRoadNodes(input: {
  parcelNodeId: string;
  ringWgs84: ReadonlyArray<readonly [number, number]>;
  storage: StoragePort;
}): Promise<ResolveAttachingRoadNodesResult> {
  const edges = await input.storage.listBoundaryEdgesByParcelNodeId(input.parcelNodeId);
  const fromEdges = roadIdsFromBoundaryEdges(edges);
  if (fromEdges.length > 0) {
    const roads = await loadRoadsByIds(input.storage, fromEdges);
    const streetAnchors = streetAnchorsFromRoadNodes(roads);
    if (streetAnchors.length > 0) {
      return { roads, streetAnchors, source: "boundary-edge" };
    }
  }

  const countyFips = parseCountyFips(input.parcelNodeId);
  const bbox = expandRingBbox(input.ringWgs84);
  if (countyFips && bbox && typeof input.storage.listRoadAtomsNearBbox === "function") {
    const candidates = await input.storage.listRoadAtomsNearBbox(countyFips, bbox);
    const proximityRoads = filterRoadsAttachingByProximity(input.ringWgs84, candidates);
    const streetAnchors = streetAnchorsFromRoadNodes(proximityRoads);
    if (streetAnchors.length > 0) {
      return { roads: proximityRoads, streetAnchors, source: "proximity" };
    }
  }

  return {
    roads: [],
    streetAnchors: [],
    source: "none",
    reason:
      "No road-node attaches to this parcel (no ROW/alley boundary-edge facingRoad and no road-node within proximity of the parcel ring).",
  };
}
