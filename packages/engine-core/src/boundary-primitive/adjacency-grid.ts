/**
 * PRE-2 adjacency: one-load cell grid + 3 m outward probe + PIP.
 * Lazy per-parcel neighbor lookup — no full-county precompute on index build.
 */

import { openRing, projectRing, type Ring } from "../depth-warm/geometry.js";
import { pointInOrOnPolygon, signedArea } from "../geometry/polygon-inset.js";
import type { ParcelAdjacencyIndex, ParcelIndexEntry } from "./types.js";
import { ADJACENCY_PROBE_DISTANCE_M, ADJACENCY_CELL_DEG } from "./types.js";

export { ADJACENCY_PROBE_DISTANCE_M, ADJACENCY_CELL_SIZE_M, ADJACENCY_BBOX_PAD_M, ADJACENCY_CELL_DEG } from "./types.js";
const BBOX_PAD_DEG = 0.00008;

type IndexedParcel = ParcelIndexEntry & {
  edgeProj: { x: number; y: number }[];
  pipPoints: { x: number; y: number }[];
  originLng: number;
  originLat: number;
  mPerDegLng: number;
  mPerDegLat: number;
  ccw: boolean;
};

function cellKey(lng: number, lat: number, cellDeg: number): string {
  return `${Math.floor(lng / cellDeg)},${Math.floor(lat / cellDeg)}`;
}

function buildCellGrid(
  parcels: IndexedParcel[],
  cellDeg: number,
): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i]!;
    const minX = Math.floor(p.westLng / cellDeg);
    const maxX = Math.floor(p.eastLng / cellDeg);
    const minY = Math.floor(p.southLat / cellDeg);
    const maxY = Math.floor(p.northLat / cellDeg);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const k = `${x},${y}`;
        const arr = grid.get(k) ?? [];
        arr.push(i);
        grid.set(k, arr);
      }
    }
  }
  return grid;
}

function neighborForEdge(
  parcels: IndexedParcel[],
  grid: Map<string, number[]>,
  cellDeg: number,
  selfIdx: number,
  edgeIndex: number,
): string | null {
  const me = parcels[selfIdx]!;
  const open = me.ring;
  const n = open.length;
  const [lng0, lat0] = open[edgeIndex]!;
  const [lng1, lat1] = open[(edgeIndex + 1) % n]!;
  const midLng = (lng0 + lng1) / 2;
  const midLat = (lat0 + lat1) / 2;
  const a = me.edgeProj[edgeIndex]!;
  const b = me.edgeProj[(edgeIndex + 1) % n]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const leftX = -dy / len;
  const leftY = dx / len;
  const inwardX = me.ccw ? leftX : -leftX;
  const inwardY = me.ccw ? leftY : -leftY;
  const outX = -inwardX;
  const outY = -inwardY;
  const probeLng = midLng + (outX * ADJACENCY_PROBE_DISTANCE_M) / me.mPerDegLng;
  const probeLat = midLat + (outY * ADJACENCY_PROBE_DISTANCE_M) / me.mPerDegLat;

  const cx = Math.floor(probeLng / cellDeg);
  const cy = Math.floor(probeLat / cellDeg);
  const seen = new Set<number>();
  for (let dxC = -1; dxC <= 1; dxC++) {
    for (let dyC = -1; dyC <= 1; dyC++) {
      const arr = grid.get(`${cx + dxC},${cy + dyC}`);
      if (!arr) continue;
      for (const ci of arr) {
        if (ci === selfIdx || seen.has(ci)) continue;
        seen.add(ci);
        const cand = parcels[ci]!;
        if (
          probeLng < cand.westLng - BBOX_PAD_DEG ||
          probeLng > cand.eastLng + BBOX_PAD_DEG ||
          probeLat < cand.southLat - BBOX_PAD_DEG ||
          probeLat > cand.northLat + BBOX_PAD_DEG
        ) {
          continue;
        }
        const px = (probeLng - cand.originLng) * cand.mPerDegLng;
        const py = (probeLat - cand.originLat) * cand.mPerDegLat;
        if (pointInOrOnPolygon({ x: px, y: py }, cand.pipPoints, 0.5)) {
          return cand.propId;
        }
      }
    }
  }
  return null;
}

export function exteriorRingFromGeoJson(geometry: unknown): Ring | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as {
    type?: string;
    coordinates?: number[][][] | number[][][][];
  };
  if (g.type === "Polygon" && Array.isArray(g.coordinates?.[0])) {
    return g.coordinates[0].map((c) => [c[0]!, c[1]!] as [number, number]);
  }
  if (g.type === "MultiPolygon") {
    const mp = g.coordinates as number[][][][] | undefined;
    const ring = mp?.[0]?.[0];
    if (!Array.isArray(ring)) return null;
    return ring.map((c) => [c[0]!, c[1]!] as [number, number]);
  }
  return null;
}

function parseIndexedEntry(entry: ParcelIndexEntry): IndexedParcel | null {
  const open = openRing(entry.ring);
  if (open.length < 3) return null;
  const proj = projectRing(open);
  if (!proj || proj.points.length < 3) return null;
  const edgeProj = open.map(([lng, lat]) => ({
    x: (lng - proj.originLng) * proj.mPerDegLng,
    y: (lat - proj.originLat) * proj.mPerDegLat,
  }));
  return {
    ...entry,
    ring: open,
    edgeProj,
    pipPoints: proj.points,
    originLng: proj.originLng,
    originLat: proj.originLat,
    mPerDegLng: proj.mPerDegLng,
    mPerDegLat: proj.mPerDegLat,
    ccw: signedArea(edgeProj) > 0,
  };
}

export function buildParcelAdjacencyIndex(
  countyFips: string,
  entries: ReadonlyArray<ParcelIndexEntry>,
): ParcelAdjacencyIndex {
  const indexed: IndexedParcel[] = [];
  const byParcel = new Map<string, ParcelIndexEntry>();
  const byPropId = new Map<string, number>();
  for (const entry of entries) {
    const parsed = parseIndexedEntry(entry);
    if (!parsed) continue;
    byPropId.set(parsed.propId, indexed.length);
    indexed.push(parsed);
    byParcel.set(entry.parcelNodeId, parsed);
  }
  const grid = buildCellGrid(indexed, ADJACENCY_CELL_DEG);
  const originLat =
    indexed.reduce((s, p) => s + (p.southLat + p.northLat) / 2, 0) /
    Math.max(1, indexed.length);
  const originLng =
    indexed.reduce((s, p) => s + (p.westLng + p.eastLng) / 2, 0) /
    Math.max(1, indexed.length);
  const latRad = (originLat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  return {
    countyFips,
    originLng,
    originLat,
    mPerDegLng: mPerDegLat * Math.cos(latRad),
    mPerDegLat,
    entries: byParcel,
    _indexed: indexed,
    _grid: grid,
    _byPropId: byPropId,
  };
}

export function getParcelEdgeNeighbors(
  index: ParcelAdjacencyIndex,
  parcelNodeId: string,
): ReadonlyArray<string | null> | null {
  const entry = index.entries.get(parcelNodeId);
  if (!entry) return null;
  const selfIdx = index._byPropId.get(entry.propId);
  if (selfIdx === undefined) return null;
  const me = index._indexed[selfIdx]!;
  const out: Array<string | null> = [];
  for (let e = 0; e < me.ring.length; e++) {
    out.push(
      neighborForEdge(index._indexed, index._grid, ADJACENCY_CELL_DEG, selfIdx, e),
    );
  }
  return out;
}
