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

/** Extract the outer ring from GeoJSON Polygon or first part of MultiPolygon. */
export function geometryOuterRing(geometry: unknown): RingLngLat | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    return asRing(g.coordinates[0]);
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0];
    if (Array.isArray(first)) return asRing(first[0]);
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
