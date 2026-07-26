/**
 * Live-shaped road fixtures for 48021:34785 (1009 Chestnut St).
 * Collector on south edge; local unclassified on west (Chestnut frontage).
 * Optional footway closer to south edge — must not affect front outcome (FIX 2.1).
 */

import type { WarmRoadSource } from "../types.js";

/** Bastrop secondary collector along south ROW (edge 0). */
export const ROAD_34785_SOUTH_COLLECTOR: WarmRoadSource = {
  osmWayId: 3478501,
  osmHighwayTag: "secondary",
  name: "Collector",
  classification: "major_collector",
  polyline: [
    [-97.31547, 30.11005],
    [-97.31547, 30.11052],
  ],
};

/** Local unclassified Chestnut St along west ROW (edge 3 — front). */
export const ROAD_34785_WEST_UNCLASSIFIED: WarmRoadSource = {
  osmWayId: 3478502,
  osmHighwayTag: "unclassified",
  name: "Chestnut St",
  classification: "unclassified",
  polyline: [
    [-97.31528, 30.11007],
    [-97.31528, 30.11051],
  ],
};

/** Pedestrian footway closer to south edge — ineligible for front. */
export const ROAD_34785_SOUTH_FOOTWAY: WarmRoadSource = {
  osmWayId: 3478503,
  osmHighwayTag: "footway",
  name: "Sidewalk",
  classification: "unclassified",
  polyline: [
    [-97.31545, 30.11006],
    [-97.31545, 30.11051],
  ],
};

export const ROAD_34785_CORE_SET: WarmRoadSource[] = [
  ROAD_34785_SOUTH_COLLECTOR,
  ROAD_34785_WEST_UNCLASSIFIED,
];
