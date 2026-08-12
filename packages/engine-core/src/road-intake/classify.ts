/**
 * Map OSM highway=* tag to v1 road classification (27c).
 */

import type { RoadClassification } from "@hauska-engine/atoms";

const OSM_TO_CLASS: Record<string, RoadClassification> = {
  motorway: "highway",
  motorway_link: "highway",
  trunk: "highway",
  trunk_link: "highway",
  primary: "highway",
  primary_link: "major_collector",
  secondary: "major_collector",
  secondary_link: "major_collector",
  tertiary: "minor_collector",
  tertiary_link: "minor_collector",
  residential: "residential",
  living_street: "residential",
  unclassified: "unclassified",
  service: "alley",
  track: "gravel",
  path: "gravel",
};

/** OSM lifecycle tags that must not mint pavement-asserting road atoms. */
export const NON_PAVEMENT_OSM_HIGHWAY_TAGS = new Set([
  "proposed",
  "construction",
]);

export function isNonPavementOsmHighwayTag(highwayTag: string | undefined): boolean {
  return NON_PAVEMENT_OSM_HIGHWAY_TAGS.has((highwayTag ?? "").trim().toLowerCase());
}

export function classifyOsmHighwayTag(
  highwayTag: string | undefined,
  tags?: Record<string, string>,
): RoadClassification {
  const normalized = (highwayTag ?? "").trim().toLowerCase();
  if (!normalized) return "unclassified";
  if (normalized === "service" && tags?.surface === "unpaved") {
    return "gravel";
  }
  return OSM_TO_CLASS[normalized] ?? "unclassified";
}

export function assumedRowWidthFt(
  classification: RoadClassification,
  table: import("./types.js").AssumedRowWidthTable,
): number {
  return table[classification];
}
