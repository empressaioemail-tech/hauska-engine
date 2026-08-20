/**
 * Lightweight geometry helpers for flood-hazard planning.
 *
 * Pure JS — no PostGIS dependency so unit tests and dry-runs stay offline.
 * NFHL zones are WGS84 GeoJSON polygons; parcels supply a centroid.
 */

export type LngLat = readonly [number, number];

export interface BBox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface FloodZoneFeature {
  zoneRowId: string;
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: string | null;
  staticBfe: number | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  sourceVintage?: string | null;
  sourceCitation?: string | null;
}

function pointInRing(lng: number, lat: number, ring: ReadonlyArray<LngLat>): boolean {
  // Ray cast eastward. Ring is closed or open — either works.
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

export function pointInGeoJson(
  lng: number,
  lat: number,
  geometry: unknown,
): boolean {
  if (!geometry || typeof geometry !== "object") return false;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    if (!outer || !pointInRing(lng, lat, outer)) return false;
    // Holes: if inside a hole, not inside the polygon.
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

export function bboxContainsPoint(
  bbox: BBox,
  lng: number,
  lat: number,
): boolean {
  return (
    lng >= bbox.westLng &&
    lng <= bbox.eastLng &&
    lat >= bbox.southLat &&
    lat <= bbox.northLat
  );
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(
    a.eastLng < b.westLng ||
    a.westLng > b.eastLng ||
    a.northLat < b.southLat ||
    a.southLat > b.northLat
  );
}

/** Filter zones whose stored bbox intersects the query bbox (Kenedy-friendly). */
export function filterZonesByBBox(
  zones: ReadonlyArray<FloodZoneFeature>,
  bbox: BBox,
): FloodZoneFeature[] {
  return zones.filter((z) =>
    bboxIntersects(bbox, {
      westLng: z.westLng,
      southLat: z.southLat,
      eastLng: z.eastLng,
      northLat: z.northLat,
    }),
  );
}

export function ringCentroid(
  ring: ReadonlyArray<LngLat>,
): LngLat | null {
  if (ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  const n = ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
    ? ring.length - 1
    : ring.length;
  if (n <= 0) return null;
  for (let i = 0; i < n; i++) {
    sx += ring[i]![0];
    sy += ring[i]![1];
  }
  return [sx / n, sy / n];
}

/**
 * Third centroid: Polygon uses the de-duplicated vertex mean; MultiPolygon
 * returns null (honest refusal of N parts). Point stays the point.
 *
 * Not a merge of the other two copies. well-fact double-counts the RFC 7946
 * closing vertex on every closed ring and returns null on MultiPolygon.
 * The previous flood copy de-duplicated Polygon correctly then silently
 * answered for part one of a MultiPolygon.
 */
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
    return outer ? ringCentroid(outer) : null;
  }
  if (g.type === "MultiPolygon") {
    return null;
  }
  return null;
}

/**
 * FEMA NFHL S_FLD_HAZ_AR SFHA_TF domain: the literal strings "T" and "F".
 * Source in this repo (READ, not memory): packages/adapters/src/federal/fema-nfhl.ts
 * lines 112-115 (FEMA stamps SFHA_TF as the literal strings T or F).
 * Fixtures in src/__tests__/fixtures/flood-pip-cases.ts use only T and F.
 *
 * Input type on FloodZoneFeature.sfhaTf is `string | null`. The cheapest
 * satisfier of the old predicate (`=== "T" || === "t" || === "true"`) on that
 * type is any other string, or null: all of those returned false, so a hazard
 * flag failed open. Unrecognised values raise.
 */
export type SfhaFlag = "sfha" | "not-sfha";

export class UnrecognisedSfhaFlagError extends Error {
  readonly sfhaTf: string | null;
  constructor(sfhaTf: string | null) {
    const rendered = sfhaTf === null ? "null" : JSON.stringify(sfhaTf);
    super(
      `unrecognised NFHL SFHA_TF ${rendered}; domain is the literal strings T and F`,
    );
    this.name = "UnrecognisedSfhaFlagError";
    this.sfhaTf = sfhaTf;
  }
}

export function parseSfhaTf(sfhaTf: string | null): SfhaFlag {
  if (sfhaTf === "T") return "sfha";
  if (sfhaTf === "F") return "not-sfha";
  throw new UnrecognisedSfhaFlagError(sfhaTf);
}

/** True only for parsed SFHA. Unrecognised values raise; they are not false. */
export function isSfhaFlag(sfhaTf: string | null): boolean {
  return parseSfhaTf(sfhaTf) === "sfha";
}

/**
 * Overlap comparison, after every candidate flag has been parsed:
 * 1. Any unrecognised SFHA_TF raises. No preference, no array-order fallback.
 * 2. Mixed SFHA and non-SFHA: the first SFHA in candidate (array) order wins.
 * 3. All non-SFHA: the first candidate is an honest non-SFHA return.
 */
export function pickPreferredFloodZone(
  candidates: ReadonlyArray<FloodZoneFeature>,
): FloodZoneFeature | null {
  if (candidates.length === 0) return null;
  const parsed: Array<{ zone: FloodZoneFeature; flag: SfhaFlag }> = [];
  for (const zone of candidates) {
    parsed.push({ zone, flag: parseSfhaTf(zone.sfhaTf) });
  }
  const sfha = parsed.find((p) => p.flag === "sfha");
  return sfha ? sfha.zone : parsed[0]!.zone;
}

/**
 * Find a zone polygon containing the point. Parses every overlapping flag
 * before preferring; see pickPreferredFloodZone for the comparison.
 */
export function findZoneAtPoint(
  lng: number,
  lat: number,
  zones: ReadonlyArray<FloodZoneFeature>,
): FloodZoneFeature | null {
  const candidates: FloodZoneFeature[] = [];
  for (const z of zones) {
    if (
      !bboxContainsPoint(
        {
          westLng: z.westLng,
          southLat: z.southLat,
          eastLng: z.eastLng,
          northLat: z.northLat,
        },
        lng,
        lat,
      )
    ) {
      continue;
    }
    if (pointInGeoJson(lng, lat, z.geometry)) candidates.push(z);
  }
  return pickPreferredFloodZone(candidates);
}
