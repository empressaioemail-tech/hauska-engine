/**
 * Authoritative OSM highway tags treated as pedestrian / non-ROW ways.
 * Shared by road-node emit (`isPedestrianWay`), frontage eligibility, and
 * map render. Do not re-list these tags in product code — import from here
 * or from engine-core's FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS re-export.
 */

export const PEDESTRIAN_OSM_HIGHWAY_TAGS = [
  "footway",
  "path",
  "steps",
  "cycleway",
  "pedestrian",
  "bridleway",
  "corridor",
  "platform",
  "bus_guideway",
  "proposed",
  "construction",
] as const;

export type PedestrianOsmHighwayTag = (typeof PEDESTRIAN_OSM_HIGHWAY_TAGS)[number];

export const PEDESTRIAN_OSM_HIGHWAY_TAG_SET: ReadonlySet<string> = new Set(
  PEDESTRIAN_OSM_HIGHWAY_TAGS,
);

export function isPedestrianOsmHighwayTag(
  highwayTag: string | undefined | null,
): boolean {
  const tag = highwayTag?.trim().toLowerCase() ?? "";
  return tag.length > 0 && PEDESTRIAN_OSM_HIGHWAY_TAG_SET.has(tag);
}
