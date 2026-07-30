import type { BboxWgs84 } from "@hauska-engine/adapters";

/**
 * TRACED FLOW PATHS + CATCHMENT SWATHS (2026-07-29, Flood & Drainage v3 —
 * the "watershed graphics" payload).
 *
 * Extends the flood study payload, BACKWARD-COMPATIBLY (optional fields;
 * PE feature-detects), with the channels the water gradient already shades
 * as first-class vector geometry the map can style by STRENGTH:
 *
 * PINNED CONTRACT (the PE leg codes to this):
 *
 *   flowPaths: [{
 *     coordinates: [[lng, lat], ...],   // ordered DOWNSTREAM
 *     strength: number,                 // 0..1 normalized log flow accumulation
 *     kind: "interior" | "exit",        // "exit" = crosses the parcel ring
 *   }]
 *
 *   catchmentSwaths: [{                 // index-aligned with flowPaths
 *     coordinates: [[lng, lat], ...],   // ONE closed polygon exterior ring
 *     strength: number,                 // the owning path's strength
 *     kind: "interior" | "exit",
 *   }]
 *
 * HONESTY / DERIVATION (documented here and in the payload note):
 *
 *   - Paths trace the SAME D8 flow-accumulation model the gradient raster
 *     uses (no second hydrology): every cell at or above the study's channel
 *     threshold is a channel cell; channel HEADS (channel cells with no
 *     upstream channel neighbor draining into them) seed a downstream walk
 *     along the D8 flow directions, so every path runs downstream by
 *     construction.
 *   - Paths are ranked by terminal accumulation (main trunks first) and
 *     deduplicated greedily: a later path stops where it merges into an
 *     already-accepted channel, keeping the junction vertex so ribbons
 *     visually connect. Top {@link FLOW_PATHS_MAX} survive.
 *   - `strength` = log1p(maxAccumulationOnOwnCells) / log1p(gridMax) — the
 *     SAME normalization the gradient intensity uses, so a path's ribbon
 *     weight agrees with the raster shading underneath it.
 *   - `kind: "exit"` marks paths whose trace leaves the parcel ring (an
 *     inside → outside vertex transition, the `resolveFlowExits` rule).
 *   - Each CATCHMENT SWATH buffers its path with a half-width LINEAR IN THE
 *     SAME normalized log accumulation, clamped between
 *     {@link SWATH_MIN_HALF_WIDTH_CELLS} and {@link SWATH_MAX_HALF_WIDTH_CELLS}
 *     DEM cells — because accumulation is monotonically non-decreasing
 *     downstream, the corridor honestly WIDENS downstream (the contributing
 *     watershed feeding the channel). It is a styled reading of the model,
 *     never a delineated watershed boundary, and the note says so.
 *   - Size discipline: paths are Douglas-Peucker simplified (tolerance
 *     ~0.4 cell) then hard-capped at {@link FLOW_PATH_MAX_POINTS} vertices.
 */

export type FloodFlowPathKind = "interior" | "exit";

export interface FloodFlowPath {
  /** WGS84 [lng, lat] vertices, ordered downstream. */
  coordinates: Array<[number, number]>;
  /** 0..1 — log1p(path max accumulation) / log1p(grid max accumulation). */
  strength: number;
  kind: FloodFlowPathKind;
}

export interface FloodCatchmentSwath {
  /** ONE closed polygon exterior ring (first vertex repeated last), WGS84. */
  coordinates: Array<[number, number]>;
  /** The owning flow path's strength (index-aligned with flowPaths). */
  strength: number;
  kind: FloodFlowPathKind;
}

export interface FloodFlowPathsResult {
  flowPaths: FloodFlowPath[];
  /** Index-aligned with flowPaths (swath i feeds path i). */
  catchmentSwaths: FloodCatchmentSwath[];
  /** Provenance sentence documenting the derivation (payload note). */
  note: string;
}

/** Hard cap on emitted paths — the boldest channels only. */
export const FLOW_PATHS_MAX = 12;

/** Hard cap on vertices per path (simplify first, decimate as last resort). */
export const FLOW_PATH_MAX_POINTS = 200;

/** A path must claim at least this many own cells to be worth drawing. */
export const FLOW_PATH_MIN_CELLS = 3;

/** Swath half-width bounds, in DEM cells (scaled by the DEM resolution). */
export const SWATH_MIN_HALF_WIDTH_CELLS = 0.75;
export const SWATH_MAX_HALF_WIDTH_CELLS = 4;

const METERS_PER_DEG_LAT = 110_574;

/** D8 neighbor offsets [dCol, dRow] — MUST mirror the adapter's table
 *  (`hydrologyNative.ts` D8_OFFSETS; fdir d+1 points at offset d). The
 *  downstream-ordering test runs against the REAL `computeD8Field`, so a
 *  drift here fails loudly. */
const D8_OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

/** Ray-cast point-in-ring on WGS84 [lng, lat] pairs (local copy — importing
 *  from flood-drainage-study would create a module cycle). */
function pointInRing(
  lng: number,
  lat: number,
  ring: ReadonlyArray<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export interface BuildFloodFlowPathsOptions {
  /** Row-major elevation grid (NaN = nodata), row 0 = north — the finite
   *  mask for strength normalization. */
  elevation: Float32Array;
  width: number;
  height: number;
  /** D8 flow accumulation for the SAME grid (cells of upstream flow). */
  accumulation: Uint32Array;
  /** D8 flow direction per cell (0 = no downslope neighbor). */
  fdir: Int8Array;
  /** The WGS84 bbox the grid maps (the padded catchment bbox). */
  bbox: BboxWgs84;
  /** The study's channel threshold (cells of accumulated flow). */
  accumulationThreshold: number;
  /** Parcel boundary ring — drives the interior/exit classification. */
  parcelRing: ReadonlyArray<[number, number]>;
  /** DEM resolution (meters/px) — scales swath widths + the note. */
  demResolutionMeters: number;
}

interface TracedPath {
  /** Cell indices, ordered downstream. Last cell may be a BORROWED junction
   *  vertex owned by an earlier path (ownCellCount excludes it). */
  cells: number[];
  ownCellCount: number;
}

function traceDownstream(
  start: number,
  fdir: Int8Array,
  width: number,
  height: number,
): number[] {
  const cells: number[] = [start];
  let cur = start;
  const cap = width * height;
  for (let step = 0; step < cap; step++) {
    const dir = fdir[cur]!;
    if (dir <= 0) break;
    const col = cur % width;
    const row = Math.floor(cur / width);
    const [dc, dr] = D8_OFFSETS[dir - 1]!;
    const nc = col + dc;
    const nr = row + dr;
    if (nc < 0 || nr < 0 || nc >= width || nr >= height) break;
    cur = nr * width + nc;
    cells.push(cur);
  }
  return cells;
}

/** Douglas-Peucker on a lat-corrected planar projection; returns KEPT indices
 *  (always includes endpoints), preserving order. */
export function douglasPeuckerIndices(
  points: ReadonlyArray<[number, number]>,
  toleranceDeg: number,
): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  const meanLat = ((points[0]![1] + points[points.length - 1]![1]) / 2) * (Math.PI / 180);
  const kx = Math.cos(meanLat);
  const xs = points.map((p) => p[0] * kx);
  const ys = points.map((p) => p[1]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = xs[a]!;
    const ay = ys[a]!;
    const dx = xs[b]! - ax;
    const dy = ys[b]! - ay;
    const len = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const dist =
        len > 0
          ? Math.abs(dx * (ys[i]! - ay) - dy * (xs[i]! - ax)) / len
          : Math.hypot(xs[i]! - ax, ys[i]! - ay);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceDeg && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
}

/** Uniform decimation to at most maxPoints, always keeping both endpoints. */
function decimateIndices(indices: number[], maxPoints: number): number[] {
  if (indices.length <= maxPoints) return indices;
  const out: number[] = [];
  const step = (indices.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(indices[Math.round(i * step)]!);
  }
  // Rounding can duplicate; dedupe while preserving order.
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

/**
 * Variable-width buffer of a downstream path: per-vertex half-width linear in
 * the vertex's normalized log accumulation, offset along the local normal in
 * meter space. Returns ONE closed exterior ring.
 */
export function buildSwathRing(
  vertices: ReadonlyArray<[number, number]>,
  halfWidthsMeters: ReadonlyArray<number>,
): Array<[number, number]> {
  const n = vertices.length;
  if (n < 2) return [];
  const lat0 = vertices[0]![1];
  const mLng = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  // Per-segment unit directions in meter space.
  const dirs: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = (vertices[i + 1]![0] - vertices[i]![0]) * mLng;
    const dy = (vertices[i + 1]![1] - vertices[i]![1]) * METERS_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    dirs.push(len > 0 ? [dx / len, dy / len] : dirs[dirs.length - 1] ?? [1, 0]);
  }
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const dPrev = dirs[Math.max(0, i - 1)]!;
    const dNext = dirs[Math.min(dirs.length - 1, i)]!;
    let vx = dPrev[0] + dNext[0];
    let vy = dPrev[1] + dNext[1];
    const vlen = Math.hypot(vx, vy);
    if (vlen > 0) {
      vx /= vlen;
      vy /= vlen;
    } else {
      // Hairpin: fall back to the outgoing segment direction.
      vx = dNext[0];
      vy = dNext[1];
    }
    const nx = -vy;
    const ny = vx;
    const h = halfWidthsMeters[i]!;
    const [lng, lat] = vertices[i]!;
    left.push([lng + (nx * h) / mLng, lat + (ny * h) / METERS_PER_DEG_LAT]);
    right.push([lng - (nx * h) / mLng, lat - (ny * h) / METERS_PER_DEG_LAT]);
  }
  right.reverse();
  const ring = [...left, ...right];
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

function buildNote(options: BuildFloodFlowPathsOptions): string {
  return (
    "Flow paths trace the top D8 flow-accumulation channels of the same model as the water gradient, " +
    "ordered downstream; strength is log-normalized flow accumulation. " +
    "Catchment swaths buffer each path with a width proportional to the same normalized accumulation, " +
    `widening downstream, over the elevation model at ${options.demResolutionMeters} m per pixel. ` +
    "Styled reading of the screening model, not a delineated watershed boundary."
  );
}

/**
 * Build the traced flow paths + catchment swaths from the study's D8 field.
 * Returns null when no cell reaches the channel threshold — absent fields
 * are honest; a fabricated channel never ships (old consumers see nothing).
 */
export function buildFloodFlowPaths(
  options: BuildFloodFlowPathsOptions,
): FloodFlowPathsResult | null {
  const { elevation, width, height, accumulation, fdir, bbox, parcelRing } = options;
  const n = width * height;
  if (width < 2 || height < 2) return null;
  const threshold = Math.max(1, options.accumulationThreshold);

  let maxAcc = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(elevation[i]!)) continue;
    if (accumulation[i]! > maxAcc) maxAcc = accumulation[i]!;
  }
  if (maxAcc < threshold) return null;
  const logMax = Math.log1p(maxAcc);

  // Channel mask + HEAD detection: a head is a channel cell no channel
  // neighbor drains into.
  const channel = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(elevation[i]!) && accumulation[i]! >= threshold) channel[i] = 1;
  }
  const heads: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (!channel[i]) continue;
      let hasUpstreamChannel = false;
      for (let d = 0; d < D8_OFFSETS.length; d++) {
        const [dc, dr] = D8_OFFSETS[d]!;
        const nc = col - dc;
        const nr = row - dr;
        if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
        const ni = nr * width + nc;
        // Neighbor at (col-dc,row-dr) drains INTO i when its fdir is d+1.
        if (channel[ni] && fdir[ni] === d + 1) {
          hasUpstreamChannel = true;
          break;
        }
      }
      if (!hasUpstreamChannel) heads.push(i);
    }
  }
  if (heads.length === 0) return null;

  // Trace every head downstream, rank by terminal accumulation (main trunks
  // first; longer chain wins ties), then greedily claim cells so tributaries
  // trim at their junction into an accepted channel.
  const raw = heads.map((head) => {
    const cells = traceDownstream(head, fdir, width, height);
    return { cells, terminalAcc: accumulation[cells[cells.length - 1]!]! };
  });
  raw.sort((a, b) => b.terminalAcc - a.terminalAcc || b.cells.length - a.cells.length);

  const claimed = new Uint8Array(n);
  const accepted: TracedPath[] = [];
  for (const candidate of raw) {
    if (accepted.length >= FLOW_PATHS_MAX) break;
    const kept: number[] = [];
    let borrowedJunction = false;
    for (const cell of candidate.cells) {
      if (claimed[cell]) {
        kept.push(cell); // junction vertex — ribbons connect visually.
        borrowedJunction = true;
        break;
      }
      kept.push(cell);
    }
    const ownCellCount = borrowedJunction ? kept.length - 1 : kept.length;
    if (ownCellCount < FLOW_PATH_MIN_CELLS) continue;
    for (let i = 0; i < ownCellCount; i++) claimed[kept[i]!] = 1;
    accepted.push({ cells: kept, ownCellCount });
  }
  if (accepted.length === 0) return null;

  const cellLng = (bbox.eastLng - bbox.westLng) / Math.max(width, 1);
  const cellLat = (bbox.northLat - bbox.southLat) / Math.max(height, 1);
  const cellCenter = (i: number): [number, number] => {
    const col = i % width;
    const row = Math.floor(i / width);
    return [
      bbox.westLng + (col + 0.5) * cellLng,
      bbox.northLat - (row + 0.5) * cellLat,
    ];
  };
  const resM = options.demResolutionMeters;
  const dpTolerance = Math.abs(cellLat) * 0.4;

  const flowPaths: FloodFlowPath[] = [];
  const catchmentSwaths: FloodCatchmentSwath[] = [];
  for (const path of accepted) {
    // Strength from OWN cells only — a tributary must not inherit the trunk's
    // accumulation through its borrowed junction vertex.
    let maxOwnAcc = 0;
    for (let i = 0; i < path.ownCellCount; i++) {
      const a = accumulation[path.cells[i]!]!;
      if (a > maxOwnAcc) maxOwnAcc = a;
    }
    const strength = logMax > 0 ? Math.log1p(maxOwnAcc) / logMax : 0;

    const fullCoords = path.cells.map(cellCenter);
    let keptIdx = douglasPeuckerIndices(fullCoords, dpTolerance);
    keptIdx = decimateIndices(keptIdx, FLOW_PATH_MAX_POINTS);
    const coordinates = keptIdx.map((i) => fullCoords[i]!);
    if (coordinates.length < 2) continue;

    // "exit" = the trace LEAVES the parcel ring (inside → outside transition,
    // the resolveFlowExits rule) — evaluated on the FULL trace so simplify
    // cannot drop the crossing.
    let kind: FloodFlowPathKind = "interior";
    let prevIn = pointInRing(fullCoords[0]![0], fullCoords[0]![1], parcelRing);
    for (let i = 1; i < fullCoords.length; i++) {
      const curIn = pointInRing(fullCoords[i]![0], fullCoords[i]![1], parcelRing);
      if (prevIn && !curIn) {
        kind = "exit";
        break;
      }
      prevIn = curIn;
    }

    // Swath: per-vertex half-width linear in the vertex's normalized log
    // accumulation — widens downstream because accumulation only grows.
    const halfWidths = keptIdx.map((i) => {
      const s = logMax > 0 ? Math.log1p(accumulation[path.cells[i]!]!) / logMax : 0;
      return (
        resM *
        (SWATH_MIN_HALF_WIDTH_CELLS +
          (SWATH_MAX_HALF_WIDTH_CELLS - SWATH_MIN_HALF_WIDTH_CELLS) * s)
      );
    });
    const ring = buildSwathRing(coordinates, halfWidths);

    const rounded = (p: [number, number]): [number, number] => [
      Math.round(p[0] * 1e7) / 1e7,
      Math.round(p[1] * 1e7) / 1e7,
    ];
    flowPaths.push({
      coordinates: coordinates.map(rounded),
      strength: Math.round(strength * 1000) / 1000,
      kind,
    });
    catchmentSwaths.push({
      coordinates: ring.map(rounded),
      strength: Math.round(strength * 1000) / 1000,
      kind,
    });
  }
  if (flowPaths.length === 0) return null;

  return { flowPaths, catchmentSwaths, note: buildNote(options) };
}
