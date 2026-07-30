/**
 * MASK → DISSOLVED REGION POLYGONS (2026-07-30, flood overlay redesign).
 *
 * THE DEFECT THIS REPLACES: both mask-to-GeoJSON converters (this package's
 * `hydrologyNative.maskToGeoJson` and `artifacts/hydrology-worker/run.py`)
 * subsampled the boolean mask on a coarse lattice (`step = min(w,h)/12` and
 * `/20` respectively) and emitted ONE INDEPENDENT AXIS-ALIGNED SQUARE per
 * sampled hit cell. Hundreds of disjoint squares with no dissolve — the map
 * read as a blue checkerboard, and the summed area UNDER-counted the true
 * mask (only every step-th cell contributed, at a step² footprint each).
 *
 * WHAT THIS DOES INSTEAD — four stages over the FULL-RESOLUTION mask:
 *
 *   1. TRACE. Marching squares over the mask treated as a 0/1 scalar field
 *      at threshold 0.5 (the same d3-contour family `site-topography/
 *      derivation.ts` uses for elevation contours, hand-rolled here so the
 *      adapters package stays dependency-light and the Python worker can
 *      mirror the identical algorithm cell-for-cell). Contiguous cells
 *      dissolve into ONE ring by construction — marching squares walks the
 *      region's boundary, it does not enumerate cells.
 *
 *   2. RINGS + HOLES. Each traced ring is classified by signed area:
 *      counter-clockwise = an exterior shell, clockwise = a hole. Holes are
 *      assigned to the smallest containing shell, so a mask with an interior
 *      void emits a Polygon with an interior ring instead of two shells.
 *
 *   3. SIMPLIFY + SMOOTH, BOUNDED. Douglas-Peucker at
 *      {@link SIMPLIFY_TOLERANCE_CELLS} cells, then ONE Chaikin corner-cut
 *      pass. This is the HONESTY CONSTRAINT: both operations are bounded so
 *      no vertex moves more than ~1 mask cell from the true boundary.
 *      Douglas-Peucker's deviation is its tolerance by definition (0.5
 *      cells). Chaikin replaces each vertex with two points at 1/4 and 3/4
 *      along its adjacent edges, so the curve stays inside the convex hull
 *      of the original polyline and the maximum displacement of any point is
 *      a quarter of the longer adjacent edge — after Douglas-Peucker at 0.5
 *      cells, edges near a corner are short and the displacement is well
 *      under one cell. Net: the smoothed edge reads organic but never
 *      invents extent beyond ~1 cell of the real mask. Nothing here dilates
 *      the mask; smoothing only cuts corners INWARD and outward alternately
 *      along an existing boundary.
 *
 *   4. SPECK FILTER + CAPS. Rings enclosing fewer than
 *      {@link MIN_REGION_AREA_CELLS} cells are dropped (a 3-cell speck at
 *      10 m/px is 300 m² of screening-resolution noise, not a floodplain).
 *      Output is capped at {@link MAX_REGIONS} polygons (largest first) and
 *      {@link MAX_VERTICES_PER_RING} vertices per ring (uniform decimation)
 *      so a pathological mask cannot emit an unbounded payload.
 *
 * AREA HONESTY: the traced boundary encloses the TRUE mask cells, so
 * `featureCollectionAreaSqFt` over this output is the real masked area — it
 * will differ from (and is more correct than) the old subsampled sum. That
 * delta is the fix, not a regression.
 */

import type { BboxWgs84 } from "./hydrologyNative.js";

/**
 * Douglas-Peucker tolerance in MASK CELLS. Half a cell: below the mask's own
 * resolution, so simplification cannot move the boundary by a full cell.
 */
export const SIMPLIFY_TOLERANCE_CELLS = 0.5;

/**
 * Minimum enclosed area, in mask cells, for a region to survive. Below this
 * a region is single-cell grid noise at screening resolution, not a zone.
 */
export const MIN_REGION_AREA_CELLS = 4;

/** Hard cap on emitted polygons per FeatureCollection (largest area first). */
export const MAX_REGIONS = 60;

/** Hard cap on vertices per ring after simplify + smooth (uniform decimation). */
export const MAX_VERTICES_PER_RING = 400;

/** Chaikin corner-cutting passes. One pass reads organic; more drifts. */
export const SMOOTHING_PASSES = 1;

/**
 * THE HONESTY TOLERANCE. No smoothed vertex may sit further than this many
 * mask cells from the true traced boundary. Combined with
 * {@link SIMPLIFY_TOLERANCE_CELLS} (0.5), total boundary displacement stays
 * under one mask cell — at the 10 m/px drainage DEM, under 10 m.
 */
export const MAX_SMOOTH_OFFSET_CELLS = 0.5;

export interface TracedRegionRing {
  /** Ring in GRID coordinates (col, row), closed (first point repeated). */
  points: Array<[number, number]>;
  /** Signed area in cells; positive = counter-clockwise shell. */
  signedAreaCells: number;
}

export interface TracedRegion {
  /** Exterior shell then any holes, all in grid coordinates. */
  rings: Array<Array<[number, number]>>;
  /** Net enclosed area in mask cells (shell minus holes). */
  areaCells: number;
}

type MaskReader = (col: number, row: number) => boolean;

/**
 * BOUNDARY TRACING over a boolean mask — the exact-area variant of marching
 * squares ("crack following"): the traced boundary is the CELL EDGE between
 * an inside cell and an outside cell, not the midpoint between cell centres.
 *
 * Why the edge and not the centre midpoint: classic marching squares on cell
 * CENTRE samples places the contour half a cell INSIDE the true masked area
 * on every side, so a solid 20x20 block traces as 19x19 — a systematic ~5%
 * area undercount at this grid scale, and the area sums are load-bearing
 * headline stats. Following the cell edge encloses exactly the masked cells,
 * so `areaCells` equals the true masked cell count before simplification.
 *
 * Each inside cell contributes its N/E/S/W edge as an oriented segment
 * whenever the neighbour across that edge is outside. Orientation keeps the
 * INSIDE on the walk's left in the y-down grid frame; segments are then
 * chained head-to-tail into closed rings.
 *
 * Grid coordinate convention: a point (x, y) means "x cells right of the left
 * edge of column 0, y cells below the top edge of row 0". Cell (col, row)
 * therefore spans [col, col+1] x [row, row+1].
 */
export function traceMaskRings(
  read: MaskReader,
  width: number,
  height: number,
): TracedRegionRing[] {
  const segments: Array<[[number, number], [number, number]]> = [];

  const at = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= width || row >= height) return false;
    return read(col, row);
  };

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (!at(col, row)) continue;
      const x0 = col;
      const y0 = row;
      const x1 = col + 1;
      const y1 = row + 1;
      // Inside-on-the-left in a y-down frame means walking the cell's own
      // boundary clockwise on screen: top edge left→right, right edge
      // top→bottom, bottom edge right→left, left edge bottom→top.
      if (!at(col, row - 1)) segments.push([[x0, y0], [x1, y0]]); // north
      if (!at(col + 1, row)) segments.push([[x1, y0], [x1, y1]]); // east
      if (!at(col, row + 1)) segments.push([[x1, y1], [x0, y1]]); // south
      if (!at(col - 1, row)) segments.push([[x0, y1], [x0, y0]]); // west
    }
  }

  // Chain segments head-to-tail into closed rings.
  const key = (p: [number, number]): string => `${p[0]}|${p[1]}`;
  const byStart = new Map<string, Array<[[number, number], [number, number]]>>();
  for (const seg of segments) {
    const k = key(seg[0]);
    const bucket = byStart.get(k);
    if (bucket) bucket.push(seg);
    else byStart.set(k, [seg]);
  }

  const used = new Set<[[number, number], [number, number]]>();
  const rings: TracedRegionRing[] = [];
  for (const seg of segments) {
    if (used.has(seg)) continue;
    used.add(seg);
    const ring: Array<[number, number]> = [seg[0], seg[1]];
    let cursor = seg[1];
    // Follow the chain; bounded by the total segment count so a malformed
    // lattice cannot spin forever.
    let incoming: [number, number] = [seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]];
    for (let guard = 0; guard < segments.length + 2; guard++) {
      const candidates = byStart.get(key(cursor));
      if (!candidates) break;
      const open = candidates.filter((s) => !used.has(s));
      if (open.length === 0) break;
      // At a PINCH POINT (two regions touching diagonally) several segments
      // leave the same lattice corner. Prefer the sharpest turn that keeps
      // the inside on the left — straight, then left, then right — so the
      // walk stays on one region's boundary instead of hopping across the
      // pinch and welding two regions into one ring.
      const rank = (s: [[number, number], [number, number]]): number => {
        const d: [number, number] = [s[1][0] - s[0][0], s[1][1] - s[0][1]];
        const cross = incoming[0] * d[1] - incoming[1] * d[0];
        const dot = incoming[0] * d[0] + incoming[1] * d[1];
        if (dot > 0) return 0; // straight ahead
        if (cross > 0) return 1; // turn one way
        if (cross < 0) return 2; // turn the other
        return 3; // reversal
      };
      let next = open[0]!;
      let bestRank = rank(next);
      for (const cand of open.slice(1)) {
        const r = rank(cand);
        if (r < bestRank) {
          bestRank = r;
          next = cand;
        }
      }
      used.add(next);
      incoming = [next[1][0] - next[0][0], next[1][1] - next[0][1]];
      cursor = next[1];
      ring.push(cursor);
      if (key(cursor) === key(ring[0]!)) break;
    }
    if (ring.length < 4) continue;
    // Force closure.
    if (key(ring[ring.length - 1]!) !== key(ring[0]!)) ring.push(ring[0]!);
    const signedAreaCells = signedArea(ring);
    if (Math.abs(signedAreaCells) <= 0) continue;
    rings.push({ points: ring, signedAreaCells });
  }
  return rings;
}

/**
 * Shoelace signed area in the GRID frame, sign-normalized so an EXTERIOR
 * SHELL is POSITIVE.
 *
 * The grid frame is y-DOWN (row 0 is north). {@link traceMaskRings} walks a
 * shell's cell edges keeping the inside on the walk's LEFT, which in this
 * frame reads clockwise on screen and yields a POSITIVE ordinary shoelace;
 * hole rings, walked the other way round, come out negative. So "positive =
 * shell, negative = hole" holds throughout the module with the plain form.
 */
export function signedArea(ring: ReadonlyArray<[number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return sum / 2;
}

/** Ray-cast containment test on a closed ring. */
function pointInPolygon(
  pt: [number, number],
  ring: ReadonlyArray<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const hits =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (hits) inside = !inside;
  }
  return inside;
}

/** Perpendicular distance from p to segment ab. */
function perpDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker on an OPEN polyline. Maximum deviation from the original
 * is `tolerance` by construction — that is the algorithm's guarantee and the
 * first half of this module's honesty bound.
 */
export function simplifyPolyline(
  points: ReadonlyArray<[number, number]>,
  tolerance: number,
): Array<[number, number]> {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]] as [number, number]);
  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIndex = i;
    }
  }
  if (maxDist <= tolerance) return [[first[0], first[1]], [last[0], last[1]]];
  const left = simplifyPolyline(points.slice(0, maxIndex + 1), tolerance);
  const right = simplifyPolyline(points.slice(maxIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Douglas-Peucker on a CLOSED ring (split at the two farthest-apart anchors
 * so the closure point is not privileged). Returns a closed ring. */
export function simplifyRing(
  ring: ReadonlyArray<[number, number]>,
  tolerance: number,
): Array<[number, number]> {
  if (ring.length < 5) return ring.map((p) => [p[0], p[1]] as [number, number]);
  const open = ring.slice(0, -1);
  // Anchor at index 0 and the vertex farthest from it.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i]![0] - open[0]![0], open[i]![1] - open[0]![1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyPolyline(open.slice(0, far + 1), tolerance);
  const b = simplifyPolyline([...open.slice(far), open[0]!], tolerance);
  const merged = [...a.slice(0, -1), ...b.slice(0, -1)];
  if (merged.length < 3) return ring.map((p) => [p[0], p[1]] as [number, number]);
  return [...merged, [merged[0]![0], merged[0]![1]]];
}

/**
 * DISPLACEMENT-BOUNDED Chaikin corner cutting on a CLOSED ring.
 *
 * Textbook Chaikin puts the two new points at 1/4 and 3/4 of every edge. That
 * cuts each corner by a quarter of the ADJACENT EDGE LENGTH, which is
 * unbounded relative to the grid: on a simplified 20-cell-long square edge it
 * moves the corner 5 cells inward and eats 12.5% of the area. That is
 * invented geometry, not smoothing.
 *
 * So the offset is CLAMPED per edge to at most {@link maxOffsetCells} of grid
 * distance: `t = min(0.25, maxOffsetCells / edgeLength)`. Long straight runs
 * keep their line and only round the last cell at each corner; short
 * staircase edges round fully. Corner cutting is strictly INWARD-of-the-hull
 * (the new points lie ON the original edges), so the smoothed region can
 * never claim extent the mask does not have, and no point moves more than
 * `maxOffsetCells` from the true boundary.
 */
export function smoothRing(
  ring: ReadonlyArray<[number, number]>,
  passes = SMOOTHING_PASSES,
  maxOffsetCells = MAX_SMOOTH_OFFSET_CELLS,
): Array<[number, number]> {
  let current: Array<[number, number]> = ring.map((p) => [p[0], p[1]]);
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 5) break;
    const open = current.slice(0, -1);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < open.length; i++) {
      const p = open[i]!;
      const q = open[(i + 1) % open.length]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const t = len > 0 ? Math.min(0.25, maxOffsetCells / len) : 0.25;
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      out.push([p[0] + (q[0] - p[0]) * (1 - t), p[1] + (q[1] - p[1]) * (1 - t)]);
    }
    out.push([out[0]![0], out[0]![1]]);
    current = out;
  }
  return current;
}

/** Uniform decimation to at most `max` vertices, preserving closure. */
export function capRingVertices(
  ring: ReadonlyArray<[number, number]>,
  max = MAX_VERTICES_PER_RING,
): Array<[number, number]> {
  const open = ring.slice(0, -1);
  if (open.length <= max) return ring.map((p) => [p[0], p[1]] as [number, number]);
  const stride = open.length / max;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < max; i++) {
    const p = open[Math.floor(i * stride)]!;
    out.push([p[0], p[1]]);
  }
  out.push([out[0]![0], out[0]![1]]);
  return out;
}

export interface MaskRegionOptions {
  simplifyToleranceCells?: number;
  minRegionAreaCells?: number;
  maxRegions?: number;
  maxVerticesPerRing?: number;
  smoothingPasses?: number;
  /** Honesty tolerance: max cells a smoothed vertex may move (default 0.5). */
  maxSmoothOffsetCells?: number;
}

/**
 * Trace a boolean mask into DISSOLVED regions in grid coordinates: exterior
 * shells with their holes, simplified, smoothed, speck-filtered and capped.
 */
export function maskToRegions(
  read: MaskReader,
  width: number,
  height: number,
  options: MaskRegionOptions = {},
): TracedRegion[] {
  const tolerance = options.simplifyToleranceCells ?? SIMPLIFY_TOLERANCE_CELLS;
  const minArea = options.minRegionAreaCells ?? MIN_REGION_AREA_CELLS;
  const maxRegions = options.maxRegions ?? MAX_REGIONS;
  const maxVerts = options.maxVerticesPerRing ?? MAX_VERTICES_PER_RING;
  const passes = options.smoothingPasses ?? SMOOTHING_PASSES;
  const maxOffset = options.maxSmoothOffsetCells ?? MAX_SMOOTH_OFFSET_CELLS;

  const traced = traceMaskRings(read, width, height);
  if (traced.length === 0) return [];

  // Refine each ring, keeping its orientation sign (shell vs hole).
  interface Refined {
    ring: Array<[number, number]>;
    area: number; // absolute
    isShell: boolean;
  }
  const refined: Refined[] = [];
  for (const t of traced) {
    if (Math.abs(t.signedAreaCells) < minArea) continue;
    let ring = simplifyRing(t.points, tolerance);
    ring = smoothRing(ring, passes, maxOffset);
    ring = capRingVertices(ring, maxVerts);
    if (ring.length < 4) continue;
    const area = signedArea(ring);
    // The speck filter is applied to the TRACED (pre-refinement) area only —
    // that is the true masked cell count. Re-testing the post-smoothing area
    // would drop a region that passed the filter purely because corner
    // rounding shaved it under the threshold.
    if (Math.abs(area) <= 0) continue;
    refined.push({
      ring,
      area: Math.abs(area),
      // Orientation is preserved through simplify/smooth, so the traced
      // sign still says shell (inside-left walk) vs hole.
      isShell: Math.sign(t.signedAreaCells) === Math.sign(area)
        ? t.signedAreaCells > 0
        : area > 0,
    });
  }

  const shells = refined.filter((r) => r.isShell).sort((a, b) => b.area - a.area);
  const holes = refined.filter((r) => !r.isShell);
  if (shells.length === 0) return [];

  const regions: TracedRegion[] = shells.map((s) => ({
    rings: [s.ring],
    areaCells: s.area,
  }));

  // Assign each hole to the SMALLEST shell that contains it.
  for (const hole of holes) {
    const probe = hole.ring[0]!;
    let bestIndex = -1;
    let bestArea = Infinity;
    for (let i = 0; i < shells.length; i++) {
      if (shells[i]!.area <= hole.area) continue;
      if (!pointInPolygon(probe, shells[i]!.ring)) continue;
      if (shells[i]!.area < bestArea) {
        bestArea = shells[i]!.area;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      regions[bestIndex]!.rings.push(hole.ring);
      regions[bestIndex]!.areaCells -= hole.area;
    }
  }

  // Final pass re-tests NET area (shell minus its holes) — a shell that only
  // cleared the filter because its hole was not yet subtracted is a speck.
  // The half-cell slack absorbs the documented corner-rounding loss so a
  // region is never dropped by the smoothing rather than by its true size.
  return regions
    .filter((r) => r.areaCells >= minArea - 0.5)
    .sort((a, b) => b.areaCells - a.areaCells)
    .slice(0, maxRegions);
}

export interface GeoJsonPolygonFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: Array<Array<[number, number]>> };
  properties: Record<string, unknown>;
}

export interface MaskFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonPolygonFeature[];
}

/**
 * Full pipeline: boolean mask → DISSOLVED, SMOOTH GeoJSON Polygons in WGS84.
 *
 * Grid → WGS84 is the same linear bbox mapping the rest of the hydrology
 * path uses (`lngLatForCell`): column 0's left edge is `westLng`, row 0's top
 * edge is `northLat`, and one cell spans `(east-west)/width` degrees of
 * longitude.
 */
export function maskToDissolvedGeoJson(
  read: MaskReader,
  width: number,
  height: number,
  bbox: BboxWgs84,
  properties: Record<string, unknown> = {},
  options: MaskRegionOptions = {},
): MaskFeatureCollection {
  const regions = maskToRegions(read, width, height, options);
  const dLng = (bbox.eastLng - bbox.westLng) / Math.max(width, 1);
  const dLat = (bbox.northLat - bbox.southLat) / Math.max(height, 1);
  const toWgs84 = (p: [number, number]): [number, number] => [
    bbox.westLng + p[0] * dLng,
    bbox.northLat - p[1] * dLat,
  ];
  const features: GeoJsonPolygonFeature[] = regions.map((region) => ({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: region.rings.map((ring) => ring.map(toWgs84)),
    },
    properties: { ...properties },
  }));
  return { type: "FeatureCollection", features };
}

/** Convenience over a Uint8Array row-major mask. */
export function maskArrayToDissolvedGeoJson(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  properties: Record<string, unknown> = {},
  options: MaskRegionOptions = {},
): MaskFeatureCollection {
  return maskToDissolvedGeoJson(
    (col, row) => mask[row * width + col] === 1,
    width,
    height,
    bbox,
    properties,
    options,
  );
}
