/**
 * Geometry helpers for special-district planning.
 *
 * BINARY point-in-polygon only — no proximity/buffer semantics. A parcel is
 * in a district when its centroid lies inside the polygon, not when adjacent.
 */

export type LngLat = readonly [number, number];

export interface BBox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface SpecialDistrictFeature {
  districtRowId: string;
  districtId: string;
  districtName: string;
  districtType: string;
  countyFips: string;
  status: string | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
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

interface PreparedPolygon {
  outer: LngLat[];
  holes: LngLat[][];
}

/** Parse GeoJSON once at index-build; hot path reuses rings. */
function compileGeoJsonForPointTest(geometry: unknown): PreparedPolygon[] | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = asRing(g.coordinates[0]);
    if (!outer) return null;
    const holes: LngLat[][] = [];
    for (let h = 1; h < g.coordinates.length; h++) {
      const hole = asRing(g.coordinates[h]);
      if (hole) holes.push(hole);
    }
    return [{ outer, holes }];
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const polys: PreparedPolygon[] = [];
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      const compiled = compileGeoJsonForPointTest({
        type: "Polygon",
        coordinates: poly,
      });
      if (compiled) polys.push(...compiled);
    }
    return polys.length > 0 ? polys : null;
  }
  return null;
}

function pointInPreparedPolygons(
  lng: number,
  lat: number,
  prepared: ReadonlyArray<PreparedPolygon>,
): boolean {
  for (const poly of prepared) {
    if (!pointInRing(lng, lat, poly.outer)) continue;
    let inHole = false;
    for (const hole of poly.holes) {
      if (pointInRing(lng, lat, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function pointInGeoJson(
  lng: number,
  lat: number,
  geometry: unknown,
): boolean {
  const prepared = compileGeoJsonForPointTest(geometry);
  return prepared ? pointInPreparedPolygons(lng, lat, prepared) : false;
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
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0];
    if (Array.isArray(first)) {
      const outer = asRing(first[0]);
      return outer ? ringCentroid(outer) : null;
    }
  }
  return null;
}

/**
 * Spatial grid index for district polygons — O(cells) lookup per parcel
 * instead of O(all districts). BINARY PIP semantics unchanged.
 */

const CELL_DEG = 0.01;

function cellKey(lng: number, lat: number): string {
  return `${Math.floor(lng / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
}

function cellsForBBox(bbox: BBox): string[] {
  const keys: string[] = [];
  const x0 = Math.floor(bbox.westLng / CELL_DEG);
  const x1 = Math.floor(bbox.eastLng / CELL_DEG);
  const y0 = Math.floor(bbox.southLat / CELL_DEG);
  const y1 = Math.floor(bbox.northLat / CELL_DEG);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      keys.push(`${x}:${y}`);
    }
  }
  return keys;
}

export interface DistrictSpatialIndex {
  lookup(lng: number, lat: number): ReadonlyArray<SpecialDistrictFeature>;
}

export function buildDistrictSpatialIndex(
  districts: ReadonlyArray<SpecialDistrictFeature>,
): DistrictSpatialIndex {
  type IndexedDistrict = SpecialDistrictFeature & {
    prepared: PreparedPolygon[] | null;
  };

  const indexed: IndexedDistrict[] = districts.map((d) => ({
    ...d,
    prepared: compileGeoJsonForPointTest(d.geometry),
  }));

  const grid = new Map<string, IndexedDistrict[]>();
  for (const d of indexed) {
    if (!d.prepared) continue;
    const keys = cellsForBBox({
      westLng: d.westLng,
      southLat: d.southLat,
      eastLng: d.eastLng,
      northLat: d.northLat,
    });
    for (const key of keys) {
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(d);
    }
  }

  return {
    lookup(lng: number, lat: number): SpecialDistrictFeature[] {
      const key = cellKey(lng, lat);
      const candidates = grid.get(key) ?? [];
      const hits: SpecialDistrictFeature[] = [];
      for (const d of candidates) {
        if (
          !bboxContainsPoint(
            {
              westLng: d.westLng,
              southLat: d.southLat,
              eastLng: d.eastLng,
              northLat: d.northLat,
            },
            lng,
            lat,
          )
        ) {
          continue;
        }
        if (pointInPreparedPolygons(lng, lat, d.prepared!)) hits.push(d);
      }
      return hits;
    },
  };
}

export function filterDistrictsByCounty(
  districts: ReadonlyArray<SpecialDistrictFeature>,
  countyFips: string,
): SpecialDistrictFeature[] {
  return districts.filter((d) => d.countyFips === countyFips);
}

export function filterDistrictsByBBox(
  districts: ReadonlyArray<SpecialDistrictFeature>,
  bbox: BBox,
): SpecialDistrictFeature[] {
  return districts.filter((d) =>
    bboxIntersects(bbox, {
      westLng: d.westLng,
      southLat: d.southLat,
      eastLng: d.eastLng,
      northLat: d.northLat,
    }),
  );
}
