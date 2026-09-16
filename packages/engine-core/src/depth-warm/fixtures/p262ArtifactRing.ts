/**
 * P-262 fixture — a SYNTHETIC ring with artifact vertices, against its own
 * clean control.
 *
 * WHY SYNTHETIC, when every other fixture in this lane is a live county read:
 * the dispatch asks for "a ring with artifact vertices" beside the real ones.
 * The real rings DO carry artifact runs (48209:97658 has three collinear runs
 * and no duplicate vertex; the two Knockout Rose rings carry the curve), but no
 * real ring gives the labeller the same lot twice — once clean and once with
 * artifacts — so no real ring can state the invariant that matters:
 *
 *   artifact vertices change the SCRUB's counts and nothing else.
 *
 * This pair states it: the same 40 m x 20 m lot twice, once with four corners
 * and once with the SAME four corners plus one duplicate vertex (0.2 m from its
 * neighbour, inside P262_DUPLICATE_VERTEX_TOL_M = 0.5) and two near-collinear
 * vertices (0.05 m off the line, a 0.14 degree turn, inside
 * P262_COLLINEAR_VERTEX_TOL_DEG = 1.0). The road is synthetic too and says so
 * below. Nothing here is presented as a live read; the live reads are
 * fixtures/p262Parcels.ts and fixtures/p262CurvedFrontage.ts.
 *
 * The rings are built in METRES about a fixed origin and converted through the
 * same spherical frame the production projection uses, so "0.05 m off the line"
 * is exact rather than a hand-rounded decimal degree.
 */

import type { WarmRoadSource } from "../types.js";
import type { Ring } from "../geometry.js";

const EARTH_RADIUS_M = 6_378_137;
const LNG0 = -97.5;
const LAT0 = 30;

/** Metres about (LNG0, LAT0) -> a closed WGS84 ring. */
function ringFromMetres(points: ReadonlyArray<readonly [number, number]>): Ring {
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const toLngLat = ([x, y]: readonly [number, number]): [number, number] => [
    LNG0 + x / mPerDegLng,
    LAT0 + y / mPerDegLat,
  ];
  return [...points.map(toLngLat), toLngLat(points[0]!)];
}

/**
 * The clean control: a 40 m x 20 m rectangle, its 40 m edge facing a road 6 m
 * to the south. Four corners, four edges, no artifact.
 */
export const PARCEL_ARTIFACT_CLEAN: Ring = ringFromMetres([
  [0, 0],
  [40, 0],
  [40, 20],
  [0, 20],
]);

/**
 * The SAME lot with artifacts — the clean ring's corners are all still here,
 * and three vertices no lot line has:
 *   (12.0, 0) together with (12.2, 0)  — a 0.2 m duplicate on the front line;
 *   (25, 0.05)                         — 0.05 m off the front line (0.14 deg);
 *   (25, 19.95)                        — 0.05 m off the rear line (0.14 deg).
 * Eight edges: 0-3 are the front line, 4 the east side, 5-6 the rear line, 7
 * the west side.
 */
export const PARCEL_ARTIFACT_RING: Ring = ringFromMetres([
  [0, 0],
  [12, 0],
  [12.2, 0],
  [25, 0.05],
  [40, 0],
  [40, 20],
  [25, 19.95],
  [0, 20],
]);

/**
 * The address the synthetic lot is labelled by — it matches the synthetic
 * road's name below, so the situs-first front rule is exercised on this pair
 * the same way it is on the real parcels.
 */
export const SITUS_ARTIFACT_RING = "100 ARTIFACT TEST RD";

/**
 * The synthetic road: a straight centerline 6 m south of the lot's front line,
 * running the lot's whole width. `osmWayId: 0` is deliberate — this is NOT an
 * OSM way and no real way id is borrowed; the field is required by
 * WarmRoadSource and 0 cannot collide with a real OSM id.
 */
export const ROAD_ARTIFACT_TEST: WarmRoadSource = {
  osmWayId: 0,
  osmHighwayTag: "residential",
  name: "Artifact Test Road",
  classification: "residential",
  polyline: ringFromMetres([
    [-20, -6],
    [60, -6],
  ]).slice(0, 2),
};

export const ROADS_AROUND_ARTIFACT_RING: WarmRoadSource[] = [ROAD_ARTIFACT_TEST];
