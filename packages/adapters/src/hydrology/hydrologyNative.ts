/**
 * Inline D8 hydrology engine — Phase 2D.2/2D.3 fallback when the
 * pysheds Python sidecar is unavailable (local dev, CI). Mirrors the
 * Python worker's JSON result shape so `siteDrainageIngest` can swap
 * backends without changing the atom payload.
 */

import { maskArrayToDissolvedGeoJson } from "./maskRegions.js";

export interface BboxWgs84 {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: ReadonlyArray<{
    type: "Feature";
    geometry: {
      type: string;
      coordinates: unknown;
    };
    properties?: Record<string, unknown>;
  }>;
}

export interface HydrologyNativeInput {
  width: number;
  height: number;
  /** Row-major elevation meters; NaN = nodata. */
  elevation: Float32Array;
  catchmentBbox: BboxWgs84;
  pourLng: number;
  pourLat: number;
  rainfallDepthMm?: number;
  accumulationThreshold?: number;
}

export interface HydrologyNativeSuccess {
  status: "ok";
  library: "native-d8";
  libraryVersion: "1.0.0";
  routing: "d8";
  accumulationThreshold: number;
  drainageZonesGeoJson: GeoJsonFeatureCollection;
  /**
   * THREE NESTED CONCENTRATION BANDS traced from the SAME D8 accumulation
   * grid the flow lines come from (`concentration` 0 low / 1 medium / 2 high
   * on each feature). Additive to the pinned payload contract — consumers
   * feature-detect; absence means the model produced no gradable field, and
   * the study falls back to grading the catchment itself as band 0.
   */
  concentrationBandsGeoJson?: GeoJsonFeatureCollection;
  flowLinesGeoJson: GeoJsonFeatureCollection;
  rainfallResultGeoJson: GeoJsonFeatureCollection | null;
  pourPoint: { lng: number; lat: number };
}

export interface HydrologyNativeError {
  status: "error";
  code: string;
  message: string;
  library: "native-d8";
  libraryVersion: "1.0.0";
  routing: "d8";
  accumulationThreshold: number;
  drainageZonesGeoJson: GeoJsonFeatureCollection;
  flowLinesGeoJson: GeoJsonFeatureCollection;
  rainfallResultGeoJson: GeoJsonFeatureCollection | null;
  pourPoint: { lng: number; lat: number };
}

export type HydrologyNativeResult = HydrologyNativeSuccess | HydrologyNativeError;

/**
 * Long-standing default D8 accumulation threshold, in CELLS of accumulated
 * flow: a channel is emitted for cells whose accumulation count is at or above
 * this value (see `flowLinesFromAccumulation`). Calibrated against ~10m DEMs.
 */
export const ACCUMULATION_THRESHOLD_BASE_CELLS = 50;

/**
 * The DEM resolution (meters per pixel) the 50-cell base threshold was
 * calibrated against (the historical 10m 3DEP default).
 */
export const ACCUMULATION_THRESHOLD_REFERENCE_RESOLUTION_METERS = 10;

/**
 * Scale the D8 accumulation threshold with DEM resolution so channel density is
 * resolution-invariant (fix/hydrology-resolution-floor, 2026-07-28).
 *
 * The threshold is in CELLS of accumulated flow. A cell's upstream drainage
 * area is `accumulation * resolution^2` m², so holding the PHYSICAL drainage
 * -area cutoff constant at the 10m-reference 50-cell value means:
 *
 *   threshold(res) = round(50 * (10 / res)^2), clamped at >= 50
 *
 * Without this, a finer DEM (e.g. 1m) makes the same 50-cell cutoff represent a
 * ~100x smaller physical drainage area, exploding flow-seed count (~100x more
 * cells over threshold) and channel-trace compute. The clamp keeps coarse DEMs
 * (>= 10m) at the long-standing 50-cell default.
 */
export function accumulationThresholdForResolution(
  resolutionMeters: number,
): number {
  if (!Number.isFinite(resolutionMeters) || resolutionMeters <= 0) {
    return ACCUMULATION_THRESHOLD_BASE_CELLS;
  }
  const scaled = Math.round(
    ACCUMULATION_THRESHOLD_BASE_CELLS *
      (ACCUMULATION_THRESHOLD_REFERENCE_RESOLUTION_METERS / resolutionMeters) **
        2,
  );
  return Math.max(ACCUMULATION_THRESHOLD_BASE_CELLS, scaled);
}

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

function idx(col: number, row: number, width: number): number {
  return row * width + col;
}

function isFiniteElev(v: number): boolean {
  return Number.isFinite(v);
}

function lngLatForCell(
  col: number,
  row: number,
  width: number,
  height: number,
  bbox: BboxWgs84,
): [number, number] {
  const lng =
    bbox.westLng +
    ((col + 0.5) / Math.max(width, 1)) * (bbox.eastLng - bbox.westLng);
  const lat =
    bbox.northLat -
    ((row + 0.5) / Math.max(height, 1)) * (bbox.northLat - bbox.southLat);
  return [lng, lat];
}

/**
 * MINIMUM PONDING DEPTH — the depth of standing water below which a cell is
 * NOT reported as ponded (2026-07-30 credible-ponding fix).
 *
 * 0.1 m (about 4 inches). The number a customer reads in "modeled ponding
 * covers N acres" has to mean water that would actually matter to a building
 * pad, a driveway or a finished-floor elevation. Four inches of standing water
 * is the shallowest depth that plausibly does: it is deep enough to be a real
 * site-design constraint rather than a wet patch, and shallow enough that a
 * genuine depression is not silently dropped.
 *
 * The prior rule used 0.005 m (5 mm) — a quarter-inch trace of wetness, which
 * on any rained-on terrain qualifies essentially every cell.
 */
export const MIN_PONDING_DEPTH_METERS = 0.1;

/**
 * PONDING = DEPRESSION STORAGE, NOT WETNESS (2026-07-30 credible-ponding fix).
 *
 * WHAT THE OLD RULE DID AND WHY IT WAS NOT DEFENSIBLE. The native fallback
 * computed, per cell, `slopeProxy = 1 / accumulation` and
 * `pondDepth = rainfallDepth * min(1, slopeProxy * 10)`, then called the cell
 * ponded when `pondDepth > 0.005` (5 mm). That rule has two independent
 * defects:
 *
 *   1. IT IS INVERTED. Ponding rose as accumulation FELL, so a ridge cell with
 *      one upstream cell scored the FULL design-storm depth while a valley
 *      channel cell scored the least. It ponded the hilltops.
 *   2. THE THRESHOLD WAS A TRACE. `slopeProxy * 10 >= 1` for every cell with
 *      accumulation <= 10, so pondDepth saturated at the full storm depth over
 *      broad areas, and even off saturation the 5 mm bar passed everywhere.
 *      Measured on a 115x115 10 m grid over a gentle dome: 13,225 of 13,225
 *      cells (100%) qualified. On the live Bastrop parcel 48021:36249 this
 *      reported 396,134 sq ft of ponding on a 398,813 sq ft parcel — 99.3% of
 *      the parcel — inside a briefing that simultaneously said the parcel is a
 *      local high point that sheds water.
 *
 * WHAT THE NEW RULE DOES. A cell ponds when it is an actual DEPRESSION and the
 * water that collects there is deep enough to matter:
 *
 *   depressionDepth = filledElevation - rawElevation
 *
 * Depression-filling raises exactly those cells that have no downslope escape
 * — the sinks. `depressionDepth` is the height of the lip that traps water
 * there, in meters, straight out of the same D8 preprocessing the rest of the
 * model already runs. A cell on a slope has `filled == raw`, so its depression
 * depth is 0 and it never ponds no matter how hard it rains. That is the
 * physical statement "water runs off a slope; it stands in a hollow".
 *
 * The ponded depth is then the lesser of what the depression can HOLD and what
 * the storm DELIVERS — a sink deeper than the design storm only fills to the
 * storm depth, and a shallow sink only holds its own depth:
 *
 *   pondDepth = min(depressionDepth, rainfallDepth)
 *
 * A cell is ponded when `pondDepth >= MIN_PONDING_DEPTH_METERS`.
 *
 * WHAT THIS DOES AND DOES NOT REPRESENT — state this plainly, it ships in the
 * payload provenance. It DOES represent: screening-level identification of
 * closed depressions on the DEM that would hold at least 4 inches of standing
 * water under the design storm. It does NOT represent: a routed hydraulic
 * model, infiltration, soil storage, storm-sewer or culvert capacity, or the
 * timing/duration of any flood. It is a D8 + design-storm screening product at
 * the DEM's resolution, and a depression smaller than one DEM cell is
 * invisible to it. Verification by a licensed engineer is still required.
 */
export function pondingDepthMeters(
  filledElevation: number,
  rawElevation: number,
  rainfallDepthMeters: number,
): number {
  if (!isFiniteElev(filledElevation) || !isFiniteElev(rawElevation)) return 0;
  const depressionDepth = filledElevation - rawElevation;
  if (!(depressionDepth > 0)) return 0;
  return Math.min(depressionDepth, Math.max(0, rainfallDepthMeters));
}

/** True when a cell holds standing water deep enough to report as ponded. */
export function isCellPonded(
  filledElevation: number,
  rawElevation: number,
  rainfallDepthMeters: number,
): boolean {
  return (
    pondingDepthMeters(filledElevation, rawElevation, rainfallDepthMeters) >=
    MIN_PONDING_DEPTH_METERS
  );
}

/**
 * Provenance note shipped on the ponding FeatureCollection so the client, the
 * PDF and the briefing all describe the SAME criterion rather than each
 * narrating its own guess at what the blue area means.
 */
export const PONDING_BASIS_NOTE =
  `modeled depression storage at or above ${MIN_PONDING_DEPTH_METERS} m ` +
  `(${Math.round(MIN_PONDING_DEPTH_METERS * 39.3701)} in) of standing water under the design storm; ` +
  `closed depressions on the DEM only, excluding infiltration, soil storage and drainage infrastructure`;

/**
 * Minimal binary min-heap over cell indices keyed by elevation. Only what
 * priority-flood needs (push / pop-min); no dependency added for this.
 */
class MinHeap {
  private readonly cells: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, key: number): void {
    this.cells.push(cell);
    this.keys.push(key);
    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { cell: number; key: number } | null {
    if (this.cells.length === 0) return null;
    const cell = this.cells[0]!;
    const key = this.keys[0]!;
    const lastCell = this.cells.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.cells.length > 0) {
      this.cells[0] = lastCell;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { cell, key };
  }

  private swap(a: number, b: number): void {
    const c = this.cells[a]!;
    this.cells[a] = this.cells[b]!;
    this.cells[b] = c;
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
  }
}

/**
 * PRIORITY-FLOOD depression filling (Barnes, Lehman & Mulla 2014), replacing
 * the prior single-pass "raise each cell to its lowest neighbour" sweep.
 *
 * WHY THIS HAD TO CHANGE (2026-07-30). The old sweep visited each interior cell
 * ONCE in row-major order and lifted it to its lowest neighbour. That does not
 * converge to a filled surface: in a wide bowl it raises the rim ring slightly
 * and leaves the interior essentially untouched, because the information that
 * the bowl has no outlet never propagates inward. It is adequate only to nudge
 * single-cell pits.
 *
 * That was tolerable while `filled` was used solely to break D8 routing ties,
 * but the ponding criterion now reads `filled - raw` as a PHYSICAL depression
 * depth, and an unconverged fill reports a real 3 m bowl as 0.3 m of storage at
 * the rim and zero at the centre — it would report the genuine flood case as
 * dry. A correct fill is also strictly better for the routing it already fed.
 *
 * The algorithm: seed a min-heap with every border and nodata-adjacent cell (a
 * cell that can drain off-grid), then repeatedly pop the lowest cell and raise
 * each unvisited neighbour to at least the popped cell's level. Every cell is
 * therefore assigned the lowest elevation at which water reaching it can still
 * escape to the grid edge — exactly the filled surface, so `filled - raw` is
 * the depth of water the depression holds before it spills. O(n log n).
 */
function fillDepressions(
  dem: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const size = width * height;
  const out = new Float32Array(size);
  const visited = new Uint8Array(size);
  const heap = new MinHeap();

  const isBorder = (col: number, row: number): boolean =>
    col === 0 || row === 0 || col === width - 1 || row === height - 1;

  // Seed: every cell that can already spill off the grid — the borders, plus
  // any finite cell touching nodata (nodata is an open edge, not a wall).
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = idx(col, row, width);
      const z = dem[i]!;
      if (!isFiniteElev(z)) {
        // Nodata passes through unchanged and is never a fill target.
        out[i] = z;
        visited[i] = 1;
        continue;
      }
      let seed = isBorder(col, row);
      if (!seed) {
        for (const [dc, dr] of D8_OFFSETS) {
          if (!isFiniteElev(dem[idx(col + dc, row + dr, width)]!)) {
            seed = true;
            break;
          }
        }
      }
      if (seed) {
        out[i] = z;
        visited[i] = 1;
        heap.push(i, z);
      }
    }
  }

  while (heap.size > 0) {
    const popped = heap.pop()!;
    const col = popped.cell % width;
    const row = (popped.cell - col) / width;
    for (const [dc, dr] of D8_OFFSETS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
      const ni = idx(nc, nr, width);
      if (visited[ni] === 1) continue;
      const nz = dem[ni]!;
      // The neighbour cannot sit below the level at which water escapes past
      // this cell; raising it to `popped.key` is exactly the fill.
      const filledZ = Math.max(nz, popped.key);
      out[ni] = filledZ;
      visited[ni] = 1;
      heap.push(ni, filledZ);
    }
  }

  // Any cell the flood never reached (fully enclosed by nodata) keeps its raw
  // elevation — never an invented fill.
  for (let i = 0; i < size; i++) {
    if (visited[i] === 0) out[i] = dem[i]!;
  }
  return out;
}

function flowDirection(
  dem: Float32Array,
  width: number,
  height: number,
): Int8Array {
  const fdir = new Int8Array(width * height);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = idx(col, row, width);
      const z = dem[i]!;
      if (!isFiniteElev(z)) {
        fdir[i] = 0;
        continue;
      }
      let bestDrop = 0;
      let bestDir = 0;
      for (let d = 0; d < D8_OFFSETS.length; d++) {
        const [dc, dr] = D8_OFFSETS[d]!;
        const nz = dem[idx(col + dc, row + dr, width)]!;
        if (!isFiniteElev(nz)) continue;
        const drop = z - nz;
        if (drop > bestDrop) {
          bestDrop = drop;
          bestDir = d + 1;
        }
      }
      fdir[i] = bestDir;
    }
  }
  return fdir;
}

function accumulation(
  filled: Float32Array,
  fdir: Int8Array,
  width: number,
  height: number,
): Uint32Array {
  const acc = new Uint32Array(width * height);
  const order: number[] = [];
  for (let i = 0; i < width * height; i++) {
    if (fdir[i]! > 0 && isFiniteElev(filled[i]!)) order.push(i);
  }
  // Process upstream (higher elevation) before downstream so D8 acc
  // propagates correctly — the prior row+col lex sort under-counted.
  order.sort((a, b) => {
    const ea = filled[a]!;
    const eb = filled[b]!;
    if (eb !== ea) return eb - ea;
    const ca = a % width;
    const cb = b % width;
    return cb - ca;
  });
  for (const i of order) {
    acc[i] = (acc[i] ?? 0) + 1;
    const dir = fdir[i]!;
    if (dir <= 0) continue;
    const col = i % width;
    const row = Math.floor(i / width);
    const [dc, dr] = D8_OFFSETS[dir - 1]!;
    const ni = idx(col + dc, row + dr, width);
    acc[ni] = (acc[ni] ?? 0) + acc[i]!;
  }
  return acc;
}

function cellFromLngLat(
  lng: number,
  lat: number,
  width: number,
  height: number,
  bbox: BboxWgs84,
): [number, number] {
  const col = Math.round(
    ((lng - bbox.westLng) / (bbox.eastLng - bbox.westLng)) * (width - 1),
  );
  const row = Math.round(
    ((bbox.northLat - lat) / (bbox.northLat - bbox.southLat)) * (height - 1),
  );
  return [
    Math.max(0, Math.min(width - 1, col)),
    Math.max(0, Math.min(height - 1, row)),
  ];
}

function traceCatchment(
  pourCol: number,
  pourRow: number,
  fdir: Int8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let c = col;
      let r = row;
      for (let step = 0; step < width * height; step++) {
        if (c === pourCol && r === pourRow) {
          mask[idx(col, row, width)] = 1;
          break;
        }
        const dir = fdir[idx(c, r, width)]!;
        if (dir <= 0) break;
        const [dc, dr] = D8_OFFSETS[dir - 1]!;
        c += dc;
        r += dr;
        if (c < 0 || r < 0 || c >= width || r >= height) break;
      }
    }
  }
  return mask;
}

/**
 * Boolean mask → DISSOLVED, SMOOTH region polygons (2026-07-30 flood overlay
 * redesign). Replaces the old subsampled-lattice emitter, which walked the
 * mask at `step = min(w,h)/12` and pushed ONE INDEPENDENT AXIS-ALIGNED SQUARE
 * per sampled hit cell — the blue-checkerboard defect, and an area sum that
 * under-counted the true mask because only every step-th cell contributed.
 *
 * `maskArrayToDissolvedGeoJson` traces the FULL-RESOLUTION mask's cell-edge
 * boundary, dissolves contiguous cells into one polygon (with interior rings
 * for holes), simplifies at 0.5 cells and corner-smooths within 0.5 cells,
 * drops specks and caps the feature/vertex count. See maskRegions.ts for the
 * honesty tolerance and every documented cap.
 *
 * SPECK THRESHOLD, per layer. The DELINEATED CATCHMENT is one traced region
 * whose area is a HEADLINE STAT, and on a coarse drainage DEM a real parcel
 * catchment can legitimately be only a couple of cells — dropping it would
 * silently zero a reported number. So catchment/ponding tracing uses
 * {@link DELINEATED_SPECK_FLOOR_CELLS} (1 cell: keep anything the model
 * actually delineated) and lets the STUDY decide what is negligible, which it
 * already does explicitly via `NEGLIGIBLE_CATCHMENT_CELLS`. The library
 * default (4 cells) stays the right filter for noisy thresholded fields such
 * as the concentration bands.
 */
export const DELINEATED_SPECK_FLOOR_CELLS = 1;

function maskToGeoJson(
  mask: Uint8Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  properties: Record<string, unknown>,
): GeoJsonFeatureCollection {
  return maskArrayToDissolvedGeoJson(mask, width, height, bbox, properties, {
    minRegionAreaCells: DELINEATED_SPECK_FLOOR_CELLS,
  }) as GeoJsonFeatureCollection;
}

/**
 * THREE NESTED CONCENTRATION BANDS from the D8 accumulation raster.
 *
 * The old `deriveDrainageZones` graded each subsampled SQUARE by counting how
 * many traced flow-line vertices fell in its bbox. With dissolved regions
 * that counting is meaningless — a handful of large polygons absorb every
 * vertex, so every zone grades "high". Bands are therefore derived from the
 * MODEL ITSELF: the same D8 accumulation grid the flow lines are traced from,
 * thresholded at three levels INSIDE the catchment mask and each level traced
 * as its own dissolved region.
 *
 * The levels are quantiles of the accumulation values actually present inside
 * the catchment (not fixed magic numbers), so the bands adapt to the terrain
 * rather than asserting an absolute drainage-area scale the DEM may not
 * support:
 *
 *   concentration 0 (low)    — the whole catchment mask.
 *   concentration 1 (medium) — accumulation at or above the 70th percentile.
 *   concentration 2 (high)   — accumulation at or above the 90th percentile.
 *
 * Higher bands are strict subsets of lower ones by construction (a cell over
 * the 90th percentile is over the 70th), so the three bands NEST — which is
 * exactly what the redesign paints. Bands whose mask is empty are simply not
 * emitted; nothing is invented to fill a band.
 *
 * TOO SMALL TO BAND — AN EXPLICIT STATE, NOT A SILENT COLLAPSE (2026-07-30).
 * On the live Bastrop parcel 48021:36249 the delineated catchment was 3,223
 * sq ft — about 3 cells of a 10 m DEM. Percentile bands over three values are
 * meaningless, and the resulting single-cell band masks were then swallowed by
 * the library speck filter (4 cells), so the payload carried exactly one
 * feature with `concentration: 0` and the generic "modeled catchment extent"
 * basis. To a client painting three amber tones that is indistinguishable from
 * a rendering bug, and it silently hid the real finding, which is that the
 * catchment is too small to have internal structure at this resolution.
 *
 * So a catchment below {@link MIN_BANDABLE_CATCHMENT_CELLS} now short-circuits
 * to band 0 carrying a SELF-DESCRIBING basis
 * ({@link concentrationBasisTooSmall}) that names the cell count and says why
 * no banding was attempted. The client and the PDF surface that sentence
 * instead of implying a gradient the model cannot support.
 */
export const CONCENTRATION_BAND_QUANTILES: readonly [number, number] = [0.7, 0.9];

/**
 * Fewest catchment cells that can carry a meaningful 70th/90th-percentile
 * split. Below this the quantiles land on the same one or two values and any
 * "band" is a single cell of DEM noise, so the model reports the honest
 * too-small state instead. 12 cells leaves at least ~3 cells in the top decile
 * (12 * 0.1 rounded up, plus the speck floor of 4 for a traceable region).
 */
export const MIN_BANDABLE_CATCHMENT_CELLS = 12;

/** Self-describing basis for a catchment too small to band. */
export function concentrationBasisTooSmall(cells: number): string {
  return (
    `modeled catchment extent; too small to band at this resolution ` +
    `(${cells} DEM ${cells === 1 ? "cell" : "cells"}, under the ` +
    `${MIN_BANDABLE_CATCHMENT_CELLS}-cell minimum for a flow-concentration split)`
  );
}

/** Basis for a catchment whose accumulation field carries no usable gradient. */
export const CONCENTRATION_BASIS_NO_GRADIENT =
  "modeled catchment extent; flow accumulation is uniform across it, so no concentration gradient was modeled";

export function deriveConcentrationBands(
  catchmentMask: Uint8Array,
  accumulationGrid: Uint32Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  properties: Record<string, unknown> = {},
): GeoJsonFeatureCollection {
  const inside: number[] = [];
  for (let i = 0; i < catchmentMask.length; i++) {
    if (catchmentMask[i] === 1) inside.push(accumulationGrid[i] ?? 0);
  }
  const features: GeoJsonFeatureCollection["features"][number][] = [];
  if (inside.length === 0) return { type: "FeatureCollection", features };

  const emit = (mask: Uint8Array, concentration: 0 | 1 | 2, note: string): void => {
    const fc = maskArrayToDissolvedGeoJson(
      mask,
      width,
      height,
      bbox,
      {
        ...properties,
        zone: "drainage-concentration",
        concentration,
        concentrationBasis: note,
      },
      // EVERY band keeps whatever the model delineated. Band 0 is the
      // delineated catchment (a headline stat). Bands 1 and 2 were previously
      // left on the library speck floor (4 cells), which silently DELETED
      // genuine small bands and left the payload looking like band 0 alone —
      // half of the 2026-07-30 banding defect. The too-small-to-band guard
      // below is now what protects against noise, and it says so out loud.
      { minRegionAreaCells: DELINEATED_SPECK_FLOOR_CELLS },
    );
    features.push(...(fc.features as GeoJsonFeatureCollection["features"][number][]));
  };

  // TOO SMALL TO BAND — explicit, self-describing, never a silent collapse.
  if (inside.length < MIN_BANDABLE_CATCHMENT_CELLS) {
    emit(catchmentMask, 0, concentrationBasisTooSmall(inside.length));
    return { type: "FeatureCollection", features };
  }

  const sorted = [...inside].sort((a, b) => a - b);
  const quantile = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const levels: Array<[1 | 2, number]> = [
    [1, quantile(CONCENTRATION_BAND_QUANTILES[0])],
    [2, quantile(CONCENTRATION_BAND_QUANTILES[1])],
  ];

  // Build the higher bands FIRST so band 0 can carry an honest basis: if no
  // gradient survives, band 0 must say the field is uniform rather than imply
  // a split that was never emitted.
  const higher: Array<{ band: Uint8Array; concentration: 1 | 2; note: string }> = [];
  const seen = new Set<number>();
  for (const [concentration, cutoff] of levels) {
    // A degenerate accumulation field can put two quantiles on the same
    // value; emitting the identical ring twice would fake a band. Skip.
    if (cutoff <= 0 || seen.has(cutoff)) continue;
    seen.add(cutoff);
    const band = new Uint8Array(width * height);
    let cells = 0;
    for (let i = 0; i < band.length; i++) {
      if (catchmentMask[i] !== 1) continue;
      if ((accumulationGrid[i] ?? 0) >= cutoff) {
        band[i] = 1;
        cells++;
      }
    }
    // A band identical to the catchment (a flat accumulation field puts every
    // cell over the cutoff) is not a CONCENTRATION — painting it as one would
    // assert a gradient the model does not show. Emit nothing for that band.
    if (cells === 0 || cells === inside.length) continue;
    higher.push({
      band,
      concentration,
      note: `D8 flow accumulation at or above ${cutoff} upstream cells`,
    });
  }

  emit(
    catchmentMask,
    0,
    higher.length > 0 ? "modeled catchment extent" : CONCENTRATION_BASIS_NO_GRADIENT,
  );
  for (const { band, concentration, note } of higher) {
    emit(band, concentration, note);
  }
  return { type: "FeatureCollection", features };
}

function flowLinesFromAccumulation(
  acc: Uint32Array,
  fdir: Int8Array,
  width: number,
  height: number,
  bbox: BboxWgs84,
  threshold: number,
): GeoJsonFeatureCollection {
  const features: GeoJsonFeatureCollection["features"][number][] = [];
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = idx(col, row, width);
      if (acc[i]! < threshold) continue;
      const line: [number, number][] = [];
      let c = col;
      let r = row;
      for (let step = 0; step < width + height; step++) {
        line.push(lngLatForCell(c, r, width, height, bbox));
        const dir = fdir[idx(c, r, width)]!;
        if (dir <= 0) break;
        const [dc, dr] = D8_OFFSETS[dir - 1]!;
        c += dc;
        r += dr;
        if (c < 0 || r < 0 || c >= width || r >= height) break;
      }
      if (line.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: line },
          properties: { accumulation: acc[i] },
        });
      }
    }
  }
  return { type: "FeatureCollection", features: features.slice(0, 40) };
}

export interface D8Field {
  /** Depression-filled elevation grid (same shape as the input DEM). */
  filled: Float32Array;
  /** D8 flow direction per cell (0 = no downslope neighbor). */
  fdir: Int8Array;
  /** D8 flow accumulation per cell, in CELLS of upstream flow. */
  accumulation: Uint32Array;
}

/**
 * Compute the raw D8 field (filled DEM, flow directions, accumulation) on an
 * in-memory elevation grid WITHOUT tracing catchments or emitting GeoJSON.
 * Exposed for consumers that need the accumulation raster itself — the
 * flood-drainage parcel-aware pour point and the water-gradient raster both
 * read this field directly. Deterministic; same math as `runHydrologyNative`.
 */
export function computeD8Field(
  elevation: Float32Array,
  width: number,
  height: number,
): D8Field {
  const filled = fillDepressions(elevation, width, height);
  const fdir = flowDirection(filled, width, height);
  const acc = accumulation(filled, fdir, width, height);
  return { filled, fdir, accumulation: acc };
}

/** Run D8 hydrology on an in-memory elevation grid. */
export function runHydrologyNative(
  input: HydrologyNativeInput,
): HydrologyNativeResult {
  const { width, height, elevation, catchmentBbox } = input;
  const threshold =
    input.accumulationThreshold ?? ACCUMULATION_THRESHOLD_BASE_CELLS;

  let minElev = Infinity;
  let maxElev = -Infinity;
  let finiteCount = 0;
  for (let i = 0; i < elevation.length; i++) {
    const z = elevation[i]!;
    if (!isFiniteElev(z)) continue;
    finiteCount++;
    if (z < minElev) minElev = z;
    if (z > maxElev) maxElev = z;
  }
  if (finiteCount === 0) {
    return {
      status: "error",
      code: "nodata-dem",
      message: "DEM contains no finite elevation cells",
      library: "native-d8",
      libraryVersion: "1.0.0",
      routing: "d8",
      accumulationThreshold: threshold,
      drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
      flowLinesGeoJson: { type: "FeatureCollection", features: [] },
      rainfallResultGeoJson: null,
      pourPoint: { lng: input.pourLng, lat: input.pourLat },
    };
  }
  if (maxElev - minElev < 0.05) {
    return {
      status: "error",
      code: "flat-terrain",
      message:
        "Native D8 fallback cannot route on flat terrain; pysheds worker required",
      library: "native-d8",
      libraryVersion: "1.0.0",
      routing: "d8",
      accumulationThreshold: threshold,
      drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
      flowLinesGeoJson: { type: "FeatureCollection", features: [] },
      rainfallResultGeoJson: null,
      pourPoint: { lng: input.pourLng, lat: input.pourLat },
    };
  }

  const filled = fillDepressions(elevation, width, height);
  const fdir = flowDirection(filled, width, height);
  const acc = accumulation(filled, fdir, width, height);
  const [pourCol, pourRow] = cellFromLngLat(
    input.pourLng,
    input.pourLat,
    width,
    height,
    catchmentBbox,
  );
  const catchMask = traceCatchment(pourCol, pourRow, fdir, width, height);
  const drainageZonesGeoJson = maskToGeoJson(
    catchMask,
    width,
    height,
    catchmentBbox,
    { zone: "catchment", library: "native-d8" },
  );
  const concentrationBandsGeoJson = deriveConcentrationBands(
    catchMask,
    acc,
    width,
    height,
    catchmentBbox,
    { library: "native-d8" },
  );
  const flowLinesGeoJson = flowLinesFromAccumulation(
    acc,
    fdir,
    width,
    height,
    catchmentBbox,
    threshold,
  );

  let rainfallResultGeoJson: GeoJsonFeatureCollection | null = null;
  const rainfallMm = input.rainfallDepthMm ?? 0;
  if (rainfallMm > 0) {
    const rainfallM = rainfallMm / 1000;
    // PONDING = DEPRESSION STORAGE (see `pondingDepthMeters`): a cell ponds
    // only where depression-filling had to RAISE it — an actual sink — and the
    // trapped water clears MIN_PONDING_DEPTH_METERS. Cells on a slope have
    // filled == raw and never pond, however hard it rains.
    const pondMask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      if (isCellPonded(filled[i]!, elevation[i]!, rainfallM)) pondMask[i] = 1;
    }
    rainfallResultGeoJson = maskToGeoJson(
      pondMask,
      width,
      height,
      catchmentBbox,
      {
        rainfallDepthMm: rainfallMm,
        library: "native-d8",
        pondingBasis: PONDING_BASIS_NOTE,
        minPondingDepthMeters: MIN_PONDING_DEPTH_METERS,
      },
    );
  }

  return {
    status: "ok",
    library: "native-d8",
    libraryVersion: "1.0.0",
    routing: "d8",
    accumulationThreshold: threshold,
    drainageZonesGeoJson,
    concentrationBandsGeoJson,
    flowLinesGeoJson,
    rainfallResultGeoJson,
    pourPoint: { lng: input.pourLng, lat: input.pourLat },
  };
}
