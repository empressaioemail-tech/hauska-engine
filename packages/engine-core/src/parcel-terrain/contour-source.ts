/**
 * Contour source resolver (qa/topo-fidelity-1ft, 2026-07-27).
 *
 * Serves the terrain contour-rendering consumers (DXF contours + site-plan
 * contours/labels) with the BEST available contour tier for a bbox:
 *
 *   1. AUTHORITATIVE: Bastrop County 1-ft contours (2017 StratMap LiDAR) where
 *      the bbox intersects the county footprint and the live service returns
 *      geometry. Elevations are metres NAVD88 (converted from US survey feet by
 *      the adapter); geometry is projected into the SAME local-ENU frame the
 *      mesh and site-model use, so CAD/PDF cannot diverge.
 *   2. FALLBACK: 3DEP-derived d3-contour lines (existing behaviour) for any
 *      bbox outside Bastrop, when the county fetch is empty, or when it fails.
 *
 * This resolver DELIBERATELY does not touch the mesh Z. The mesh still comes
 * from the 3DEP DEM and stays gated by `assertTerrainElevationIntegrity`; only
 * the contour LINES are upgraded to the authoritative source where available.
 * That keeps the integrity gate valid (no contour-derived Z is fed into the
 * mesh) while giving Bastrop true 1-ft contour fidelity.
 */

import {
  fetchBastropCountyContours,
  bastropContourCoverage,
  BASTROP_CONTOUR_SOURCE,
  BASTROP_CONTOUR_VINTAGE,
  BASTROP_CONTOUR_INTERVAL_LABEL,
  type BboxWgs84,
} from "@hauska-engine/adapters";

import type { ParsedDem } from "../site-topography/index.js";
import { collectContourPolylines, type ContourPolyline2d } from "./emitters.js";
import { projectWgs84ToLocalEnu } from "./mesh.js";

export interface ContourSourceProvenance {
  /** Stable tier id. */
  tier: "authoritative-1ft" | "derived-3dep";
  /** Source citation (e.g. `bastrop-county:Contour1Ft2017` or `usgs:3dep-dem`). */
  source: string;
  /** Human vintage label. */
  vintage: string;
  /** Vertical interval label. */
  intervalLabel: string;
  /** Polyline count actually produced. */
  polylineCount: number;
  /** Present only on the 3DEP fallback: reason we did not use the finer tier. */
  fallbackReason?: string;
}

export interface ResolvedContours {
  polylines: ContourPolyline2d[];
  provenance: ContourSourceProvenance;
}

export interface ResolveContourSourceOptions {
  dem: ParsedDem;
  bbox: BboxWgs84;
  contourIntervalMeters: number;
  /** Test seam: inject the county fetch. Defaults to the live adapter. */
  fetchCountyContours?: typeof fetchBastropCountyContours;
  /** Test seam: inject the 3DEP-derived collector. Defaults to the real one. */
  collectDerived?: typeof collectContourPolylines;
}

function derivedFallback(
  opts: ResolveContourSourceOptions,
  fallbackReason: string,
): ResolvedContours {
  const collect = opts.collectDerived ?? collectContourPolylines;
  const polylines = collect(opts.dem, opts.bbox, opts.contourIntervalMeters);
  return {
    polylines,
    provenance: {
      tier: "derived-3dep",
      source: "usgs:3dep-dem",
      vintage: "USGS 3DEP (national mosaic)",
      intervalLabel: `${opts.contourIntervalMeters}-m interval (derived)`,
      polylineCount: polylines.length,
      fallbackReason,
    },
  };
}

/**
 * Resolve the best contour tier for the bbox. Authoritative Bastrop 1-ft where
 * available, else honest 3DEP-derived fallback. Never throws on a county-fetch
 * failure — it degrades to 3DEP with the failure recorded in provenance.
 */
export async function resolveContourSource(
  opts: ResolveContourSourceOptions,
): Promise<ResolvedContours> {
  if (!bastropContourCoverage(opts.bbox)) {
    return derivedFallback(opts, "bbox outside Bastrop County 1-ft footprint");
  }

  const fetchCounty = opts.fetchCountyContours ?? fetchBastropCountyContours;
  let county;
  try {
    county = await fetchCounty(opts.bbox);
  } catch (err) {
    return derivedFallback(
      opts,
      `Bastrop 1-ft fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!county.polylines.length) {
    return derivedFallback(
      opts,
      "Bastrop 1-ft service returned no contours intersecting this bbox",
    );
  }

  // Project county WGS84 vertices into the SAME local-ENU metre frame the mesh
  // and site-model use, so DXF and PDF contours register with the parcel ring.
  const polylines: ContourPolyline2d[] = county.polylines.map((line) => ({
    elevation: line.elevationMeters,
    // ArcGIS Contour1Ft2017 paths are open LineStrings — never seal in DXF.
    closed: false,
    points: line.points.map(([lng, lat]) => {
      const { x, y } = projectWgs84ToLocalEnu(lng, lat, opts.bbox);
      return [x, y] as [number, number];
    }),
  }));

  return {
    polylines,
    provenance: {
      tier: "authoritative-1ft",
      source: BASTROP_CONTOUR_SOURCE,
      vintage: BASTROP_CONTOUR_VINTAGE,
      intervalLabel: BASTROP_CONTOUR_INTERVAL_LABEL,
      polylineCount: polylines.length,
    },
  };
}
