/**
 * Way-to-county resolution for statewide road intake (L3).
 *
 * Ruling (2026-08-08 statewide roads program planner):
 * Preserve `{countyFips}:road:{osmWayId}` — do NOT re-key to county-agnostic ids.
 * When an OSM way intersects N counties, emit N road-nodes (same osmWayId,
 * different countyFips prefix) each carrying the FULL centerline. Matches
 * existing Overpass bbox semantics (way intersects jurisdiction → stamped
 * to that jurisdiction with full geometry). Avoids clipping defects on
 * county-line-running roads where even-odd ray cast treats boundary as outside.
 */

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
};

export type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: ReadonlyArray<
    ReadonlyArray<ReadonlyArray<readonly [number, number]>>
  >;
};

export type CountyPolygonGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

export interface CountyBoundaryRecord {
  countyFips: string;
  countyName: string;
  geometry: CountyPolygonGeometry;
  /** Optional precomputed WGS84 bbox — computed if omitted. */
  bbox?: GeoBbox;
}

export interface GeoBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface WayCountyHit {
  countyFips: string;
  countyName: string;
  /** Why this county was included for the way. */
  basis:
    | "vertex-inside"
    | "midpoint-inside"
    | "segment-crosses-boundary"
    | "unresolved-off-boundary";
}

export interface ResolveWayCountiesResult {
  hits: WayCountyHit[];
  /** True when the way produced zero county hits (outside TX index or degenerate). */
  unresolved: boolean;
}

function isPosition(v: unknown): v is readonly [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function bboxOfGeometry(geometry: CountyPolygonGeometry): GeoBbox {
  let westLng = Infinity;
  let southLat = Infinity;
  let eastLng = -Infinity;
  let northLat = -Infinity;
  const visit = (lon: number, lat: number) => {
    if (lon < westLng) westLng = lon;
    if (lon > eastLng) eastLng = lon;
    if (lat < southLat) southLat = lat;
    if (lat > northLat) northLat = lat;
  };
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      for (const p of ring) visit(p[0], p[1]);
    }
  } else {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        for (const p of ring) visit(p[0], p[1]);
      }
    }
  }
  return { westLng, southLat, eastLng, northLat };
}

export function buildCountyBoundaryIndex(
  records: ReadonlyArray<CountyBoundaryRecord>,
): Array<CountyBoundaryRecord & { bbox: GeoBbox }> {
  return records.map((r) => ({
    ...r,
    bbox: r.bbox ?? bboxOfGeometry(r.geometry),
  }));
}

function ringCrossings(
  ring: ReadonlyArray<readonly [number, number]>,
  longitude: number,
  latitude: number,
): number {
  let crossings = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (!isPosition(a) || !isPosition(b)) continue;
    const [ax, ay] = a;
    const [bx, by] = b;
    if (ay > latitude !== by > latitude) {
      const t = (latitude - ay) / (by - ay);
      const xCross = ax + t * (bx - ax);
      if (xCross > longitude) crossings += 1;
    }
  }
  return crossings;
}

function pointInPolygonRings(
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  longitude: number,
  latitude: number,
): boolean {
  let crossings = 0;
  for (const ring of rings) {
    crossings += ringCrossings(ring, longitude, latitude);
  }
  return crossings % 2 === 1;
}

/** Even-odd point-in-polygon; matches LDT `pointInGeometry` contract. */
export function pointInCountyGeometry(
  longitude: number,
  latitude: number,
  geometry: CountyPolygonGeometry,
): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygonRings(geometry.coordinates, longitude, latitude);
  }
  return geometry.coordinates.some((poly) =>
    pointInPolygonRings(poly, longitude, latitude),
  );
}

function bboxesIntersect(a: GeoBbox, b: GeoBbox): boolean {
  return (
    a.westLng <= b.eastLng &&
    a.eastLng >= b.westLng &&
    a.southLat <= b.northLat &&
    a.northLat >= b.southLat
  );
}

function bboxOfLine(
  coords: ReadonlyArray<readonly [number, number]>,
): GeoBbox | null {
  if (coords.length === 0) return null;
  let westLng = Infinity;
  let southLat = Infinity;
  let eastLng = -Infinity;
  let northLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < westLng) westLng = lon;
    if (lon > eastLng) eastLng = lon;
    if (lat < southLat) southLat = lat;
    if (lat > northLat) northLat = lat;
  }
  return { westLng, southLat, eastLng, northLat };
}

function orient(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): number {
  return (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
}

function onSeg(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): boolean {
  return (
    Math.min(p[0], r[0]) - 1e-12 <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) + 1e-12 &&
    Math.min(p[1], r[1]) - 1e-12 <= q[1] &&
    q[1] <= Math.max(p[1], r[1]) + 1e-12
  );
}

/** Inclusive segment intersection (handles collinear touch). */
export function segmentsIntersect(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0) return true;
  if (Math.abs(o1) < 1e-18 && onSeg(a, c, b)) return true;
  if (Math.abs(o2) < 1e-18 && onSeg(a, d, b)) return true;
  if (Math.abs(o3) < 1e-18 && onSeg(c, a, d)) return true;
  if (Math.abs(o4) < 1e-18 && onSeg(c, b, d)) return true;
  return false;
}

function* iterateOuterRings(
  geometry: CountyPolygonGeometry,
): Generator<ReadonlyArray<readonly [number, number]>> {
  if (geometry.type === "Polygon") {
    if (geometry.coordinates[0]) yield geometry.coordinates[0];
    return;
  }
  for (const poly of geometry.coordinates) {
    if (poly[0]) yield poly[0];
  }
}

function wayCrossesBoundary(
  coords: ReadonlyArray<readonly [number, number]>,
  geometry: CountyPolygonGeometry,
): boolean {
  // Test EVERY outer-ring edge. Never decimate: stepped sampling that tests
  // ring[j]→ring[j+1] with j+=step skips intervening edges and was shown to
  // miss ~23% of on-line segments on Bastrop's 1243-vertex ring.
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    for (const ring of iterateOuterRings(geometry)) {
      for (let j = 0; j < ring.length - 1; j++) {
        if (segmentsIntersect(a, b, ring[j]!, ring[j + 1]!)) return true;
      }
      if (
        ring.length >= 2 &&
        segmentsIntersect(a, b, ring[ring.length - 1]!, ring[0]!)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve which counties an OSM way centerline intersects.
 * Centerline is WGS84 [lng, lat] vertices (same as OsmRoadObservation).
 */
export function resolveWayCounties(
  centerline: ReadonlyArray<readonly [number, number]>,
  index: ReadonlyArray<CountyBoundaryRecord & { bbox: GeoBbox }>,
): ResolveWayCountiesResult {
  const lineBbox = bboxOfLine(centerline);
  if (!lineBbox || centerline.length < 2) {
    return { hits: [], unresolved: true };
  }

  const hits: WayCountyHit[] = [];
  for (const county of index) {
    if (!bboxesIntersect(lineBbox, county.bbox)) continue;

    let basis: WayCountyHit["basis"] | null = null;
    for (const [lon, lat] of centerline) {
      if (pointInCountyGeometry(lon, lat, county.geometry)) {
        basis = "vertex-inside";
        break;
      }
    }
    if (!basis) {
      for (let i = 0; i < centerline.length - 1; i++) {
        const a = centerline[i]!;
        const b = centerline[i + 1]!;
        const mid: readonly [number, number] = [
          (a[0] + b[0]) / 2,
          (a[1] + b[1]) / 2,
        ];
        if (pointInCountyGeometry(mid[0], mid[1], county.geometry)) {
          basis = "midpoint-inside";
          break;
        }
      }
    }
    if (!basis && wayCrossesBoundary(centerline, county.geometry)) {
      basis = "segment-crosses-boundary";
    }
    if (basis) {
      hits.push({
        countyFips: county.countyFips,
        countyName: county.countyName,
        basis,
      });
    }
  }

  return { hits, unresolved: hits.length === 0 };
}

/**
 * Build emit targets for a way under the split-by-county ruling.
 * Same osmWayId appears once per hit county; caller stamps full centerline.
 */
export function emitTargetsForWay(
  osmWayId: number,
  centerline: ReadonlyArray<readonly [number, number]>,
  index: ReadonlyArray<CountyBoundaryRecord & { bbox: GeoBbox }>,
): Array<{ countyFips: string; roadNodeId: string; basis: WayCountyHit["basis"] }> {
  const { hits } = resolveWayCounties(centerline, index);
  return hits.map((h) => ({
    countyFips: h.countyFips,
    roadNodeId: `${h.countyFips}:road:${osmWayId}`,
    basis: h.basis,
  }));
}
