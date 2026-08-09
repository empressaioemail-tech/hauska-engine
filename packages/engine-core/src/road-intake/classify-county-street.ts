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

/** Bastrop_County_Roadway layer attributes (27f S2-F — city + county grid). */
export interface BastropRoadwayAttributes extends CountyStreetAttributes {
  owner?: string | null;
  l_muni?: string | null;
  r_muni?: string | null;
  surface_width?: number | null;
  road_gravel_year?: number | null;
  road_hotmix_year?: number | null;
  road_paved_year?: number | null;
  road_repaved_year?: number | null;
  road_sealed_year?: number | null;
  road_rap_year?: number | null;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Surface field is populated and not the layer's Undefined sentinel. */
export function isDefinedCountySurface(surface: string | null | undefined): boolean {
  const s = norm(surface);
  return s.length > 0 && s !== "undefined";
}

/** Implicit surface signal from maintenance-year fields (roadway layer). */
export function bastropRoadwayHasImplicitSurfaceSignal(
  attrs: BastropRoadwayAttributes,
): boolean {
  return (
    (attrs.road_gravel_year != null && Number(attrs.road_gravel_year) > 0) ||
    (attrs.road_hotmix_year != null && Number(attrs.road_hotmix_year) > 0) ||
    (attrs.road_paved_year != null && Number(attrs.road_paved_year) > 0) ||
    (attrs.road_repaved_year != null && Number(attrs.road_repaved_year) > 0) ||
    (attrs.road_sealed_year != null && Number(attrs.road_sealed_year) > 0) ||
    (attrs.road_rap_year != null && Number(attrs.road_rap_year) > 0)
  );
}

/**
 * Authoritative for labeling only when surface is defined (not Undefined/empty)
 * or an implicit surface-year signal exists. Undefined surface + LS class alone
 * is NOT authoritative (S2-F amendment — schema≠data).
 */
export function bastropRoadwayIsAuthoritative(attrs: BastropRoadwayAttributes): boolean {
  return isDefinedCountySurface(attrs.surface) || bastropRoadwayHasImplicitSurfaceSignal(attrs);
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

export const COUNTY_ROAD_ID_OFFSET = -900_000_000;
export const COUNTY_ROADWAY_ID_OFFSET = -800_000_000;

/** Legacy positive bands — live Bastrop rows minted before F5 partition. */
export const LEGACY_COUNTY_ROAD_ID_OFFSET = 900_000_000;
export const LEGACY_COUNTY_ROADWAY_ID_OFFSET = 800_000_000;

export function countyRoadSyntheticWayId(objectId: number): number {
  return COUNTY_ROAD_ID_OFFSET - objectId;
}

export function countyRoadwaySyntheticWayId(objectId: number): number {
  return COUNTY_ROADWAY_ID_OFFSET - objectId;
}

export function isLegacyCountySyntheticWayId(wayId: number): boolean {
  return (
    (wayId >= LEGACY_COUNTY_ROADWAY_ID_OFFSET &&
      wayId < LEGACY_COUNTY_ROAD_ID_OFFSET) ||
    wayId >= LEGACY_COUNTY_ROAD_ID_OFFSET
  );
}

export function isCountySyntheticWayId(wayId: number): boolean {
  return wayId < 0 && wayId <= COUNTY_ROADWAY_ID_OFFSET;
}

export function isCountyRoadwaySyntheticWayId(wayId: number): boolean {
  if (wayId < 0) {
    return wayId <= COUNTY_ROADWAY_ID_OFFSET && wayId > COUNTY_ROAD_ID_OFFSET;
  }
  return (
    wayId >= LEGACY_COUNTY_ROADWAY_ID_OFFSET && wayId < LEGACY_COUNTY_ROAD_ID_OFFSET
  );
}

/**
 * Map Bastrop_County_Roadway attributes → v1 road classification (27f S2-F).
 * Extends StreetsSurveyed2016 mapping with owner/muni/gravel-year signals.
 */
export function classifyBastropRoadwayAttributes(
  attrs: BastropRoadwayAttributes,
): RoadClassification {
  const surface = norm(attrs.surface);
  const rdcls = norm(attrs.rdcls_typ);
  const owner = norm(attrs.owner);

  if (rdcls.includes("alley")) return "alley";
  if (
    surface.includes("gravel") ||
    surface.includes("unpaved") ||
    surface.includes("not maintained")
  ) {
    return "gravel";
  }
  if (attrs.road_gravel_year != null && Number(attrs.road_gravel_year) > 0) {
    return "gravel";
  }
  if (rdcls.includes("major arterial") || rdcls.includes("freeway")) {
    return "highway";
  }
  if (rdcls.includes("minor arterial")) return "major_collector";
  if (rdcls.includes("collector")) return "minor_collector";
  if (owner.includes("state") || owner.includes("federal")) return "major_collector";
  if (
    surface.includes("paved") ||
    surface.includes("hotmix") ||
    surface.includes("asphalt") ||
    surface.includes("concrete") ||
    attrs.road_hotmix_year != null ||
    attrs.road_paved_year != null ||
    attrs.road_repaved_year != null
  ) {
    return rdcls.includes("collector") ? "minor_collector" : "residential";
  }
  if (surface.includes("undefined") || !surface) {
    if (rdcls.includes("local")) return "unclassified";
  }

  return classifyCountyStreetAttributes(attrs);
}
