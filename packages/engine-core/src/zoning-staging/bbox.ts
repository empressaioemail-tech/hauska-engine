/**
 * Texas WGS84 degree envelope guard for zoning staging.
 * Mirrors cad-ingest assertTexasWgs84Bbox posture (degrees only).
 */

export type GeoBbox = {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
};

export const TEXAS_WGS84_BOUNDS: GeoBbox = {
  westLng: -107.5,
  southLat: 25.0,
  eastLng: -93.0,
  northLat: 37.0,
};

export class ZoningProjectionError extends Error {
  readonly bbox: GeoBbox;
  constructor(message: string, bbox: GeoBbox) {
    super(message);
    this.name = "ZoningProjectionError";
    this.bbox = bbox;
  }
}

export function isPlausibleTexasWgs84Bbox(bbox: GeoBbox): boolean {
  const values = [bbox.westLng, bbox.eastLng, bbox.southLat, bbox.northLat];
  if (!values.every((v) => Number.isFinite(v))) return false;
  if (bbox.westLng > bbox.eastLng || bbox.southLat > bbox.northLat) return false;
  return (
    bbox.westLng >= TEXAS_WGS84_BOUNDS.westLng &&
    bbox.eastLng <= TEXAS_WGS84_BOUNDS.eastLng &&
    bbox.southLat >= TEXAS_WGS84_BOUNDS.southLat &&
    bbox.northLat <= TEXAS_WGS84_BOUNDS.northLat
  );
}

export function assertTexasWgs84Bbox(bbox: GeoBbox, context: string): void {
  if (!isPlausibleTexasWgs84Bbox(bbox)) {
    throw new ZoningProjectionError(
      `${context}: bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
        `${bbox.northLat}] falls outside Texas WGS84 envelope ` +
        `[${TEXAS_WGS84_BOUNDS.westLng}, ${TEXAS_WGS84_BOUNDS.southLat}, ` +
        `${TEXAS_WGS84_BOUNDS.eastLng}, ${TEXAS_WGS84_BOUNDS.northLat}] — ` +
        `coordinates are not WGS84 degrees (State Plane feet? Web Mercator?). ` +
        `Refusing to stage.`,
      bbox,
    );
  }
}

export function bboxFromGeoJsonCoordinates(coordinates: unknown): GeoBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      const lng = node[0];
      const lat = node[1];
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
      return;
    }
    for (const child of node) visit(child);
  };

  visit(coordinates);
  if (!Number.isFinite(west)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

export function bboxFromEsriRings(rings: number[][][]): GeoBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const pt of ring) {
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}
