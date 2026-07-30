import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import {
  accumulationThresholdForResolution,
  computeD8Field,
  fetchNoaaAtlas14PointEstimate,
  inchesToMm,
  runHydrologyWorker,
  type GeoJsonFeatureCollection,
  type HydrologyWorkerRequest,
  type HydrologyWorkerResult,
  type NoaaAtlas14PointEstimate,
} from "@hauska-engine/adapters/hydrology";

import polygonClipping from "polygon-clipping";

import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import type { ParcelGeometryResolver } from "../parcel-terrain/author.js";
import { buildDrainageGradient, type FloodDrainageGradient } from "./drainage-gradient.js";
import {
  buildFloodFlowPaths,
  type FloodCatchmentSwath,
  type FloodFlowPath,
} from "./flood-flow-paths.js";

/**
 * FLOOD & DRAINAGE study service (2026-07-29, R3 — the first PAID report).
 *
 * Parcel-scoped drainage study: resolves the parcel ring, fetches a PADDED
 * catchment DEM at a drainage-calibrated resolution, and runs the EXISTING
 * hydrology computation (pysheds worker / native D8 fallback) — catchment,
 * drainage zones, rainfall ponding, flow lines. This module produces the
 * study payload the PDF assembler renders and the PE dock visualizes; it
 * never computes geometry twice and never fabricates a result.
 *
 * DEM RESOLUTION (hydrology-resolution-floor, the mold's PART 3 lesson):
 * the drainage default is 10 m/px — the resolution the long-standing D8
 * accumulation threshold (50 cells) was calibrated against — NOT the 1 m
 * terrain default. A 1 m DEM over a catchment-scale extent explodes flow
 * seeding ~100x for no screening-level gain. Explicit finer requests are
 * clamped at {@link MIN_DRAINAGE_RESOLUTION_METERS}; the accumulation
 * threshold rescales with the resolution actually used
 * (`accumulationThresholdForResolution`) so channel density stays
 * resolution-invariant either way.
 *
 * RAINFALL FORCING (LOCK decision, implemented as): `rainfallDepthInches`
 * is a PARAMETER first. When omitted, the in-repo NOAA Atlas 14 PFDS
 * client (`fetchNoaaAtlas14PointEstimate`) is tried for the 100-yr 24-hr
 * point depth at the parcel centroid; when that fetch fails or carries no
 * 100-yr row, the study falls back to {@link DEFAULT_RAINFALL_DEPTH_INCHES}
 * and says so — `rainfallSource` records "parameter" | "noaa-atlas14" |
 * "default" honestly, never a silently invented number.
 */

// ─────────────────────────────────────────────────────────────────────────
// Constants (each carries its provenance).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Default drainage DEM resolution: 10 m/px — the calibration reference of
 * the D8 accumulation threshold (`ACCUMULATION_THRESHOLD_REFERENCE_
 * RESOLUTION_METERS`, the historical 3DEP 1/3 arc-second tier). Screening-
 * level drainage delineation, not terrain-contour fidelity.
 */
export const DEFAULT_DRAINAGE_RESOLUTION_METERS = 10;

/**
 * Hard floor for explicit resolution requests (hydrology-resolution-floor):
 * the study never feeds the D8/pysheds worker a DEM finer than 3 m/px, no
 * matter what the caller asks for. 1 m stays a terrain-export resolution.
 */
export const MIN_DRAINAGE_RESOLUTION_METERS = 3;

/**
 * Documented fallback design-storm depth when no parameter is supplied and
 * the live NOAA fetch fails: 9.5 inches ≈ the 100-year 24-hour point
 * precipitation for the Bastrop / Central Texas area per NOAA Atlas 14,
 * Volume 11 Version 2.0 (Texas; Perica et al., 2018 — PFDS point estimates
 * for Bastrop County run ~9–10 in for the 100-yr 24-hr event). Used ONLY
 * with `rainfallSource: "default"` and surfaced on the sheet as a
 * documented regional default, never presented as a live estimate.
 */
export const DEFAULT_RAINFALL_DEPTH_INCHES = 9.5;

export const DEFAULT_RAINFALL_CITATION =
  "NOAA Atlas 14 Volume 11 (Texas), 100-yr 24-hr regional default";

/** Design-storm return period for the study (100-yr, 24-hr). */
export const DESIGN_STORM_RETURN_PERIOD_YEARS = 100;

/**
 * Catchment padding: the DEM bbox extends the parcel bbox by
 * `CATCHMENT_PAD_FACTOR × max(parcel span)` on every side, clamped to
 * [{@link CATCHMENT_PAD_MIN_METERS}, {@link CATCHMENT_PAD_MAX_METERS}] so a
 * tiny lot still sees its upstream watershed and a ranch parcel does not
 * request a county-sized raster.
 */
export const CATCHMENT_PAD_FACTOR = 2.5;
export const CATCHMENT_PAD_MIN_METERS = 250;
export const CATCHMENT_PAD_MAX_METERS = 1500;

const METERS_PER_DEG_LAT = 110_574;
const SQFT_PER_SQM = 10.7639;

// ─────────────────────────────────────────────────────────────────────────
// Study payload (the PINNED route contract's `study` object).
// ─────────────────────────────────────────────────────────────────────────

export type RainfallSource = "noaa-atlas14" | "parameter" | "default";

export interface FloodDrainageDemProvenance {
  source: string;
  resolutionMeters: number;
}

export interface FloodDrainageFlowExit {
  /** WGS84 exit point (first traced vertex outside the parcel ring). */
  lng: number;
  lat: number;
  /** Outbound bearing (degrees clockwise from north) at the crossing. */
  bearingDeg: number;
}

export interface FloodDrainageStudyStats {
  /** Modeled upstream catchment area (mask-cell sum), square feet. */
  catchmentAreaSqFt: number;
  /**
   * Modeled ponded area CLIPPED TO THE PARCEL RING, square feet — the
   * headline number ("how much water pools HERE"). 0 is a valid, honest
   * value (rainfall was modeled; none of it intersects the parcel); null
   * means the rainfall result was not computed at all. The 2026-07-29
   * canary defect was summing the whole modeled DEM region into this stat
   * (3.4M sq ft on a 0.19-acre parcel) — that wider figure now lives in
   * {@link pondedAreaModeledRegionSqFt} as labeled context only.
   */
  pondedAreaSqFt: number | null;
  /** Total modeled ponding across the WHOLE padded catchment region,
   * square feet (context qualifier, never the headline); null when the
   * rainfall result was not computed. */
  pondedAreaModeledRegionSqFt: number | null;
  flowExitCount: number;
  pourPoint: { lng: number; lat: number };
  /** How the parcel-aware pour point was resolved (disclosed, never guessed). */
  pourPointMethod: PourPointMethod;
}

export interface FloodDrainageStudy {
  parcelNodeId: string;
  catchmentGeoJson: GeoJsonFeatureCollection;
  drainageZonesGeoJson: GeoJsonFeatureCollection;
  rainfallResultGeoJson: GeoJsonFeatureCollection | null;
  flowLinesGeoJson: GeoJsonFeatureCollection;
  rainfallDepthInches: number;
  rainfallSource: RainfallSource;
  demProvenance: FloodDrainageDemProvenance;
  /** Layman briefing — deterministic sentences from real study values. */
  briefing: string;
  /**
   * THE WATER GRADIENT (PINNED CONTRACT — the PE leg codes to this):
   * transparent-background PNG colorizing the drainage field into a blue
   * water ramp, with its WGS84 bbox and a provenance note (DEM resolution +
   * design storm). Absent when the field is degenerate or honest-empty —
   * never fabricated.
   */
  gradient?: FloodDrainageGradient;
  /**
   * TRACED FLOW PATHS (v3 additive, PINNED CONTRACT — PE feature-detects;
   * absent-safe for old consumers): the top D8 accumulation ridgelines of
   * the SAME model the gradient shades, ordered downstream, with strength =
   * normalized log flow accumulation and kind "exit" when the trace leaves
   * the parcel ring. Absent when no channel reaches the study threshold.
   */
  flowPaths?: FloodFlowPath[];
  /**
   * CATCHMENT SWATHS (v3 additive, index-aligned with flowPaths): one
   * closed polygon ring per path buffering it with a width proportional to
   * local normalized accumulation — the contributing corridor, widening
   * downstream. See flood-flow-paths.ts for the honest-derivation contract.
   */
  catchmentSwaths?: FloodCatchmentSwath[];
  /** Provenance note for flowPaths + catchmentSwaths (present with them). */
  flowPathsNote?: string;
  honestEmpty?: { reason: string };
  /** Additive detail beyond the pinned contract (PE viz + PDF arrows). */
  flowExits: FloodDrainageFlowExit[];
  stats: FloodDrainageStudyStats;
  computation: {
    library: string;
    routing: string;
    accumulationThreshold: number;
    fallbackUsed?: boolean;
    fallbackReason?: string;
  };
  parcelRingWgs84: Array<[number, number]>;
  catchmentBbox: BboxWgs84;
  geometrySourceRef: string;
  generatedAt: string;
}

export interface RunFloodDrainageStudyOptions {
  parcelNodeId: string;
  resolver: ParcelGeometryResolver;
  /** Test/operator overrides — same seams as the site-plan export. */
  bboxOverride?: BboxWgs84;
  ringOverride?: Array<[number, number]>;
  /** Design-storm depth parameter. When set → rainfallSource "parameter". */
  rainfallDepthInches?: number;
  /** Drainage DEM resolution request; clamped to the drainage floor. */
  resolutionMeters?: number;
  fetchDem?: typeof fetchUsgs3depDem;
  parseDem?: (bytes: Uint8Array) => Promise<ParsedDem>;
  runWorker?: (req: HydrologyWorkerRequest) => Promise<HydrologyWorkerResult>;
  fetchRainfall?: typeof fetchNoaaAtlas14PointEstimate;
}

// ─────────────────────────────────────────────────────────────────────────
// Geometry helpers (WGS84 → local meters; deterministic, no invention).
// ─────────────────────────────────────────────────────────────────────────

function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function paddedCatchmentBbox(parcelBbox: BboxWgs84): BboxWgs84 {
  const meanLat = (parcelBbox.southLat + parcelBbox.northLat) / 2;
  const mLng = metersPerDegLng(meanLat);
  const spanM = Math.max(
    (parcelBbox.eastLng - parcelBbox.westLng) * mLng,
    (parcelBbox.northLat - parcelBbox.southLat) * METERS_PER_DEG_LAT,
  );
  const padM = Math.min(
    CATCHMENT_PAD_MAX_METERS,
    Math.max(CATCHMENT_PAD_MIN_METERS, spanM * CATCHMENT_PAD_FACTOR),
  );
  return {
    westLng: parcelBbox.westLng - padM / mLng,
    eastLng: parcelBbox.eastLng + padM / mLng,
    southLat: parcelBbox.southLat - padM / METERS_PER_DEG_LAT,
    northLat: parcelBbox.northLat + padM / METERS_PER_DEG_LAT,
  };
}

/** Ray-cast point-in-ring test on WGS84 [lng, lat] pairs. */
export function pointInRing(lng: number, lat: number, ring: ReadonlyArray<[number, number]>): boolean {
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

function ringCentroid(ring: ReadonlyArray<[number, number]>): { lng: number; lat: number } {
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lng: sumLng / ring.length, lat: sumLat / ring.length };
}

export type PourPointMethod =
  | "max-accumulation-on-parcel"
  | "lowest-boundary-cell"
  | "ring-centroid";

export interface PourPointResolution {
  lng: number;
  lat: number;
  method: PourPointMethod;
}

/**
 * PARCEL-AWARE pour point (2026-07-29 v2 — operator-directed redesign).
 *
 * The pour point is where the parcel's water actually concentrates, never a
 * bbox-center guess:
 *
 *   1. The MAX-ACCUMULATION cell whose center lies ON the parcel (inside the
 *      ring) or ADJACENT to it (any 8-neighbor center inside the ring) — the
 *      strongest modeled flow that touches this parcel.
 *   2. When no candidate carries flow (or the grid is too coarse to land a
 *      center in the ring), the parcel's LOWEST BOUNDARY CELL — ring edges
 *      sampled onto the grid, lowest finite elevation wins.
 *   3. Last resort, the ring centroid.
 *
 * Deterministic on the same DEM + ring; the method used is recorded so the
 * study can disclose it.
 */
export function resolvePourPoint(
  dem: Pick<ParsedDem, "width" | "height" | "values">,
  catchmentBbox: BboxWgs84,
  ring: ReadonlyArray<[number, number]>,
  accumulation: Uint32Array,
): PourPointResolution {
  const { width, height, values } = dem;
  const lngSpan = catchmentBbox.eastLng - catchmentBbox.westLng;
  const latSpan = catchmentBbox.northLat - catchmentBbox.southLat;
  const cellLng = lngSpan / Math.max(width, 1);
  const cellLat = latSpan / Math.max(height, 1);
  const cellCenter = (col: number, row: number): [number, number] => [
    catchmentBbox.westLng + (col + 0.5) * cellLng,
    catchmentBbox.northLat - (row + 0.5) * cellLat,
  ];

  // Restrict the scan to the ring bbox padded by one cell (candidates must
  // be on or adjacent to the parcel; nothing farther can qualify).
  const ringLngs = ring.map((p) => p[0]);
  const ringLats = ring.map((p) => p[1]);
  const minLng = Math.min(...ringLngs) - Math.abs(cellLng) * 1.5;
  const maxLng = Math.max(...ringLngs) + Math.abs(cellLng) * 1.5;
  const minLat = Math.min(...ringLats) - Math.abs(cellLat) * 1.5;
  const maxLat = Math.max(...ringLats) + Math.abs(cellLat) * 1.5;

  const inRingCache = new Map<number, boolean>();
  const centerInRing = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= width || row >= height) return false;
    const key = row * width + col;
    const cached = inRingCache.get(key);
    if (cached !== undefined) return cached;
    const [lng, lat] = cellCenter(col, row);
    const inside = pointInRing(lng, lat, ring);
    inRingCache.set(key, inside);
    return inside;
  };

  let best: { col: number; row: number; acc: number } | null = null;
  for (let row = 0; row < height; row++) {
    const [, lat] = cellCenter(0, row);
    if (lat < minLat || lat > maxLat) continue;
    for (let col = 0; col < width; col++) {
      const [lng] = cellCenter(col, row);
      if (lng < minLng || lng > maxLng) continue;
      const i = row * width + col;
      if (!Number.isFinite(values[i]!)) continue;
      // ON the parcel, or ADJACENT to it (an 8-neighbor center in the ring).
      let touchesParcel = centerInRing(col, row);
      if (!touchesParcel) {
        neighborScan: for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (centerInRing(col + dc, row + dr)) {
              touchesParcel = true;
              break neighborScan;
            }
          }
        }
      }
      if (!touchesParcel) continue;
      const acc = accumulation[i]!;
      if (!best || acc > best.acc) best = { col, row, acc };
    }
  }
  if (best && best.acc > 0) {
    const [lng, lat] = cellCenter(best.col, best.row);
    return { lng, lat, method: "max-accumulation-on-parcel" };
  }

  // Fallback: the parcel's lowest boundary cell — sample every ring edge at
  // sub-cell steps, collect the traversed cells, take the lowest elevation.
  let lowest: { col: number; row: number; z: number } | null = null;
  const visitBoundaryCell = (lng: number, lat: number): void => {
    const col = Math.floor((lng - catchmentBbox.westLng) / (cellLng || 1));
    const row = Math.floor((catchmentBbox.northLat - lat) / (cellLat || 1));
    if (col < 0 || row < 0 || col >= width || row >= height) return;
    const z = values[row * width + col]!;
    if (!Number.isFinite(z)) return;
    if (!lowest || z < lowest.z) lowest = { col, row, z };
  };
  for (let i = 1; i < ring.length; i++) {
    const [lngA, latA] = ring[i - 1]!;
    const [lngB, latB] = ring[i]!;
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(lngB - lngA) / (Math.abs(cellLng) || 1)) +
        Math.ceil(Math.abs(latB - latA) / (Math.abs(cellLat) || 1)),
    );
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      visitBoundaryCell(lngA + (lngB - lngA) * f, latA + (latB - latA) * f);
    }
  }
  if (lowest) {
    const found = lowest as { col: number; row: number; z: number };
    const [lng, lat] = cellCenter(found.col, found.row);
    return { lng, lat, method: "lowest-boundary-cell" };
  }

  const centroid = ringCentroid(ring);
  return { ...centroid, method: "ring-centroid" };
}

/** Shoelace area of one GeoJSON Polygon exterior ring, in square feet. */
function polygonAreaSqFt(coordinates: unknown): number {
  const exterior = Array.isArray(coordinates) ? (coordinates as unknown[])[0] : null;
  if (!Array.isArray(exterior) || exterior.length < 3) return 0;
  const pts = exterior as Array<[number, number]>;
  const lat0 = pts[0]![1];
  const mLng = metersPerDegLng(lat0);
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i]![0] * mLng;
    const yi = pts[i]![1] * METERS_PER_DEG_LAT;
    const xj = pts[j]![0] * mLng;
    const yj = pts[j]![1] * METERS_PER_DEG_LAT;
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum / 2) * SQFT_PER_SQM;
}

export function featureCollectionAreaSqFt(fc: GeoJsonFeatureCollection | null): number {
  if (!fc) return 0;
  let total = 0;
  for (const feature of fc.features) {
    if (feature.geometry.type !== "Polygon") continue;
    total += polygonAreaSqFt(feature.geometry.coordinates);
  }
  return total;
}

/** Signed-free shoelace area of one WGS84 ring, square feet. */
function ringAreaSqFt(pts: ReadonlyArray<[number, number]>): number {
  if (pts.length < 3) return 0;
  const lat0 = pts[0]![1];
  const mLng = metersPerDegLng(lat0);
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i]![0] * mLng;
    const yi = pts[i]![1] * METERS_PER_DEG_LAT;
    const xj = pts[j]![0] * mLng;
    const yj = pts[j]![1] * METERS_PER_DEG_LAT;
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum / 2) * SQFT_PER_SQM;
}

export interface PondingClipResult {
  /** The rainfall FeatureCollection with every Polygon feature tagged
   * `onParcel: boolean` (true = the feature intersects the parcel ring). */
  taggedGeoJson: GeoJsonFeatureCollection;
  /** Ponded area intersecting the parcel ring, square feet (exact
   * polygon-clipping intersection, not a centroid heuristic). */
  onParcelAreaSqFt: number;
  /** Total ponded area across the whole modeled region, square feet. */
  modeledRegionAreaSqFt: number;
}

/**
 * Clip the modeled rainfall/ponding result to the parcel ring (2026-07-29
 * canary fix). The headline ponding stat must answer "how much water pools
 * on THIS parcel" — never the whole padded catchment region. Exact boolean
 * intersection via polygon-clipping (already the repo's polygon-ops
 * dependency); every feature is tagged `onParcel` so the PDF drawing and
 * the PE viz emphasize parcel ponding without re-deriving the clip.
 */
export function clipPondingToParcel(
  fc: GeoJsonFeatureCollection,
  ring: ReadonlyArray<[number, number]>,
): PondingClipResult {
  const parcelPoly: [number, number][][] = [ring.map((p) => [p[0], p[1]] as [number, number])];
  let onParcelAreaSqFt = 0;
  let modeledRegionAreaSqFt = 0;
  const features = fc.features.map((feature) => {
    if (feature.geometry.type !== "Polygon") {
      return { ...feature, properties: { ...feature.properties, onParcel: false } };
    }
    const exterior = (feature.geometry.coordinates as [number, number][][])[0];
    if (!Array.isArray(exterior) || exterior.length < 3) {
      return { ...feature, properties: { ...feature.properties, onParcel: false } };
    }
    modeledRegionAreaSqFt += ringAreaSqFt(exterior);
    let interAreaSqFt = 0;
    try {
      const intersection = polygonClipping.intersection(parcelPoly, [exterior]);
      for (const poly of intersection) {
        poly.forEach((clipRing, ringIndex) => {
          const area = ringAreaSqFt(clipRing as [number, number][]);
          interAreaSqFt += ringIndex === 0 ? area : -area;
        });
      }
    } catch {
      // Degenerate input geometry: honest fallback is NO parcel overlap
      // claimed — never a guessed positive area.
      interAreaSqFt = 0;
    }
    onParcelAreaSqFt += Math.max(0, interAreaSqFt);
    return {
      ...feature,
      properties: { ...feature.properties, onParcel: interAreaSqFt > 0 },
    };
  });
  return {
    taggedGeoJson: { type: "FeatureCollection", features },
    onParcelAreaSqFt,
    modeledRegionAreaSqFt,
  };
}

/**
 * Flow exits: traced flow lines that START inside the parcel ring (or enter
 * it) and leave it — the first vertex outside following an inside vertex is
 * the exit point. Exits within ~15 m of an already-recorded exit are merged
 * (they are the same channel at grid resolution).
 */
export function resolveFlowExits(
  flowLines: GeoJsonFeatureCollection,
  ring: ReadonlyArray<[number, number]>,
): FloodDrainageFlowExit[] {
  const exits: FloodDrainageFlowExit[] = [];
  const mergeMeters = 15;
  for (const feature of flowLines.features) {
    if (feature.geometry.type !== "LineString") continue;
    const coords = feature.geometry.coordinates as Array<[number, number]>;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1]!;
      const curr = coords[i]!;
      const prevIn = pointInRing(prev[0], prev[1], ring);
      const currIn = pointInRing(curr[0], curr[1], ring);
      if (!prevIn || currIn) continue;
      const mLng = metersPerDegLng(curr[1]);
      const dxM = (curr[0] - prev[0]) * mLng;
      const dyM = (curr[1] - prev[1]) * METERS_PER_DEG_LAT;
      const bearingDeg = ((Math.atan2(dxM, dyM) * 180) / Math.PI + 360) % 360;
      const duplicate = exits.some((e) => {
        const ddx = (e.lng - curr[0]) * mLng;
        const ddy = (e.lat - curr[1]) * METERS_PER_DEG_LAT;
        return Math.hypot(ddx, ddy) < mergeMeters;
      });
      if (!duplicate) {
        exits.push({ lng: curr[0], lat: curr[1], bearingDeg });
      }
      break; // one exit per traced line
    }
  }
  return exits;
}

/**
 * DRAINAGE ZONES — three nested concentration bands (2026-07-30 redesign).
 *
 * WHAT CHANGED AND WHY. The prior derivation graded each catchment feature by
 * counting how many traced flow-line vertices fell inside its bbox, then
 * bucketed 0 / 1-2 / 3+ into `concentration` 0 | 1 | 2. That was coherent only
 * while the catchment arrived as HUNDREDS of small subsampled grid squares —
 * each square was effectively a grid cell, so vertex density per square read
 * as flow density per cell. Now that the converters emit DISSOLVED regions, a
 * catchment is one or a few large polygons that between them absorb every
 * flow vertex, so the same counting would grade essentially everything "high"
 * and the three bands would collapse into one.
 *
 * So the bands now come from the MODEL, not from re-bucketing polygon vertex
 * counts: the hydrology backend thresholds its own D8 accumulation grid at
 * three levels inside the catchment mask and traces each level as its own
 * dissolved region (see `deriveConcentrationBands` in the adapters hydrology
 * package for the quantile levels and the nesting guarantee). Higher bands are
 * strict subsets of lower ones, which is what the redesign paints.
 *
 * FALLBACK, HONESTLY: when the backend produced no bands (an older worker
 * payload, or a field with no gradable accumulation), the catchment regions
 * ship as band 0 — "modeled catchment extent" — rather than inventing a
 * medium/high band the model does not support. `concentration` is always
 * present on every feature so the client can paint deterministically.
 */
export function deriveDrainageZones(
  catchment: GeoJsonFeatureCollection,
  flowLines: GeoJsonFeatureCollection,
  concentrationBands?: GeoJsonFeatureCollection | null,
): GeoJsonFeatureCollection {
  void flowLines; // bands come from the accumulation grid, not vertex counts
  if (concentrationBands && concentrationBands.features.length > 0) {
    // Paint order matters for nested bands: low first, high last, so the
    // tightest band sits on top when a client draws in array order.
    const features = [...concentrationBands.features].sort((a, b) => {
      const ca = Number((a.properties as { concentration?: number })?.concentration ?? 0);
      const cb = Number((b.properties as { concentration?: number })?.concentration ?? 0);
      return ca - cb;
    });
    return { type: "FeatureCollection", features };
  }
  const features = catchment.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      concentration: 0,
      concentrationBasis: "modeled catchment extent",
    },
  }));
  return { type: "FeatureCollection", features };
}

// ─────────────────────────────────────────────────────────────────────────
// Rainfall forcing (honest source labeling).
// ─────────────────────────────────────────────────────────────────────────

export interface ResolvedRainfall {
  depthInches: number;
  source: RainfallSource;
  /** Provenance detail for the sheet's SOURCE column / study payload. */
  detail: string;
}

export async function resolveStudyRainfall(
  centroid: { lng: number; lat: number },
  parameterDepthInches: number | undefined,
  fetchRainfall: typeof fetchNoaaAtlas14PointEstimate,
): Promise<ResolvedRainfall> {
  if (
    typeof parameterDepthInches === "number" &&
    Number.isFinite(parameterDepthInches) &&
    parameterDepthInches > 0
  ) {
    return {
      depthInches: parameterDepthInches,
      source: "parameter",
      detail: "depth supplied by the requesting application",
    };
  }
  let estimate: NoaaAtlas14PointEstimate | null = null;
  try {
    estimate = await fetchRainfall({ lat: centroid.lat, lng: centroid.lng });
  } catch {
    estimate = null;
  }
  const storm = estimate?.designStorms.find(
    (s) => s.returnPeriodYears === DESIGN_STORM_RETURN_PERIOD_YEARS,
  );
  if (storm) {
    return {
      depthInches: storm.depthInches,
      source: "noaa-atlas14",
      detail: `NOAA Atlas 14 PFDS point estimate (${DESIGN_STORM_RETURN_PERIOD_YEARS}-yr 24-hr)`,
    };
  }
  return {
    depthInches: DEFAULT_RAINFALL_DEPTH_INCHES,
    source: "default",
    detail: DEFAULT_RAINFALL_CITATION,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Briefing (deterministic layman sentences from real values; §11-clean —
// no colons, no machine identifiers).
// ─────────────────────────────────────────────────────────────────────────

function acresPhrase(sqFt: number): string {
  const acres = sqFt / 43_560;
  if (acres >= 0.1) return `about ${acres.toFixed(1)} acres`;
  return `about ${Math.round(sqFt).toLocaleString("en-US")} square feet`;
}

/**
 * Below this many DEM cells of modeled catchment, the upstream contribution
 * is NEGLIGIBLE at screening resolution and the briefing says so plainly —
 * it never emits the incoherent "catchment of about 0 square feet delivers
 * runoff toward the parcel" (the 2026-07-29 operator canary on the live
 * 1408 Chestnut run).
 */
export const NEGLIGIBLE_CATCHMENT_CELLS = 4;

export function negligibleCatchmentThresholdSqFt(resolutionMeters: number): number {
  const res =
    Number.isFinite(resolutionMeters) && resolutionMeters > 0
      ? resolutionMeters
      : DEFAULT_DRAINAGE_RESOLUTION_METERS;
  return NEGLIGIBLE_CATCHMENT_CELLS * res * res * SQFT_PER_SQM;
}

export function buildFloodDrainageBriefing(study: {
  stats: FloodDrainageStudyStats;
  rainfallDepthInches: number;
  honestEmpty?: { reason: string };
  demProvenance?: { resolutionMeters: number };
}): string {
  if (study.honestEmpty) {
    return `${study.honestEmpty.reason} This is a screening-level model of surface flow, and a flat or unresolved terrain signal means no concentrated drainage path could be traced for this parcel. Verify site drainage with a licensed engineer before design or permitting.`;
  }
  const sentences: string[] = [];
  const negligibleSqFt = negligibleCatchmentThresholdSqFt(
    study.demProvenance?.resolutionMeters ?? DEFAULT_DRAINAGE_RESOLUTION_METERS,
  );
  const highPoint = study.stats.catchmentAreaSqFt < negligibleSqFt;
  if (highPoint) {
    // HONEST near-zero catchment. A "catchment of about 0 square feet
    // delivers runoff toward the parcel" is incoherent; the true reading is
    // that the parcel sheds rather than receives.
    sentences.push(
      "The parcel sits at or near a local high point, so negligible upstream catchment delivers runoff onto it and rainfall landing on the parcel drains away from it.",
    );
  } else {
    sentences.push(
      `The modeled upstream catchment of ${acresPhrase(study.stats.catchmentAreaSqFt)} delivers runoff toward the parcel's low point.`,
    );
  }
  if (study.stats.pondedAreaSqFt != null && study.stats.pondedAreaSqFt > 0) {
    // COHERENCE GUARD (2026-07-30). The briefing must never narrate a parcel
    // as a local high point that sheds water and, in the next sentence, report
    // large ponding on that same parcel — the live 48021:36249 payload did
    // exactly that ("negligible upstream catchment ... drains away from it"
    // alongside "ponding covers about 9.1 acres"). The criterion fix is what
    // makes that combination stop arising; this guard is the belt-and-braces
    // that keeps the SENTENCES honest if it ever does, by qualifying the
    // ponding as on-parcel depression storage rather than delivered runoff.
    // It never suppresses or shrinks the number.
    const pondPhrase = acresPhrase(study.stats.pondedAreaSqFt);
    sentences.push(
      highPoint
        ? `At a ${study.rainfallDepthInches} inch design storm, modeled ponding covers ${pondPhrase} on the parcel, held in local depressions on the parcel itself rather than fed by upstream runoff.`
        : `At a ${study.rainfallDepthInches} inch design storm, modeled ponding covers ${pondPhrase} on the parcel.`,
    );
  } else if (study.stats.pondedAreaSqFt === 0) {
    sentences.push(
      `At a ${study.rainfallDepthInches} inch design storm, no modeled ponding intersects the parcel.`,
    );
  } else {
    sentences.push(
      `A rainfall ponding response was not modeled on this run at the ${study.rainfallDepthInches} inch design storm.`,
    );
  }
  if (study.stats.flowExitCount > 0) {
    const n = study.stats.flowExitCount;
    sentences.push(
      `${n === 1 ? "One modeled flow path exits" : `${n} modeled flow paths exit`} the parcel boundary.`,
    );
  } else {
    sentences.push("No concentrated flow path crossing the parcel boundary was traced.");
  }
  sentences.push(
    "Verify finished-floor elevation against the ponding scenario before locking a building envelope.",
  );
  return sentences.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────
// Honest-empty reasons (§11 form — one plain sentence each).
// ─────────────────────────────────────────────────────────────────────────

export const HONEST_EMPTY_FLAT_TERRAIN =
  "No significant drainage concentration modeled here.";
export const HONEST_EMPTY_DEM_VOID =
  "Terrain elevation data did not resolve for this parcel.";
export const HONEST_EMPTY_COMPUTATION =
  "The drainage computation did not complete for this parcel.";

function honestEmptyReasonForWorkerError(code: string | undefined): string {
  if (code === "flat-terrain") return HONEST_EMPTY_FLAT_TERRAIN;
  if (code === "nodata-dem") return HONEST_EMPTY_DEM_VOID;
  return HONEST_EMPTY_COMPUTATION;
}

const EMPTY_FC: GeoJsonFeatureCollection = { type: "FeatureCollection", features: [] };

// ─────────────────────────────────────────────────────────────────────────
// The study runner.
// ─────────────────────────────────────────────────────────────────────────

export interface RunFloodDrainageStudyResult {
  study: FloodDrainageStudy;
  dem: ParsedDem;
  demFetch: Awaited<ReturnType<typeof fetchUsgs3depDem>>;
  resolutionMetersRequested: number;
  resolutionMetersAdapted: number;
  resolvedSourceRef: string;
}

export async function runFloodDrainageStudy(
  options: RunFloodDrainageStudyOptions,
): Promise<RunFloodDrainageStudyResult> {
  const resolved = options.bboxOverride
    ? { bbox: options.bboxOverride, sourceRef: "request:bbox-override", ring: options.ringOverride }
    : await options.resolver.resolve(options.parcelNodeId);
  if (!resolved) {
    throw new Error(
      `Parcel geometry unavailable for ${options.parcelNodeId}; configure a spine resolver or supply bboxOverride+ringOverride for a test.`,
    );
  }
  const ringWgs84 = options.ringOverride ?? resolved.ring;
  if (!ringWgs84 || ringWgs84.length < 3) {
    throw new Error(
      `Parcel ${options.parcelNodeId} resolver returned no boundary ring; the flood-drainage study refuses to approximate a ring from the bbox rectangle.`,
    );
  }

  // Drainage resolution: clamp the request at the drainage floor, then let
  // the adaptive selector relax coarser if the padded bbox demands it.
  const requestedRaw = options.resolutionMeters ?? DEFAULT_DRAINAGE_RESOLUTION_METERS;
  const resolutionMetersRequested = Math.max(requestedRaw, MIN_DRAINAGE_RESOLUTION_METERS);
  const catchmentBbox = paddedCatchmentBbox(resolved.bbox);
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
    catchmentBbox,
    resolutionMetersRequested,
  );

  // Cold-refresh trim (2026-07-29 canary follow-up): the NOAA point-estimate
  // fetch (up to a 15s upstream timeout) runs CONCURRENTLY with the DEM
  // fetch+parse instead of serially after it — it only needs the ring
  // centroid, which is already known. `resolveStudyRainfall` never rejects
  // (fetch failures resolve to the documented default), so the parallel
  // promise cannot orphan an unhandled rejection if the DEM path throws.
  const centroid = ringCentroid(ringWgs84);
  const rainfallPromise = resolveStudyRainfall(
    centroid,
    options.rainfallDepthInches,
    options.fetchRainfall ?? fetchNoaaAtlas14PointEstimate,
  );

  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(catchmentBbox, {
    resolutionMeters: resolutionMetersAdapted,
  });
  const dem = await (options.parseDem ?? parseDemBytes)(demFetch.bytes);
  const rainfall = await rainfallPromise;

  // In-process D8 field over the SAME parsed DEM: feeds the PARCEL-AWARE
  // pour point (max-accumulation cell touching the parcel) and the water-
  // gradient raster. Cheap at drainage resolution (≤ ~640² cells) and
  // deterministic; the worker re-derives its own routing for the vector
  // outputs, so neither result is guessed from the other.
  const d8 = computeD8Field(dem.values, dem.width, dem.height);
  const pourResolution = resolvePourPoint(dem, catchmentBbox, ringWgs84, d8.accumulation);
  const pourPoint = { lng: pourResolution.lng, lat: pourResolution.lat };
  const accumulationThreshold = accumulationThresholdForResolution(resolutionMetersAdapted);

  const runWorker = options.runWorker ?? runHydrologyWorker;
  const result = await runWorker({
    demBytes: demFetch.bytes.buffer.slice(
      demFetch.bytes.byteOffset,
      demFetch.bytes.byteOffset + demFetch.bytes.byteLength,
    ) as ArrayBuffer,
    pourLng: pourPoint.lng,
    pourLat: pourPoint.lat,
    catchmentBbox,
    width: dem.width,
    height: dem.height,
    elevation: dem.values,
    rainfallDepthMm: inchesToMm(rainfall.depthInches),
    accumulationThreshold,
  });

  const generatedAt = new Date().toISOString();
  const demProvenance: FloodDrainageDemProvenance = {
    source: "USGS 3DEP",
    resolutionMeters: resolutionMetersAdapted,
  };

  const base = {
    parcelNodeId: options.parcelNodeId,
    rainfallDepthInches: rainfall.depthInches,
    rainfallSource: rainfall.source,
    demProvenance,
    parcelRingWgs84: ringWgs84,
    catchmentBbox,
    geometrySourceRef: resolved.sourceRef,
    generatedAt,
  };

  if (result.status === "error") {
    const reason = honestEmptyReasonForWorkerError(result.code);
    const stats: FloodDrainageStudyStats = {
      catchmentAreaSqFt: 0,
      pondedAreaSqFt: null,
      pondedAreaModeledRegionSqFt: null,
      flowExitCount: 0,
      pourPoint,
      pourPointMethod: pourResolution.method,
    };
    const study: FloodDrainageStudy = {
      ...base,
      catchmentGeoJson: EMPTY_FC,
      drainageZonesGeoJson: EMPTY_FC,
      rainfallResultGeoJson: null,
      flowLinesGeoJson: EMPTY_FC,
      honestEmpty: { reason },
      flowExits: [],
      stats,
      computation: {
        library: "unavailable",
        routing: "d8",
        accumulationThreshold,
      },
      briefing: "",
    };
    study.briefing = buildFloodDrainageBriefing(study);
    return {
      study,
      dem,
      demFetch,
      resolutionMetersRequested,
      resolutionMetersAdapted,
      resolvedSourceRef: resolved.sourceRef,
    };
  }

  const catchmentGeoJson = result.drainageZonesGeoJson;
  const drainageZonesGeoJson = deriveDrainageZones(
    catchmentGeoJson,
    result.flowLinesGeoJson,
    result.concentrationBandsGeoJson ?? null,
  );
  const flowExits = resolveFlowExits(result.flowLinesGeoJson, ringWgs84);
  // Headline ponding = the PARCEL-CLIPPED area; the whole-region figure is
  // context only (never the headline — the 2026-07-29 canary defect).
  const pondingClip = result.rainfallResultGeoJson
    ? clipPondingToParcel(result.rainfallResultGeoJson, ringWgs84)
    : null;
  const stats: FloodDrainageStudyStats = {
    catchmentAreaSqFt: featureCollectionAreaSqFt(catchmentGeoJson),
    pondedAreaSqFt: pondingClip ? pondingClip.onParcelAreaSqFt : null,
    pondedAreaModeledRegionSqFt: pondingClip ? pondingClip.modeledRegionAreaSqFt : null,
    flowExitCount: flowExits.length,
    pourPoint: result.pourPoint,
    pourPointMethod: pourResolution.method,
  };

  // THE WATER GRADIENT (v2 pinned contract): built from the in-process D8
  // field over the same DEM; null (omitted) when the field is degenerate.
  const gradient = buildDrainageGradient({
    elevation: dem.values,
    width: dem.width,
    height: dem.height,
    accumulation: d8.accumulation,
    bbox: catchmentBbox,
    rainfallDepthMm: inchesToMm(rainfall.depthInches),
    demResolutionMeters: resolutionMetersAdapted,
    rainfallDepthInches: rainfall.depthInches,
  });

  // TRACED FLOW PATHS + CATCHMENT SWATHS (v3 pinned contract): same D8
  // field, same normalization as the gradient; null (omitted) when no
  // channel reaches the threshold — absent fields are honest.
  const flowPathsResult = buildFloodFlowPaths({
    elevation: dem.values,
    width: dem.width,
    height: dem.height,
    accumulation: d8.accumulation,
    fdir: d8.fdir,
    bbox: catchmentBbox,
    accumulationThreshold,
    parcelRing: ringWgs84,
    demResolutionMeters: resolutionMetersAdapted,
  });

  const study: FloodDrainageStudy = {
    ...base,
    catchmentGeoJson,
    drainageZonesGeoJson,
    rainfallResultGeoJson: pondingClip ? pondingClip.taggedGeoJson : null,
    flowLinesGeoJson: result.flowLinesGeoJson,
    flowExits,
    stats,
    ...(gradient ? { gradient } : {}),
    ...(flowPathsResult
      ? {
          flowPaths: flowPathsResult.flowPaths,
          catchmentSwaths: flowPathsResult.catchmentSwaths,
          flowPathsNote: flowPathsResult.note,
        }
      : {}),
    computation: {
      library: result.library,
      routing: result.routing,
      accumulationThreshold: result.accumulationThreshold,
      ...(result.fallbackUsed ? { fallbackUsed: true, fallbackReason: result.fallbackReason } : {}),
    },
    briefing: "",
  };
  study.briefing = buildFloodDrainageBriefing(study);

  return {
    study,
    dem,
    demFetch,
    resolutionMetersRequested,
    resolutionMetersAdapted,
    resolvedSourceRef: resolved.sourceRef,
  };
}
