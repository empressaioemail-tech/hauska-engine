/**
 * Easement ↔ parcel spatial helpers (ingest spec §4.2).
 */

import polygonClipping from "polygon-clipping";

import type { EasementGeometry } from "@empressaio/atom-contract/property";

export type RingLngLat = Array<[number, number]>;

const EARTH_RADIUS_M = 6_378_137;
const FT_TO_M = 0.3048;

function ringCentroid(ring: RingLngLat): { lng: number; lat: number } {
  let sx = 0;
  let sy = 0;
  const n = ring.length;
  for (const [lng, lat] of ring) {
    sx += lng;
    sy += lat;
  }
  return { lng: sx / n, lat: sy / n };
}

function projectRing(
  ring: RingLngLat,
  origin: { lng: number; lat: number },
): Array<[number, number]> {
  const latRad = (origin.lat * Math.PI) / 180;
  const mPerDegLng = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  return ring.map(([lng, lat]) => [
    (lng - origin.lng) * mPerDegLng,
    (lat - origin.lat) * mPerDegLat,
  ]);
}

function closeRing(coords: Array<[number, number]>): polygonClipping.Ring {
  if (coords.length === 0) return [];
  const ring: polygonClipping.Ring = coords.map(([x, y]) => [x, y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function ringAreaM2(ring: polygonClipping.Ring): number {
  if (ring.length < 4) return 0;
  const open = ring.slice(0, -1);
  let a = 0;
  for (let i = 0; i < open.length; i++) {
    const p = open[i]!;
    const q = open[(i + 1) % open.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return Math.abs(a) / 2;
}

function polygonAreaM2(polygon: polygonClipping.Polygon): number {
  if (polygon.length === 0) return 0;
  const outer = ringAreaM2(polygon[0]!);
  let holes = 0;
  for (let i = 1; i < polygon.length; i++) {
    holes += ringAreaM2(polygon[i]!);
  }
  return Math.max(0, outer - holes);
}

function multiPolygonAreaM2(mp: polygonClipping.MultiPolygon): number {
  return mp.reduce((sum, poly) => sum + polygonAreaM2(poly), 0);
}

/** Buffer a LineString in local metres (square-cap approximation). */
export function bufferLineStringFt(
  coordinates: RingLngLat,
  widthFt: number,
): RingLngLat | null {
  if (coordinates.length < 2 || widthFt <= 0) return null;
  const halfWidthM = (widthFt * FT_TO_M) / 2;
  const origin = ringCentroid(coordinates);
  const projected = projectRing(coordinates, origin);
  const buffered: Array<[number, number]> = [];

  for (let i = 0; i < projected.length; i++) {
    const curr = projected[i]!;
    const prev = projected[Math.max(0, i - 1)]!;
    const next = projected[Math.min(projected.length - 1, i + 1)]!;
    const dx = next[0]! - prev[0]!;
    const dy = next[1]! - prev[1]!;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidthM;
    const ny = (dx / len) * halfWidthM;
    buffered.push([curr[0]! + nx, curr[1]! + ny]);
  }
  for (let i = projected.length - 1; i >= 0; i--) {
    const curr = projected[i]!;
    const prev = projected[Math.max(0, i - 1)]!;
    const next = projected[Math.min(projected.length - 1, i + 1)]!;
    const dx = next[0]! - prev[0]!;
    const dy = next[1]! - prev[1]!;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidthM;
    const ny = (dx / len) * halfWidthM;
    buffered.push([curr[0]! - nx, curr[1]! - ny]);
  }

  const latRad = (origin.lat * Math.PI) / 180;
  const mPerDegLng = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const ring: RingLngLat = buffered.map(([x, y]) => [
    origin.lng + x / mPerDegLng,
    origin.lat + y / mPerDegLat,
  ]);
  if (ring.length > 0) {
    ring.push([ring[0]![0], ring[0]![1]]);
  }
  return ring.length >= 4 ? ring : null;
}

export function easementIntersectsParcelRing(
  easementGeometry: EasementGeometry,
  parcelRing: RingLngLat,
  corridorWidthFt?: number,
): boolean {
  let easementRing: RingLngLat | null = null;
  if (easementGeometry.type === "Polygon") {
    easementRing = easementGeometry.coordinates[0] ?? null;
  } else if (easementGeometry.type === "LineString") {
    easementRing = bufferLineStringFt(
      easementGeometry.coordinates,
      corridorWidthFt ?? 10,
    );
  } else if (easementGeometry.type === "MultiPolygon") {
    easementRing = easementGeometry.coordinates[0]?.[0] ?? null;
  }
  if (!easementRing || parcelRing.length < 4) return false;

  const origin = ringCentroid(easementRing);
  const fp = projectRing(easementRing, origin);
  const par = projectRing(parcelRing, origin);
  const fpPoly: polygonClipping.Polygon = [closeRing(fp)];
  const parPoly: polygonClipping.Polygon = [closeRing(par)];
  const fpArea = polygonAreaM2(fpPoly);
  if (fpArea < 1e-6) return false;
  const inter = polygonClipping.intersection(fpPoly, parPoly);
  if (!inter || inter.length === 0) return false;
  return multiPolygonAreaM2(inter) > 0.01;
}

export function geoJsonRingFromEsri(
  geometry:
    | { rings?: number[][][]; paths?: number[][][] }
    | null
    | undefined,
): RingLngLat | null {
  if (!geometry) return null;
  if (geometry.rings?.length) {
    const outer = geometry.rings[0];
    if (!outer?.length) return null;
    const ring: RingLngLat = outer.map(([lng, lat]) => [lng, lat]);
    if (ring.length < 4) return null;
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    return ring;
  }
  if (geometry.paths?.length) {
    const path = geometry.paths[0];
    if (!path?.length || path.length < 2) return null;
    return path.map(([lng, lat]) => [lng, lat]);
  }
  return null;
}

export function ringToEasementGeometry(
  ring: RingLngLat,
): EasementGeometry | null {
  if (ring.length < 2) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const closed =
    first[0] === last[0] && first[1] === last[1] && ring.length >= 4;
  if (closed) {
    return { type: "Polygon", coordinates: [ring] };
  }
  return { type: "LineString", coordinates: ring };
}

export interface EasementParcelInput {
  parcelKey: string;
  ring: RingLngLat;
  inCityLimits?: boolean;
}

export interface EasementFeatureInput {
  easementId: string;
  geometry: EasementGeometry;
  status: string | null;
  docNum: string | null;
  corridorWidthFt?: number;
}
