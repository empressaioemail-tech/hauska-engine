/**
 * Map Bastrop County StreetsSurveyed2016 attributes → v1 road classification (27f S2-U1).
 *
 * Mapping table (authoritative county fields beat OSM proxy):
 *
 * | class | surface (contains)              | → classification   |
 * |-------|---------------------------------|--------------------|
 * | LS    | Unpaved/Gravel                  | gravel             |
 * | LS    | Not Maintained                  | gravel             |
 * | LS    | Two Course/Paved                | residential        |
 * | LS    | Hotmix/Asphalt                  | residential        |
 * | LS    | Concrete                        | residential        |
 * | LS    | Recycled Asphalt / RAP          | residential        |
 * | LS    | Non County (US, State, City)    | major_collector    |
 * | DW    | Hotmix/Asphalt                  | minor_collector    |
 * | DW    | Not Maintained                  | gravel             |
 * | DW    | Undefined                       | unclassified       |
 * | *     | (fallback) surface flags        | see flags below    |
 */

import type { RoadClassification } from "@hauska-engine/atoms";

export interface CountyStreetAttributes {
  class?: string | null;
  rdcls_typ?: string | null;
  surface?: string | null;
  road_paved?: number | null;
  road_grave?: number | null;
  road_hotmi?: number | null;
  road_seale?: number | null;
  surface_wi?: number | null;
  row_notes?: string | null;
  full_name?: string | null;
  st_name?: string | null;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function surfaceFlags(attrs: CountyStreetAttributes): RoadClassification | null {
  if ((attrs.road_grave ?? 0) > 0) return "gravel";
  if ((attrs.road_hotmi ?? 0) > 0 || (attrs.road_paved ?? 0) > 0 || (attrs.road_seale ?? 0) > 0) {
    return norm(attrs.class) === "dw" ? "minor_collector" : "residential";
  }
  return null;
}

export function classifyCountyStreetAttributes(
  attrs: CountyStreetAttributes,
): RoadClassification {
  const cls = norm(attrs.class);
  const surface = norm(attrs.surface);
  const rdcls = norm(attrs.rdcls_typ);

  if (surface.includes("gravel") || surface.includes("unpaved") || surface.includes("not maintained")) {
    return "gravel";
  }
  if (surface.includes("non county")) {
    return "major_collector";
  }
  if (cls === "dw") {
    if (surface.includes("hotmix") || surface.includes("asphalt")) return "minor_collector";
    if (surface.includes("undefined") || !surface) return "unclassified";
    return "minor_collector";
  }
  if (cls === "ls" || !cls) {
    if (
      surface.includes("two course") ||
      surface.includes("paved") ||
      surface.includes("hotmix") ||
      surface.includes("asphalt") ||
      surface.includes("concrete") ||
      surface.includes("rap")
    ) {
      return "residential";
    }
  }
  if (rdcls.includes("alley")) return "alley";
  if (rdcls.includes("highway") || rdcls.includes("arterial")) return "highway";
  if (rdcls.includes("collector")) return "minor_collector";

  const fromFlags = surfaceFlags(attrs);
  if (fromFlags) return fromFlags;

  return "unclassified";
}

export const COUNTY_ROAD_ID_OFFSET = 900_000_000;

export function countyRoadSyntheticWayId(objectId: number): number {
  return COUNTY_ROAD_ID_OFFSET + objectId;
}

export function isCountySyntheticWayId(wayId: number): boolean {
  return wayId >= COUNTY_ROAD_ID_OFFSET;
}
