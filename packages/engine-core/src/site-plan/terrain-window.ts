import {
  bboxMetersExtent,
  FINEST_PRACTICAL_RESOLUTION_METERS,
  MIN_PIXELS_PER_AXIS,
  type BboxWgs84,
} from "@hauska-engine/adapters";

/**
 * The DEM fetch window for a parcel.
 *
 * `selectAdaptiveResolutionMeters` refuses a raster below the adapter's
 * per-axis pixel floor ({@link MIN_PIXELS_PER_AXIS} at the finest practical
 * {@link FINEST_PRACTICAL_RESOLUTION_METERS} 3DEP resolution). That refusal is
 * CORRECT for the fetch: a nine-row raster is not a useful DEM request, and
 * the adapter is right to decline rather than oversample 3DEP past the
 * resolution the source actually carries.
 *
 * What was wrong is that the refusal propagated out as a whole site-plan
 * export failure. A parcel whose short axis is under
 * `MIN_PIXELS_PER_AXIS x FINEST_PRACTICAL_RESOLUTION_METERS` metres (~16m
 * today) could not produce a site plan, and because the Feasibility model
 * requires a site plan, it could not produce a Feasibility report either.
 * Downtown lots, condo units and narrow infill parcels are all in that class.
 * Present since the site-plan path was created (#116); latent until a narrow
 * lot was opened.
 *
 * The remedy is the one `flood-drainage-study.ts` already applies through
 * `paddedCatchmentBbox`: fetch the DEM over a window LARGER than the parcel,
 * from real 3DEP samples at the real source resolution, rather than asking for
 * sub-metre elevation the source does not have. Nothing is fabricated; the
 * window is simply wider than the lot.
 *
 * Two properties this deliberately holds:
 *
 * 1. **No-op for every parcel that already works.** An axis at or above the
 *    required extent is returned untouched, so no currently-succeeding export
 *    changes shape. The blast radius is exactly the set of parcels that
 *    previously got nothing.
 * 2. **Minimal expansion.** Only a deficient axis grows, and only to the
 *    required extent, centred on the parcel. The 27m long axis of a 27m x 9m
 *    lot is left alone; only the 9m axis moves.
 *
 * The returned bbox is the DEM extent, the mesh extent, the contour extent AND
 * the local-ENU frame anchor. Those four must stay mutually consistent, so
 * callers pass this one bbox to all of them and never mix it with the raw
 * parcel bbox.
 */
export interface TerrainWindowResult {
  /** The bbox to fetch the DEM over, and to anchor mesh/contours/ENU to. */
  bbox: BboxWgs84;
  /** True when the parcel bbox was below the adapter's per-axis floor. */
  expanded: boolean;
  /**
   * Human-readable statement of the expansion, for provenance and for the
   * sheet. Present only when {@link expanded} is true: degradation is
   * declared in the output, never silent.
   */
  reason?: string;
}

/**
 * Smallest metric extent per axis at which {@link MIN_PIXELS_PER_AXIS} can be
 * met, given a caller's requested resolution.
 *
 * `selectAdaptiveResolutionMeters` auto-TIGHTENS a too-coarse request down to
 * {@link FINEST_PRACTICAL_RESOLUTION_METERS}, so the binding floor is set by
 * the finest resolution the selector can reach, not by what was requested. A
 * 5m/px request on a small parcel still only needs the 1m/px extent, because
 * the selector tightens to 1m/px on its own rather than failing.
 */
export function requiredWindowExtentMeters(resolutionMetersRequested: number): number {
  const finest = Math.min(resolutionMetersRequested, FINEST_PRACTICAL_RESOLUTION_METERS);
  return MIN_PIXELS_PER_AXIS * finest;
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * Expand `parcelBbox` to the smallest window that satisfies the adapter's
 * per-axis pixel floor, centred on the parcel. Axes already at or above the
 * required extent are returned unchanged.
 */
export function resolveTerrainWindowBbox(
  parcelBbox: BboxWgs84,
  resolutionMetersRequested: number,
): TerrainWindowResult {
  const requiredM = requiredWindowExtentMeters(resolutionMetersRequested);
  const { widthM, heightM } = bboxMetersExtent(parcelBbox);

  const widthShortfallM = requiredM - widthM;
  const heightShortfallM = requiredM - heightM;
  if (widthShortfallM <= 0 && heightShortfallM <= 0) {
    return { bbox: parcelBbox, expanded: false };
  }

  const meanLat = (parcelBbox.southLat + parcelBbox.northLat) / 2;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((meanLat * Math.PI) / 180);

  // Half the shortfall on each side keeps the parcel centred in the window.
  const padLngDeg = widthShortfallM > 0 ? widthShortfallM / 2 / metersPerDegLng : 0;
  const padLatDeg = heightShortfallM > 0 ? heightShortfallM / 2 / METERS_PER_DEG_LAT : 0;

  const bbox: BboxWgs84 = {
    westLng: parcelBbox.westLng - padLngDeg,
    eastLng: parcelBbox.eastLng + padLngDeg,
    southLat: parcelBbox.southLat - padLatDeg,
    northLat: parcelBbox.northLat + padLatDeg,
  };

  const grown: string[] = [];
  if (widthShortfallM > 0) {
    grown.push(`east-west from ${widthM.toFixed(1)}m to ${requiredM}m`);
  }
  if (heightShortfallM > 0) {
    grown.push(`north-south from ${heightM.toFixed(1)}m to ${requiredM}m`);
  }

  return {
    bbox,
    expanded: true,
    reason:
      `Parcel is below the ${MIN_PIXELS_PER_AXIS}px-per-axis DEM floor at ` +
      `${FINEST_PRACTICAL_RESOLUTION_METERS}m/px, so terrain was fetched over a window widened ` +
      `${grown.join(" and ")}, centred on the parcel. Elevation is real 3DEP data at source ` +
      `resolution over a wider area, not interpolated to a finer grid than the source carries. ` +
      `Contours and the drawing frame extend past the property line by that margin.`,
  };
}
