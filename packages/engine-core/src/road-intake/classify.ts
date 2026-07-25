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
