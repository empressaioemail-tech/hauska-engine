/**
 * Lightweight geometry helpers for rail-corridor proximity planning.
 *
 * Pure JS — parcel-edge ↔ corridor-line distance in meters (WGS84). No PostGIS
 * dependency so unit tests and dry-runs stay offline-capable.
 */

export type LngLat = readonly [number, number];

export interface BBox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
}

/** Haversine great-circle distance in meters. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h =
    s1 * s1 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function asRing(coords: unknown): LngLat[] | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring: LngLat[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  return ring;
}

/** Extract the outer ring(s) of a GeoJSON Polygon / MultiPolygon. */
export function ringsFromGeoJson(geometry: unknown): LngLat[][] {
  if (!geometry || typeof geometry !== "object") return [];
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    return outer ? [outer] : [];
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const out: LngLat[][] = [];
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      const outer = asRing(poly[0]);
      if (outer) out.push(outer);
    }
    return out;
  }
  return [];
}

export function lineStringsFromGeoJson(geometry: unknown): LngLat[][] {
  if (!geometry || typeof geometry !== "object") return [];
  const g = geometry as {
    type?: string;
    coordinates?: unknown;
    paths?: unknown;
  };

  // Esri JSON polyline (ArcGIS REST default when f=json).
  if (Array.isArray(g.paths)) {
    const out: LngLat[][] = [];
    for (const path of g.paths) {
      if (!Array.isArray(path)) continue;
      const line: LngLat[] = [];
      for (const c of path) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const lng = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        line.push([lng, lat]);
      }
      if (line.length >= 2) out.push(line);
    }
    return out;
  }

  if (g.type === "LineString" && Array.isArray(g.coordinates)) {
    const line: LngLat[] = [];
    for (const c of g.coordinates) {
      if (!Array.isArray(c) || c.length < 2) return [];
      const lng = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [];
      line.push([lng, lat]);
    }
    return line.length >= 2 ? [line] : [];
  }
  if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) {
    const out: LngLat[][] = [];
    for (const ls of g.coordinates) {
      const part = lineStringsFromGeoJson({ type: "LineString", coordinates: ls });
      out.push(...part);
    }
    return out;
  }
  return [];
}

export function ringBbox(ring: ReadonlyArray<LngLat>): BBox | null {
  if (ring.length === 0) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

export function expandBbox(bbox: BBox, bufferMeters: number): BBox {
  const midLat = (bbox.southLat + bbox.northLat) / 2;
  const dLat = bufferMeters / METERS_PER_DEG_LAT;
  const dLng = bufferMeters / metersPerDegLng(midLat);
  return {
    westLng: bbox.westLng - dLng,
    southLat: bbox.southLat - dLat,
    eastLng: bbox.eastLng + dLng,
    northLat: bbox.northLat + dLat,
  };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(
    a.eastLng < b.westLng ||
    a.westLng > b.eastLng ||
    a.northLat < b.southLat ||
    a.southLat > b.northLat
  );
}

/** Local equirectangular point-to-segment distance in meters. */
export function pointToSegmentMeters(
  point: LngLat,
  segA: LngLat,
  segB: LngLat,
): number {
  const midLat = (point[1] + segA[1] + segB[1]) / 3;
  const mx = metersPerDegLng(midLat);
  const my = METERS_PER_DEG_LAT;
  const px = point[0] * mx;
  const py = point[1] * my;
  const ax = segA[0] * mx;
  const ay = segA[1] * my;
  const bx = segB[0] * mx;
  const by = segB[1] * my;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return haversineMeters(point, segA);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const clng = cx / mx;
  const clat = cy / my;
  return haversineMeters(point, [clng, clat]);
}

/** Minimum distance from any parcel boundary segment to any corridor polyline segment. */
export function minEdgeToLineDistanceMeters(
  parcelRings: ReadonlyArray<ReadonlyArray<LngLat>>,
  corridorLines: ReadonlyArray<ReadonlyArray<LngLat>>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ring of parcelRings) {
    if (ring.length < 2) continue;
    const n =
      ring.length > 1 &&
      ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1]
        ? ring.length - 1
        : ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      for (const line of corridorLines) {
        if (line.length < 2) continue;
        for (let j = 0; j < line.length - 1; j++) {
          const c = line[j]!;
          const d = line[j + 1]!;
          best = Math.min(
            best,
            pointToSegmentMeters(a, c, d),
            pointToSegmentMeters(b, c, d),
            pointToSegmentMeters(c, a, b),
            pointToSegmentMeters(d, a, b),
          );
        }
      }
    }
  }
  return best;
}

/** Minimum distance from a point to any parcel boundary segment. */
export function minPointToParcelEdgeMeters(
  point: LngLat,
  parcelRings: ReadonlyArray<ReadonlyArray<LngLat>>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ring of parcelRings) {
    if (ring.length < 2) continue;
    const n =
      ring.length > 1 &&
      ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1]
        ? ring.length - 1
        : ring.length;
    for (let i = 0; i < n; i++) {
      best = Math.min(
        best,
        pointToSegmentMeters(point, ring[i]!, ring[(i + 1) % n]!),
      );
    }
  }
  return best;
}
