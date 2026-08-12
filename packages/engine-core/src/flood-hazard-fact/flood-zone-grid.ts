/**
 * Spatial grid index for flood zone point-in-polygon queries.
 *
 * Sizes cells from geometry vertex density (not zone count). At query time
 * only zones registered in the point cell and its 8 neighbors are tested.
 */

import {
  bboxContainsPoint,
  pointInGeoJson,
  isSfhaFlag,
  type BBox,
  type FloodZoneFeature,
} from "./geo.js";

/** Target vertex budget per grid cell when sizing the index. */
export const FLOOD_ZONE_GRID_VERTEX_BUDGET = 8000;

const MIN_GRID_DIM = 8;
const MAX_GRID_DIM = 512;

export interface FloodZoneGrid {
  /** Zone indices per flat cell (row-major: row * cols + col). */
  cells: ReadonlyArray<ReadonlyArray<number>>;
  bbox: BBox;
  cellDegLng: number;
  cellDegLat: number;
  cols: number;
  rows: number;
  buildMs: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function asRing(coords: unknown): unknown[] | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  return coords;
}

/** Count vertices across Polygon / MultiPolygon rings (holes included). */
export function countGeometryVertices(geometry: unknown): number {
  if (!geometry || typeof geometry !== "object") return 0;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    let n = 0;
    for (const ring of g.coordinates) {
      const r = asRing(ring);
      if (r) n += r.length;
    }
    return n;
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    let n = 0;
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        const r = asRing(ring);
        if (r) n += r.length;
      }
    }
    return n;
  }
  return 0;
}

export function bboxFromZones(
  zones: ReadonlyArray<FloodZoneFeature>,
): BBox | null {
  if (zones.length === 0) return null;
  let westLng = Infinity;
  let southLat = Infinity;
  let eastLng = -Infinity;
  let northLat = -Infinity;
  for (const z of zones) {
    westLng = Math.min(westLng, z.westLng);
    southLat = Math.min(southLat, z.southLat);
    eastLng = Math.max(eastLng, z.eastLng);
    northLat = Math.max(northLat, z.northLat);
  }
  return { westLng, southLat, eastLng, northLat };
}

function cellCoords(
  lng: number,
  lat: number,
  bbox: BBox,
  cellDegLng: number,
  cellDegLat: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = clamp(
    Math.floor((lng - bbox.westLng) / cellDegLng),
    0,
    cols - 1,
  );
  const row = clamp(
    Math.floor((lat - bbox.southLat) / cellDegLat),
    0,
    rows - 1,
  );
  return { col, row };
}

function flatCellIndex(col: number, row: number, cols: number): number {
  return row * cols + col;
}

/**
 * Build a county spatial grid. Each zone is registered in every cell its
 * bbox intersects. Cell dimensions derive from total vertex count and extent.
 */
export function buildFloodZoneGrid(
  zones: ReadonlyArray<FloodZoneFeature>,
  bbox?: BBox,
): FloodZoneGrid | null {
  const t0 = performance.now();
  if (zones.length === 0) return null;

  const gridBbox = bbox ?? bboxFromZones(zones);
  if (!gridBbox) return null;

  let totalVertices = 0;
  for (const z of zones) {
    totalVertices += countGeometryVertices(z.geometry);
  }
  totalVertices = Math.max(totalVertices, 1);

  const lngSpan = Math.max(gridBbox.eastLng - gridBbox.westLng, 1e-9);
  const latSpan = Math.max(gridBbox.northLat - gridBbox.southLat, 1e-9);
  const aspectRatio = lngSpan / latSpan;
  const totalCells = totalVertices / FLOOD_ZONE_GRID_VERTEX_BUDGET;
  const cols = clamp(
    Math.round(Math.sqrt(totalCells * aspectRatio)),
    MIN_GRID_DIM,
    MAX_GRID_DIM,
  );
  const rows = clamp(
    Math.round(totalCells / cols),
    MIN_GRID_DIM,
    MAX_GRID_DIM,
  );

  const cellDegLng = lngSpan / cols;
  const cellDegLat = latSpan / rows;

  const cellCount = cols * rows;
  const cells: number[][] = Array.from({ length: cellCount }, () => []);

  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi]!;
    const minCol = clamp(
      Math.floor((z.westLng - gridBbox.westLng) / cellDegLng),
      0,
      cols - 1,
    );
    const maxCol = clamp(
      Math.floor((z.eastLng - gridBbox.westLng) / cellDegLng),
      0,
      cols - 1,
    );
    const minRow = clamp(
      Math.floor((z.southLat - gridBbox.southLat) / cellDegLat),
      0,
      rows - 1,
    );
    const maxRow = clamp(
      Math.floor((z.northLat - gridBbox.southLat) / cellDegLat),
      0,
      rows - 1,
    );
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        cells[flatCellIndex(col, row, cols)]!.push(zi);
      }
    }
  }

  return {
    cells,
    bbox: gridBbox,
    cellDegLng,
    cellDegLat,
    cols,
    rows,
    buildMs: performance.now() - t0,
  };
}

/** Collect deduped zone indices from the 3×3 neighborhood around a point. */
export function gatherGridCandidateIndices(
  lng: number,
  lat: number,
  grid: FloodZoneGrid,
): number[] {
  const { col, row } = cellCoords(
    lng,
    lat,
    grid.bbox,
    grid.cellDegLng,
    grid.cellDegLat,
    grid.cols,
    grid.rows,
  );
  const seen = new Set<number>();
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
      const idx = flatCellIndex(c, r, grid.cols);
      for (const zi of grid.cells[idx] ?? []) {
        if (seen.has(zi)) continue;
        seen.add(zi);
        out.push(zi);
      }
    }
  }
  return out;
}

function pickZoneFromCandidates(
  candidates: FloodZoneFeature[],
): FloodZoneFeature | null {
  if (candidates.length === 0) return null;
  const sfha = candidates.find((c) => isSfhaFlag(c.sfhaTf));
  return sfha ?? candidates[0]!;
}

/**
 * Point-in-polygon zone lookup using the spatial grid. Exact PIP is the
 * final arbiter; grid only narrows candidates.
 */
export function findZoneAtPointWithGrid(
  lng: number,
  lat: number,
  grid: FloodZoneGrid,
  zones: ReadonlyArray<FloodZoneFeature>,
): FloodZoneFeature | null {
  const candidateIndices = gatherGridCandidateIndices(lng, lat, grid);
  const candidates: FloodZoneFeature[] = [];
  for (const zi of candidateIndices) {
    const z = zones[zi];
    if (!z) continue;
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
  return pickZoneFromCandidates(candidates);
}
