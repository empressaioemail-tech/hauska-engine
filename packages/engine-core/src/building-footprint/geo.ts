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

export function ringCentroid(ring: RingLngLat): { lng: number; lat: number } {
  let sx = 0;
  let sy = 0;
  for (const [lng, lat] of ring) {
    sx += lng;
    sy += lat;
  }
  return { lng: sx / ring.length, lat: sy / ring.length };
}

export function bboxFromRing(ring: RingLngLat): {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
} | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of ring) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  if (!Number.isFinite(west)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

export function bboxArea(bbox: {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}): number {
  return Math.max(0, bbox.eastLng - bbox.westLng) * Math.max(0, bbox.northLat - bbox.southLat);
}

export function bboxContainsPoint(
  bbox: {
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  },
  point: { lng: number; lat: number },
): boolean {
  return (
    point.lng >= bbox.westLng &&
    point.lng <= bbox.eastLng &&
    point.lat >= bbox.southLat &&
    point.lat <= bbox.northLat
  );
}
