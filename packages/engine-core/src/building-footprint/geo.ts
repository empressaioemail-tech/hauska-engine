/**
 * Lightweight geometry helpers for building-footprint planning.
 */

import type { RingLngLat } from "./types.js";

function asRing(coords: unknown): RingLngLat | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring: RingLngLat = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  return ring;
}

// Planar shoelace area in raw lng/lat degrees^2. Only used to compare parts
// of the SAME MultiPolygon feature against each other (same latitude, so the
// degrees-to-meters scale factor is identical for every candidate and cancels
// out of the comparison) -- not a real-world area, never used outside this
// ranking.
function ringAreaDeg2(ring: RingLngLat): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return Math.abs(a) / 2;
}

/**
 * Extract the outer ring from a GeoJSON Polygon, or the LARGEST-area part of
 * a MultiPolygon. A MultiPolygon's coordinate order is not guaranteed to put
 * the dominant tract first -- always taking part [0] risks joining against
 * an arbitrary sliver on a non-contiguous rural parcel instead of the real
 * primary tract. This does not model secondary tracts (still a single ring
 * out), just picks the one part most likely to be the parcel/footprint's
 * real extent.
 */
export function geometryOuterRing(geometry: unknown): RingLngLat | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    return asRing(g.coordinates[0]);
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    let best: RingLngLat | null = null;
    let bestArea = -1;
    for (const part of g.coordinates) {
      if (!Array.isArray(part)) continue;
      const ring = asRing(part[0]);
      if (!ring) continue;
      const area = ringAreaDeg2(ring);
      if (area > bestArea) {
        bestArea = area;
        best = ring;
      }
    }
    return best;
  }
  return null;
}

export function ringToFootprintGeometry(
  ring: RingLngLat,
): { type: "Polygon"; coordinates: RingLngLat[] } {
  const closed = [...ring];
  const first = closed[0]!;
  const last = closed[closed.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    closed.push([first[0], first[1]]);
  }
  return { type: "Polygon", coordinates: [closed] };
}

export function bboxContainsRing(
  bbox: {
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  },
  ring: RingLngLat,
): boolean {
  for (const [lng, lat] of ring) {
    if (
      lng >= bbox.westLng &&
      lng <= bbox.eastLng &&
      lat >= bbox.southLat &&
      lat <= bbox.northLat
    ) {
      return true;
    }
  }
  return false;
}
