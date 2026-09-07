/**
 * Local-projection polygon intersection area, in the same style as
 * `building-footprint/spatial-join.ts` and `utility-easement/geo.ts`: project
 * both rings about a shared origin (equirectangular tangent plane, accurate
 * enough at parcel scale), run `polygon-clipping`, sum the result with a
 * hand-rolled shoelace. No shared helper exists across fact families for
 * this today (each family that needs it has its own copy), so this follows
 * that established convention rather than reaching into another family's
 * module.
 */
import polygonClipping from "polygon-clipping";

export type LngLat = [number, number];
export type Ring = ReadonlyArray<LngLat>;

const EARTH_RADIUS_M = 6_378_137;
const SQ_METERS_PER_ACRE = 4046.8564224;

export function ringCentroid(ring: Ring): { lng: number; lat: number } {
  let sx = 0;
  let sy = 0;
  const n = ring.length;
  for (const [lng, lat] of ring) {
    sx += lng;
    sy += lat;
  }
  return { lng: sx / n, lat: sy / n };
}

function projectRing(ring: Ring, origin: { lng: number; lat: number }): Array<[number, number]> {
  const latRad = (origin.lat * Math.PI) / 180;
  const mPerDegLng = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  return ring.map(([lng, lat]) => [(lng - origin.lng) * mPerDegLng, (lat - origin.lat) * mPerDegLat]);
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

/** Polygon area in acres. Rings are exterior-only (no holes). */
export function ringAreaAcres(ring: Ring): number {
  const origin = ringCentroid(ring);
  const projected = closeRing(projectRing(ring, origin));
  return ringAreaM2(projected) / SQ_METERS_PER_ACRE;
}

/**
 * Area of `ringA ∩ ringB`, in acres. Zero (not absent) when the rings do not
 * overlap at all -- a real, measured zero, per the family's own discipline:
 * "outside this zone" and "zone data unreachable" must never collapse into
 * the same value.
 */
export function intersectionAreaAcres(ringA: Ring, ringB: Ring): number {
  const origin = ringCentroid(ringA);
  const a: polygonClipping.Polygon = [closeRing(projectRing(ringA, origin))];
  const b: polygonClipping.Polygon = [closeRing(projectRing(ringB, origin))];
  const inter = polygonClipping.intersection(a, b);
  if (!inter || inter.length === 0) return 0;
  return multiPolygonAreaM2(inter) / SQ_METERS_PER_ACRE;
}
