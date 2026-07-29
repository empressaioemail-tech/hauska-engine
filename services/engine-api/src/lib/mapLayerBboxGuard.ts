/**
 * Map-layer bbox-area / raster-size guard (fix/topo-slot-bbox-guard, 2026-07-27).
 *
 * WHY THIS EXISTS
 * ---------------
 * The `topography-1ft` and `hydrology-flow` map slots (mapLayersWave3.ts) fetch a
 * 3DEP DEM raster and/or a large set of county contour polylines for the request
 * bbox, then parse/derive over them IN MEMORY. At a zoomed-out viewport the bbox
 * is large, and the spike lands in the FETCH + PARSE stage, BEFORE the existing
 * per-compute caps (the 512²-cell hydrology downsample) apply.
 *
 * The DEM client's {@link selectAdaptiveResolutionMeters} bounds the raster axis
 * to {@link MAX_PIXELS_PER_AXIS} = 4096, but a 4096×4096 F32 GeoTIFF is ~67 MB on
 * the wire, its parsed Float32 grid is another ~67 MB, and the contour derivation
 * allocates a Float64 copy (~134 MB) on top. That is ~270 MB peak for ONE slot at
 * the 4096 ceiling. Three of these slots run concurrently in the SAME container
 * (topography, topography-1ft, hydrology-flow), which also serves site-plan
 * export, so the concurrent peak blew the 2 GiB limit:
 *   "Memory limit of 2048 MiB exceeded with 2118 MiB used"
 * and every downstream call (contours, hydrology, AND site-plan export) 503'd.
 *
 * A map layer does NOT need full mesh resolution. Map contours / flow lines read
 * correctly at a far coarser grid, and a zoomed-out viewport does not need 1-ft
 * contours at all. So map slots get a TIGHTER pixel budget than the mesh path,
 * and an area threshold above which they honestly degrade ("zoom in") instead of
 * fetching a huge payload.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 *  - {@link resolveMapLayerRasterPlan}: pick a map-safe DEM resolution for the
 *    bbox so the raster axis stays within {@link MAP_LAYER_MAX_PIXELS_PER_AXIS}
 *    (1024), by RELAXING coarser along the 3DEP ladder. If even the coarsest
 *    practical resolution cannot fit the map budget, it returns a degrade signal
 *    (the viewport is too large for a live raster — zoom in) rather than a fetch.
 *  - {@link mapLayerBboxAreaKm2}: bbox area in km² for the contour area gate.
 *  - constants for the per-slot budgets, importable by tests + the resolvers.
 *
 * The chosen resolution is passed to `fetchUsgs3depDem` as an EXPLICIT
 * `resolutionMeters`, so the fetch happens at the map budget, not the mesh
 * default. Worst-case memory per slot after this guard: a 1024² F32 raster =
 * ~4 MB bytes, ~4 MB parsed grid, ~8 MB Float64 contour copy ≈ ~16 MB peak, so
 * even all three slots concurrent plus the Bastrop polyline cap stay far under
 * 2 GiB (and thus survive even if the 4 GiB bump is ever reverted).
 */

import {
  bboxMetersExtent,
  MAX_PIXELS_PER_AXIS,
  MIN_PIXELS_PER_AXIS,
  FINEST_PRACTICAL_RESOLUTION_METERS,
  type BboxWgs84,
} from "@hauska-engine/adapters/topography";

/**
 * Per-axis pixel budget for MAP-LAYER DEM rasters. Much tighter than the mesh
 * path's {@link MAX_PIXELS_PER_AXIS} (4096) because map contours / flow lines do
 * not need mesh-grade resolution, and the raster memory scales with the SQUARE
 * of this number. 1024 keeps a full-budget F32 raster at ~4 MB (vs ~67 MB at
 * 4096) so concurrent slots cannot OOM the shared container.
 */
export const MAP_LAYER_MAX_PIXELS_PER_AXIS = 1024;

/**
 * The 3DEP relax ladder used for map-layer raster sizing, fine-to-coarse. Same
 * practical resolutions the DEM client relaxes along; we walk COARSER until the
 * raster fits {@link MAP_LAYER_MAX_PIXELS_PER_AXIS}. 30 m is the 1-arc-second
 * national fallback ceiling.
 */
const MAP_LAYER_RESOLUTION_LADDER = [1, 2, 3, 5, 10, 30] as const;

/**
 * Area (km²) above which the AUTHORITATIVE Bastrop 1-ft contour tier honestly
 * degrades to "zoom in for 1-ft contours". A zoomed-out viewport does not need
 * (and cannot cheaply render) 1-ft contours; the county FeatureServer would also
 * return a huge feature count at a large bbox. The 3DEP-derived coarse fallback
 * still serves at larger areas. ~4 km² ≈ a ~2 km × 2 km viewport — comfortably
 * larger than any parcel-scale extent, so real parcel work is unaffected.
 */
export const TOPOGRAPHY_1FT_MAX_AREA_KM2 = 4;

/**
 * Hard cap on Bastrop 1-ft polylines pulled into memory for a map render, well
 * below the adapter's own 200k default. At/under the area gate this is never
 * hit; it is a belt-and-suspenders bound so a dense small bbox still cannot pull
 * an unbounded polyline set into the map response.
 */
export const TOPOGRAPHY_1FT_MAP_MAX_FEATURES = 20_000;

/**
 * Area (km²) above which the county-mapped `hydrography` slot honestly
 * degrades to "zoom in" instead of querying the county layer. Bastrop maps
 * ~9,083 creek/stream features over the ~2,300 km² county with a 1,000-feature
 * transfer limit and NO pagination, so a large viewport would truncate hard
 * (and pull an unbounded polyline set into memory on a denser county). ~100 km²
 * ≈ a 10 km × 10 km viewport — far beyond parcel scale, and small enough that
 * the 1,000-feature transfer limit is rarely the binding constraint.
 */
export const HYDROGRAPHY_MAX_AREA_KM2 = 100;

/**
 * Client-side cap on county hydrography features kept per map response —
 * belt-and-suspenders above the server transfer limit so a pathologically
 * dense source still cannot pull an unbounded feature set into the response.
 */
export const HYDROGRAPHY_MAP_MAX_FEATURES = 5_000;

/** Meters-per-degree constant matching the DEM client's sizing math. */
const METERS_PER_DEG_LAT = 111_320;

/** Bbox area in square kilometres (WGS84, cos-lat scaled for longitude). */
export function mapLayerBboxAreaKm2(bbox: BboxWgs84): number {
  const { widthM, heightM } = bboxMetersExtent(bbox);
  return (Math.abs(widthM) * Math.abs(heightM)) / 1_000_000;
}

/**
 * The would-be raster axis pixel counts for a bbox at a given resolution — the
 * same ceil(meters / resolution) the DEM client uses to size `size=w,h`.
 */
function rasterAxisPixels(
  bbox: BboxWgs84,
  resolutionMeters: number,
): { widthPx: number; heightPx: number } {
  const { widthM, heightM } = bboxMetersExtent(bbox);
  return {
    widthPx: Math.ceil(Math.abs(widthM) / resolutionMeters),
    heightPx: Math.ceil(Math.abs(heightM) / resolutionMeters),
  };
}

export type MapLayerRasterPlan =
  | {
      /** A map-safe resolution was found; fetch the DEM at this resolution. */
      fit: true;
      resolutionMeters: number;
      widthPx: number;
      heightPx: number;
    }
  | {
      /**
       * The viewport is too large for a live map raster even at the coarsest
       * practical resolution — honest-degrade ("zoom in"), never a huge fetch.
       */
      fit: false;
      degradeReason: string;
      /** The coarsest resolution tried, for the honest reason string. */
      coarsestResolutionMeters: number;
      /** Axis pixels the bbox would need at the coarsest resolution. */
      widthPxAtCoarsest: number;
      heightPxAtCoarsest: number;
    };

/**
 * Pick a MAP-SAFE DEM resolution for a bbox: the finest resolution on the ladder
 * whose raster stays within {@link MAP_LAYER_MAX_PIXELS_PER_AXIS} on BOTH axes.
 * Walks coarse only as far as needed. Returns a degrade signal when even the
 * coarsest practical resolution (30 m) cannot fit the map budget — the honest
 * "zoom in" path.
 *
 * This runs BEFORE any fetch, so a zoomed-out viewport never triggers the large
 * raster fetch/parse that caused the OOM.
 */
export function resolveMapLayerRasterPlan(bbox: BboxWgs84): MapLayerRasterPlan {
  for (const resolutionMeters of MAP_LAYER_RESOLUTION_LADDER) {
    const { widthPx, heightPx } = rasterAxisPixels(bbox, resolutionMeters);
    if (
      widthPx <= MAP_LAYER_MAX_PIXELS_PER_AXIS &&
      heightPx <= MAP_LAYER_MAX_PIXELS_PER_AXIS
    ) {
      return { fit: true, resolutionMeters, widthPx, heightPx };
    }
  }
  const coarsest =
    MAP_LAYER_RESOLUTION_LADDER[MAP_LAYER_RESOLUTION_LADDER.length - 1]!;
  const { widthPx, heightPx } = rasterAxisPixels(bbox, coarsest);
  const areaKm2 = mapLayerBboxAreaKm2(bbox);
  return {
    fit: false,
    degradeReason:
      `viewport too large for live terrain (~${Math.round(areaKm2)} km²; ` +
      `would need ${widthPx}x${heightPx}px at ${coarsest}m/px, over the ` +
      `${MAP_LAYER_MAX_PIXELS_PER_AXIS}px map budget) — zoom in`,
    coarsestResolutionMeters: coarsest,
    widthPxAtCoarsest: widthPx,
    heightPxAtCoarsest: heightPx,
  };
}

/**
 * Default resolution FLOOR (meters per pixel) for the hydrology-flow slot's DEM
 * fetch (fix/hydrology-resolution-floor, 2026-07-28).
 *
 * WHY: after the topo-fidelity swap the shared raster plan resolves 1m for any
 * parcel-scale viewport (the ladder's finest rung fits the 1024px budget). The
 * terrain/contour slots WANT that fidelity; D8 flow-line derivation does NOT —
 * flow channels read identically at 10m, while a 1m DEM costs ~100x the cells,
 * exploded the flow-seed count (fixed 50-cell accumulation threshold), and blew
 * the pysheds worker past PE's 60s Vercel proxy budget → HTTP 504 on the chip.
 * So hydrology clamps the shared plan's resolution UP to this floor before the
 * fetch. Env-tunable via HYDROLOGY_MIN_RESOLUTION_METERS; clamped to [1, 30]
 * (1 = no floor beyond the ladder's finest, 30 = the national fallback ceiling)
 * so a misconfig can neither re-open the 1m blow-up ceilinglessly coarse nor
 * go below the ladder.
 */
export const HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT = 10;

/** Resolve the hydrology resolution floor from env (default 10m). */
export function resolveHydrologyMinResolutionMeters(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.HYDROLOGY_MIN_RESOLUTION_METERS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return HYDROLOGY_MIN_RESOLUTION_METERS_DEFAULT;
  }
  return Math.min(
    Math.max(raw, FINEST_PRACTICAL_RESOLUTION_METERS),
    MAP_LAYER_RESOLUTION_LADDER[MAP_LAYER_RESOLUTION_LADDER.length - 1]!,
  );
}

/**
 * The raster plan for the HYDROLOGY-FLOW slot: the shared map-layer plan with
 * its resolution clamped UP to the hydrology floor. The pixel counts are
 * recomputed at the clamped resolution so the DEM fetch is sized to what is
 * actually requested (honest metadata: `resolutionMeters`/`widthPx`/`heightPx`
 * always describe the fetch that happens). A no-fit (degrade) plan passes
 * through unchanged — a coarser floor can never turn a fitting plan into a
 * non-fitting one.
 */
export function resolveHydrologyRasterPlan(
  bbox: BboxWgs84,
  env: NodeJS.ProcessEnv = process.env,
): MapLayerRasterPlan {
  const plan = resolveMapLayerRasterPlan(bbox);
  if (!plan.fit) return plan;
  const floorMeters = resolveHydrologyMinResolutionMeters(env);
  if (plan.resolutionMeters >= floorMeters) return plan;

  // Clamp UP to the floor — but never below the DEM client's 16px minimum
  // axis ({@link MIN_PIXELS_PER_AXIS}: `fetchUsgs3depDem` throws
  // raster-too-small under it). For a very small viewport, relax the floor
  // FINER along the ladder until the raster clears 16px on both axes; if even
  // that fails, keep the shared plan unchanged (same behavior as pre-floor).
  const finerLadderSteps = [...MAP_LAYER_RESOLUTION_LADDER]
    .filter((step) => step < floorMeters && step >= plan.resolutionMeters)
    .sort((a, b) => b - a);
  for (const resolutionMeters of [floorMeters, ...finerLadderSteps]) {
    const { widthPx, heightPx } = rasterAxisPixels(bbox, resolutionMeters);
    if (
      widthPx >= MIN_PIXELS_PER_AXIS &&
      heightPx >= MIN_PIXELS_PER_AXIS
    ) {
      return { fit: true, resolutionMeters, widthPx, heightPx };
    }
  }
  return plan;
}

/** Re-export the mesh-path cap for tests that contrast the two budgets. */
export { MAX_PIXELS_PER_AXIS, FINEST_PRACTICAL_RESOLUTION_METERS, METERS_PER_DEG_LAT };
