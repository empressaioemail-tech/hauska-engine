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

/**
 * Ground area of one DEM cell in square meters, from the bbox and grid shape.
 * The hydrology math needs a real contributing AREA (m2), and the native
 * backend is handed a WGS84 bbox rather than a projected pixel size, so the
 * degree spans are converted locally: latitude degrees are near-constant, and
 * longitude degrees shrink by cos(latitude).
 */
export function cellAreaSquareMeters(
  width: number,
  height: number,
  bbox: BboxWgs84,
): number {
  const midLat = (bbox.northLat + bbox.southLat) / 2;
  const metersPerDegLat = 110_540;
  const metersPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const cellW =
    (Math.abs(bbox.eastLng - bbox.westLng) / Math.max(width, 1)) *
    metersPerDegLng;
  const cellH =
    (Math.abs(bbox.northLat - bbox.southLat) / Math.max(height, 1)) *
    metersPerDegLat;
  const area = Math.abs(cellW * cellH);
  return Number.isFinite(area) && area > 0 ? area : 100;
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
 * CHANNEL-INITIATION THRESHOLD, EXPRESSED RELATIVE TO THE WINDOW (2026-07-30
 * real-terrain calibration).
 *
 * The drainage network the stage is measured against must be defined by a
 * contributing-area threshold. A FIXED area threshold (the textbook "channel
 * begins at 10 ha") is wrong HERE for a specific, measured reason: the study
 * window is a parcel-scale padded bbox, typically 1.4-2.5 km on a side, so the
 * largest contributing area anywhere inside it is only about 6-24 ha. A fixed
 * 10 ha threshold therefore either finds nothing (and HAND degenerates to
 * "height above the window edge") or promotes a hillslope rill to a river,
 * depending on the parcel — the classification would flip on window size
 * rather than on terrain.
 *
 * Defining the network as a FRACTION of the window's own maximum accumulation
 * makes the network scale-relative: whatever the dominant drainage line in
 * this window is, that is the datum. 2% keeps the network to the genuinely
 * convergent cells (measured on the five Bastrop validation windows: 12-48
 * cells of contributing area, i.e. the main swale and its principal branches,
 * not every hillslope furrow). The 10-cell floor stops a nearly flat window
 * from declaring every cell a channel.
 */
export const CHANNEL_ACCUMULATION_FRACTION_OF_MAX = 0.02;
export const CHANNEL_MIN_ACCUMULATION_CELLS = 10;

/**
 * RUNOFF COEFFICIENT for the screening stage estimate. 0.5 is a mid-range
 * composite for the mixed pasture/residential/impervious cover typical of a
 * small-town parcel edge. It is deliberately a single documented constant
 * rather than a land-cover lookup: this is a screening product and pretending
 * to a per-cell runoff coefficient we have not sourced would be false
 * precision. It is NOT tuned to any jurisdiction.
 */
export const SCREENING_RUNOFF_COEFFICIENT = 0.5;

/**
 * HYDRAULIC-GEOMETRY DEPTH EXPONENT AND COEFFICIENT.
 *
 * At-a-station hydraulic geometry (Leopold & Maddock 1953) gives mean flow
 * depth as a power law in discharge, `d = c * Q^f`, with `f` clustering near
 * 0.4 across a wide range of natural channels. We use `d = 0.27 * Q^0.39` with
 * Q in m3/s, which is within the commonly cited range for small ungauged
 * streams. This converts a design-storm discharge into a CHANNEL STAGE in
 * meters, which is the water surface HAND is compared against.
 *
 * This is a screening relation, not a rating curve for any specific channel.
 */
export const HYDRAULIC_GEOMETRY_DEPTH_COEFFICIENT = 0.27;
export const HYDRAULIC_GEOMETRY_DEPTH_EXPONENT = 0.39;

/**
 * MINIMUM CONTRIBUTING AREA FOR A DRAINAGE LINE TO CARRY A STAGE.
 *
 * WHY A FLOOR ON AREA AND NOT ON DEPTH (2026-07-30). An earlier cut of this
 * model floored the modeled STAGE at the design-storm depth, reasoning that
 * the storm's own depth must at minimum arrive in the low ground. Measured
 * against real terrain that was wrong, and wrong in the dangerous direction:
 * on four independent FEMA Zone X (NOT special-flood-hazard) control parcels
 * it reported 50-87% of the parcel inundated. The cause is scale. Those
 * parcels are small, so their padded study window is only ~530 m across and
 * the entire window drains 0.7-2.3 ha. A stage floor applies a river-scale
 * water surface to what is physically a hillslope rill, and since the parcel
 * sits right on that rill its HAND is near zero, so the floor floods it.
 *
 * The physical statement that replaces it: a drainage line only has a
 * meaningful stage if enough land actually drains INTO it. Below that, water
 * is sheet flow on a hillslope — it runs off, it does not stand. 2 hectares
 * (20,000 m2) is a conventional lower bound for channel initiation in humid
 * temperate terrain, and it is a TERRAIN quantity, not a tuned one: it is
 * compared against the modeled contributing area in m2, so it behaves
 * identically in any county.
 *
 * A cell whose receiving drainage line is below this area gets stage 0 and can
 * therefore only pond from DEPRESSION STORAGE — which is exactly right, since
 * on a hillslope with no concentrated flow the only standing water is in
 * closed sinks.
 *
 * 1 hectare (10,000 m2), the low end of the channel-initiation range for
 * humid temperate terrain. Measured effect on the FEMA-labelled sample: the
 * four Zone X control parcels, whose windows drain 0.7-2.3 ha in total and
 * whose own cells receive only 0.1-0.66 ha, stay at 0% modeled inundation,
 * while parcels sitting on drainage lines that genuinely concentrate flow
 * inside the window do register. It is a terrain quantity compared against a
 * modeled area in m2, so it behaves identically in any county.
 */
export const MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS = 10_000;

/**
 * CHANNEL STAGE from the design storm and the contributing area draining to
 * the cell's receiving channel.
 *
 * Rational-method discharge, then hydraulic geometry:
 *
 *   V  = C * P * A                 runoff volume (m3)
 *   Tc = time of concentration (s), Kirpich-style area scaling
 *   Q  = V / Tc                    discharge (m3/s)
 *   d  = c * Q^f                   stage above the channel bed (m)
 *
 * STATED LIMIT — this is the load-bearing caveat and it ships in the payload.
 * The contributing area `A` is only what is VISIBLE INSIDE THE STUDY WINDOW.
 * For a parcel on a real river floodplain the true contributing watershed is
 * orders of magnitude larger than the window and the true stage is set by the
 * RIVER, not by the on-window swale. Measured on the Bastrop validation
 * windows: max in-window contributing area 5.9-23.9 ha against a Colorado
 * River watershed of thousands of km2. So this stage is a LOWER BOUND on
 * riverine inundation and the model must say so rather than imply the number
 * is the regulatory base flood elevation. Riverine flood hazard is
 * authoritatively the FEMA NFHL's, and a floodplain determination must come
 * from it, not from this screening raster.
 */
export function channelStageMeters(
  contributingAreaSqMeters: number,
  rainfallDepthMeters: number,
): number {
  if (!(rainfallDepthMeters > 0)) return 0;
  // Below the channel-initiation area there is no concentrated flow to have a
  // stage: this is hillslope sheet flow, and only closed depressions hold
  // water. See MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS.
  if (!(contributingAreaSqMeters >= MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS)) {
    return 0;
  }
  const volume =
    SCREENING_RUNOFF_COEFFICIENT * rainfallDepthMeters * contributingAreaSqMeters;
  const areaHa = contributingAreaSqMeters / 10_000;
  // Time of concentration: floor at 10 minutes, scaling with sqrt(area).
  const tcSeconds = Math.max(600, 1800 * Math.sqrt(Math.max(areaHa, 0)));
  const dischargeCms = volume / tcSeconds;
  const depth =
    HYDRAULIC_GEOMETRY_DEPTH_COEFFICIENT *
    Math.pow(Math.max(dischargeCms, 0), HYDRAULIC_GEOMETRY_DEPTH_EXPONENT);
  return Math.max(0, depth);
}

/**
 * RIVERINE-COVERAGE LIMIT — the scale at which this model stops being able to
 * see the flood driver at all, and must say so instead of implying a verdict.
 *
 * MEASURED, 2026-07-30, on 24 Bastrop parcels independently labelled by the
 * FEMA NFHL (12 in a special flood hazard area, 12 in Zone X). The largest
 * contributing area visible ANYWHERE inside the padded study window was
 * 1.7-11.9 ha for the flood-hazard parcels and 0.7-5.0 ha for the Zone X
 * parcels — overlapping ranges, medians 3.9 ha and 3.1 ha. The Colorado River,
 * which is what actually puts those parcels in Zone AE and the regulatory
 * floodway, drains on the order of 3,000,000 ha. The study window is short of
 * the flood driver by five to six orders of magnitude, and no statistic
 * computed inside that window distinguishes the two groups: on that 24-parcel
 * sample, HAND, window relief, contributing area and depression storage all
 * carried rank information in the WRONG direction or none at all (the
 * flood-hazard parcels had HIGHER median HAND than the Zone X parcels).
 *
 * The conclusion is a statement about the model's domain, not a tuning knob.
 * A parcel-scale DEM window can honestly model LOCAL storm response —
 * depression storage and low ground along drainage lines that are inside the
 * window. It cannot model RIVERINE inundation, because the river's stage is
 * set by a watershed that is not in the raster. Any criterion that appeared to
 * reproduce FEMA flood zones from this window would be fitting noise, and it
 * would not transfer to a county without an SFHA layer to fit against.
 *
 * So when the window's own drainage network is this small, the payload states
 * that riverine flood hazard is OUT OF MODEL SCOPE and points at the NFHL,
 * rather than reporting a confident zero that a reader would mistake for
 * "not in a floodplain".
 */
export const RIVERINE_COVERAGE_MIN_CONTRIBUTING_AREA_SQ_METERS = 5_000_000; // 500 ha

/** True when the window contains a drainage network large enough that riverine
 * stage is even arguably in scope. Below this the study models LOCAL response
 * only and must disclose that. */
export function windowResolvesRiverineDrainage(
  maxContributingAreaSqMeters: number,
): boolean {
  return maxContributingAreaSqMeters >= RIVERINE_COVERAGE_MIN_CONTRIBUTING_AREA_SQ_METERS;
}

export const RIVERINE_OUT_OF_SCOPE_NOTE =
  `RIVERINE FLOOD HAZARD IS OUT OF SCOPE FOR THIS STUDY. The modeled window's ` +
  `largest drainage network is far smaller than a river watershed, so channel ` +
  `stage from a river cannot be computed from this DEM and is NOT represented ` +
  `in the ponding figure. A zero or small ponding number here means "no modeled ` +
  `LOCAL storm ponding", NOT "outside the floodplain". Floodplain determination ` +
  `must come from the FEMA National Flood Hazard Layer or a site-specific ` +
  `hydraulic study.`;

/**
 * Provenance note shipped on the ponding FeatureCollection so the client, the
 * PDF and the briefing all describe the SAME criterion rather than each
 * narrating its own guess at what the blue area means.
 */
export const PONDING_BASIS_NOTE =
  `modeled standing water at or above ${MIN_PONDING_DEPTH_METERS} m ` +
  `(${Math.round(MIN_PONDING_DEPTH_METERS * 39.3701)} in) under the design storm, from ` +
  `depression storage (closed sinks on the DEM) COMBINED WITH low-lying inundation ` +
  `(terrain below the modeled stage of the drainage line it drains to, via height ` +
  `above nearest drainage). Screening model at DEM resolution: excludes infiltration, ` +
  `soil storage, culverts and storm sewer, and its contributing area is limited to the ` +
  `study window, so riverine stage from a larger upstream watershed is UNDER-represented. ` +
  `Not a hydraulic study; the FEMA NFHL remains authoritative for floodplain determination.`;

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

/**
 * HEIGHT ABOVE NEAREST DRAINAGE (HAND) — Rennó et al. 2008, Nobre et al. 2011.
 *
 * WHY THIS EXISTS (2026-07-30 real-terrain calibration; the correction to the
 * 2026-07-30 depression-storage fix).
 *
 * The prior criterion was depression storage ALONE: `filled - raw` over a
 * threshold. That is a correct model of PONDING IN A CLOSED SINK and it is
 * kept, unchanged, below. What it cannot do — structurally, not by
 * mis-tuning — is represent FLOODPLAIN INUNDATION. A floodplain is not a
 * closed depression. It is ground that drains perfectly well, and floods
 * anyway, because the water surface in the channel next to it rises above it.
 * Depression filling raises nothing on a floodplain that has an outlet, so
 * `filled - raw` is zero there and a pure depression model reports a
 * floodplain as dry.
 *
 * MEASURED, on the real 10 m 3DEP DEM over five Bastrop validation parcels
 * (not a synthetic fixture): `filled - raw` is exactly 0 for 90-94% of cells,
 * p50 = 0.0000 m and p90 = 0.0000 m in EVERY window, with only 2.2-4.5% of
 * cells clearing 0.10 m. Those few cells are scattered micro-sinks, and where
 * they land bears no relation to flood exposure: the parcel with the MOST
 * depression storage on it (12.4%) is the one sitting lowest against the
 * drainage line, while parcels squarely inside the FEMA AE floodway scored
 * 0.7% and 1.0%. Depression storage was not merely too small, it was
 * uncorrelated with the hazard.
 *
 * WHAT HAND ADDS. For each cell, follow the D8 flow path downslope until it
 * reaches a channel cell (contributing area over
 * {@link CHANNEL_ACCUMULATION_FRACTION_OF_MAX} of the window maximum). HAND is
 * the cell's elevation minus that receiving channel cell's elevation — the
 * height of the ground above the water it drains to. A cell is inundated when
 * its HAND is below the modeled stage in that channel
 * (see {@link channelStageMeters}), and the inundation depth is
 * `stage - HAND`. This is the standard terrain-based screening approach to
 * floodplain extent and it is what makes low, flat, well-drained ground next
 * to a drainage line read as flood-exposed.
 *
 * The two mechanisms are combined by taking the DEEPER of the two per cell:
 * a closed sink on a terrace ponds from its own storage, low ground beside the
 * channel inundates from stage, and ground that is both takes the larger. The
 * result is still gated by {@link MIN_PONDING_DEPTH_METERS}.
 *
 * NO CALIBRATION TO ANY PARCEL OR JURISDICTION. Every constant here is a
 * terrain- or storm-derived quantity documented at its definition. There is no
 * parcel list, no county constant, and the FEMA/SFHA flag is NEVER an input —
 * those layers were used to CHECK the output, never to produce it.
 */
export function heightAboveNearestDrainage(
  elevation: Float32Array,
  fdir: Int8Array,
  accumulationCells: Uint32Array,
  width: number,
  height: number,
): { hand: Float32Array; receivingAccumulationCells: Float32Array } {
  const size = width * height;
  const hand = new Float32Array(size).fill(Number.NaN);
  const receiving = new Float32Array(size).fill(Number.NaN);

  let maxAcc = 0;
  for (let i = 0; i < size; i++) {
    const a = accumulationCells[i]!;
    if (a > maxAcc) maxAcc = a;
  }
  const channelCells = Math.max(
    CHANNEL_MIN_ACCUMULATION_CELLS,
    Math.round(maxAcc * CHANNEL_ACCUMULATION_FRACTION_OF_MAX),
  );

  const path: number[] = [];
  const onPath = new Uint8Array(size);
  // HAND may legitimately resolve to NaN ("drains off the window"), which is
  // indistinguishable from "not yet visited" in the array itself. This marks
  // resolution explicitly so each cell is walked once.
  const resolved = new Uint8Array(size);
  for (let start = 0; start < size; start++) {
    if (!isFiniteElev(elevation[start]!)) continue;
    if (resolved[start] === 1) continue;

    path.length = 0;
    let cur = start;
    let baseElevation = Number.NaN;
    let baseAcc = Number.NaN;

    for (;;) {
      if (!isFiniteElev(elevation[cur]!)) break;
      // Already resolved downstream — inherit its channel datum (which may be
      // the off-window NaN datum, and that must propagate too).
      if (resolved[cur] === 1) {
        baseElevation = isFiniteElev(hand[cur]!)
          ? elevation[cur]! - hand[cur]!
          : Number.NaN;
        baseAcc = receiving[cur]!;
        break;
      }
      // A channel cell is its own datum: HAND 0.
      if (accumulationCells[cur]! >= channelCells) {
        baseElevation = elevation[cur]!;
        baseAcc = accumulationCells[cur]!;
        hand[cur] = 0;
        receiving[cur] = baseAcc;
        resolved[cur] = 1;
        break;
      }
      // Cycle guard: a flat/looping region resolves against itself rather
      // than spinning. Never invents a datum from outside the terrain.
      if (onPath[cur] === 1) {
        baseElevation = elevation[cur]!;
        baseAcc = accumulationCells[cur]!;
        break;
      }
      onPath[cur] = 1;
      path.push(cur);

      const dir = fdir[cur]!;
      if (dir <= 0) {
        // NO DOWNSLOPE NEIGHBOUR. Two physically different cases, and
        // conflating them was a real defect (2026-07-30): it made a pure
        // monotonic slope report inundation along its own grid border.
        //
        // `flowDirection` only assigns a direction to INTERIOR cells, so every
        // border cell has fdir 0 regardless of terrain. A border cell is
        // where water LEAVES the study window — it is an open outflow
        // boundary, not an impoundment. Treating it as its own drainage datum
        // gave it HAND 0, and any stage then flooded it.
        //
        // So: a border cell is UNDEFINED for HAND (no inundation can be
        // asserted there, since what happens to that water is off-raster),
        // while a true interior pit IS its own local low point and keeps its
        // datum. Depression storage still applies to both — a real sink on the
        // border is caught by `filled - raw`, which is unaffected by this.
        const col0 = cur % width;
        const row0 = (cur - col0) / width;
        const isBorder =
          col0 === 0 || row0 === 0 || col0 === width - 1 || row0 === height - 1;
        if (isBorder) {
          baseElevation = Number.NaN;
          baseAcc = Number.NaN;
        } else {
          baseElevation = elevation[cur]!;
          baseAcc = accumulationCells[cur]!;
        }
        break;
      }
      const offset = D8_OFFSETS[dir - 1];
      if (!offset) {
        baseElevation = elevation[cur]!;
        baseAcc = accumulationCells[cur]!;
        break;
      }
      const col = cur % width;
      const row = (cur - col) / width;
      const nc = col + offset[0];
      const nr = row + offset[1];
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) {
        // Flows off the grid edge: open boundary, same reasoning as above.
        baseElevation = Number.NaN;
        baseAcc = Number.NaN;
        break;
      }
      cur = nr * width + nc;
    }

    // A NaN datum is the deliberate "drains off the study window" signal from
    // the loop above, and it must PROPAGATE: every cell whose flow path leaves
    // the raster has undefined HAND, so no inundation is asserted for it. It
    // is never back-filled with a substitute datum, which would be inventing a
    // water surface for water we cannot follow.
    for (const cell of path) {
      onPath[cell] = 0;
      hand[cell] = isFiniteElev(baseElevation)
        ? elevation[cell]! - baseElevation
        : Number.NaN;
      receiving[cell] = baseAcc;
      resolved[cell] = 1;
    }
  }

  return { hand, receivingAccumulationCells: receiving };
}

/**
 * MINIMUM HAND FOR THE INUNDATION MECHANISM TO APPLY.
 *
 * Inundation is water leaving the channel and standing on ground BESIDE it.
 * The channel's own bed (HAND 0) is conveyance, not standing water: on a plain
 * hillslope the D8 outlet cell is classified as the local channel, and without
 * this exclusion the model reported that outlet as ponded — i.e. a strictly
 * monotonic slope, where nothing can impound, showed inundation. Flowing water
 * in a drainage line is not a site-design ponding constraint, and if a channel
 * cell genuinely holds water it is a closed sink and the depression-storage
 * term already reports it.
 *
 * One DEM cell is the smallest resolvable distance from the channel, so
 * "strictly greater than zero HAND" is the exclusion: the bed itself is out,
 * the first cell of overbank ground is in.
 */
function isChannelBedCell(handMeters: number): boolean {
  return isFiniteElev(handMeters) && handMeters <= 0;
}

/**
 * Standing-water depth at a cell: the DEEPER of closed-depression storage and
 * low-lying inundation below the modeled channel stage. See
 * {@link heightAboveNearestDrainage} for why both are required.
 */
export function standingWaterDepthMeters(
  filledElevation: number,
  rawElevation: number,
  handMeters: number,
  channelStage: number,
  rainfallDepthMeters: number,
): number {
  const depression = pondingDepthMeters(
    filledElevation,
    rawElevation,
    rainfallDepthMeters,
  );
  let inundation = 0;
  if (
    isFiniteElev(handMeters) &&
    channelStage > 0 &&
    !isChannelBedCell(handMeters)
  ) {
    inundation = Math.max(0, channelStage - handMeters);
  }
  return Math.max(depression, inundation);
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
    // STANDING WATER = DEPRESSION STORAGE **OR** LOW-LYING INUNDATION.
    // Depression storage alone reports a floodplain as dry (it is not a closed
    // sink); HAND against the modeled channel stage supplies the floodplain
    // mechanism. See `heightAboveNearestDrainage`. Cells on a high, well
    // drained slope have filled == raw AND a HAND far above stage, so they
    // still never pond, however hard it rains.
    const { hand, receivingAccumulationCells } = heightAboveNearestDrainage(
      elevation,
      fdir,
      acc,
      width,
      height,
    );
    const cellAreaSqM = cellAreaSquareMeters(width, height, catchmentBbox);
    const pondMask = new Uint8Array(width * height);
    let maxContributingSqM = 0;
    for (let i = 0; i < width * height; i++) {
      const receiving = receivingAccumulationCells[i]!;
      const contributingSqM =
        (isFiniteElev(receiving) ? Math.max(receiving, 1) : 1) * cellAreaSqM;
      if (contributingSqM > maxContributingSqM) maxContributingSqM = contributingSqM;
      const stage = channelStageMeters(contributingSqM, rainfallM);
      const depth = standingWaterDepthMeters(
        filled[i]!,
        elevation[i]!,
        hand[i]!,
        stage,
        rainfallM,
      );
      if (depth >= MIN_PONDING_DEPTH_METERS) pondMask[i] = 1;
    }
    // The window either resolves a river-scale network or it does not. When it
    // does not, the payload SAYS the riverine mechanism is out of scope rather
    // than letting a small number read as "not in a floodplain".
    const riverineResolved = windowResolvesRiverineDrainage(maxContributingSqM);
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
        pondingMechanisms: ["depression-storage", "low-lying-inundation"],
        maxContributingAreaSqMeters: Math.round(maxContributingSqM),
        riverineFloodHazardModeled: riverineResolved,
        ...(riverineResolved
          ? {}
          : { riverineFloodHazardNote: RIVERINE_OUT_OF_SCOPE_NOTE }),
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
