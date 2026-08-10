/**
 * Geometry helpers for well-fact county planning.
 *
 * Pure JS — no PostGIS dependency so unit tests and dry-runs stay offline.
 */

export type LngLat = readonly [number, number];

export interface BBox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointInRing(lng: number, lat: number, ring: ReadonlyArray<LngLat>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
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

export function pointInGeoJson(lng: number, lat: number, geometry: unknown): boolean {
  if (!geometry || typeof geometry !== "object") return false;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    if (!outer || !pointInRing(lng, lat, outer)) return false;
    for (let h = 1; h < g.coordinates.length; h++) {
      const hole = asRing(g.coordinates[h]);
      if (hole && pointInRing(lng, lat, hole)) return false;
    }
    return true;
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      if (pointInGeoJson(lng, lat, { type: "Polygon", coordinates: poly })) {
        return true;
      }
    }
  }
  return false;
}

function distancePointToSegmentMeters(
  point: LngLat,
  a: LngLat,
  b: LngLat,
): number {
  const ab = haversineMeters(a, b);
  if (ab === 0) return haversineMeters(point, a);
  const ap = haversineMeters(a, point);
  const bp = haversineMeters(b, point);
  const s = (ap + bp + ab) / 2;
  const area = Math.max(0, s * (s - ap) * (s - bp) * (s - ab));
  const height = area > 0 ? (2 * Math.sqrt(area)) / ab : 0;
  if (ap * ap <= bp * bp + ab * ab && bp * bp <= ap * ap + ab * ab) {
    return height;
  }
  return Math.min(ap, bp);
}

export function distancePointToPolygonMeters(
  point: LngLat,
  geometry: unknown,
): number {
  if (pointInGeoJson(point[0], point[1], geometry)) return 0;
  if (!geometry || typeof geometry !== "object") return Infinity;
  const g = geometry as { type?: string; coordinates?: unknown };
  const rings: LngLat[][] = [];
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    if (outer) rings.push(outer);
  } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      const outer = asRing(poly[0]);
      if (outer) rings.push(outer);
    }
  }
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      best = Math.min(best, distancePointToSegmentMeters(point, ring[i]!, ring[i + 1]!));
    }
  }
  return best;
}

export function bboxContainsPoint(bbox: BBox, lng: number, lat: number): boolean {
  return (
    lng >= bbox.westLng &&
    lng <= bbox.eastLng &&
    lat >= bbox.southLat &&
    lat <= bbox.northLat
  );
}

export function expandBBox(bbox: BBox, bufferDegrees: number): BBox {
  return {
    westLng: bbox.westLng - bufferDegrees,
    southLat: bbox.southLat - bufferDegrees,
    eastLng: bbox.eastLng + bufferDegrees,
    northLat: bbox.northLat + bufferDegrees,
  };
}

/** ~152 m latitude degrees at Texas latitudes (conservative prefilter). */
export function metersToLatDegrees(meters: number): number {
  return meters / 111_320;
}

export function metersToLngDegrees(meters: number, atLat: number): number {
  return meters / (111_320 * Math.cos((atLat * Math.PI) / 180));
}

export function geometryCentroid(geometry: unknown): LngLat | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Point" && Array.isArray(g.coordinates)) {
    const lng = Number(g.coordinates[0]);
    const lat = Number(g.coordinates[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    if (!outer || outer.length === 0) return null;
    let sx = 0;
    let sy = 0;
    for (const p of outer) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / outer.length, sy / outer.length];
  }
  return null;
}
