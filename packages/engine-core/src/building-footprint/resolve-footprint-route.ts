/**
 * Statewide-uniform footprint adapter routing.
 *
 * No county-specific hardcoding — registry override is optional; when absent
 * every Texas county defaults to Microsoft Global ML Building Footprints.
 */

import {
  GLOBAL_ML_REPO_URL,
  GLOBAL_ML_TEXAS_ZIP_URL,
} from "./constants.js";
import type { FootprintAdapterKind, FootprintRoute } from "./types.js";

export interface ResolveFootprintRouteInput {
  footprintAdapterKind?: FootprintAdapterKind | null;
}

/**
 * Resolve the footprint rail for a county row. Precedence is frozen in the
 * registry when present; otherwise the T3 cohort default applies uniformly.
 */
export function resolveFootprintRoute(
  input: ResolveFootprintRouteInput = {},
): FootprintRoute {
  const kind = input.footprintAdapterKind ?? "ml-global-building-footprints";

  switch (kind) {
    case "honest-absence":
      return {
        adapterKind: "honest-absence",
        sourceTier: "absent",
        sourceUrl: "provenanceScope",
      };
    case "cad-footprint-rest":
    case "cad-footprint-bulk":
      return {
        adapterKind: kind,
        sourceTier: "cad-authoritative",
        sourceUrl: GLOBAL_ML_REPO_URL,
      };
    case "city-gis-footprint-rest":
      return {
        adapterKind: kind,
        sourceTier: "city-gis-authoritative",
        sourceUrl: GLOBAL_ML_REPO_URL,
      };
    case "ml-overture-buildings":
      return {
        adapterKind: kind,
        sourceTier: "ml-derived",
        sourceUrl: GLOBAL_ML_REPO_URL,
      };
    case "ml-global-building-footprints":
    default:
      return {
        adapterKind: "ml-global-building-footprints",
        sourceTier: "ml-derived",
        sourceUrl: GLOBAL_ML_TEXAS_ZIP_URL,
      };
  }
}
