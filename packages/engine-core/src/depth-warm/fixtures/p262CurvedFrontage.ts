/**
 * P-262 curved-frontage fixtures — REAL rings, REAL centerlines, read live.
 *
 * Two lots in LA CIMA PHASE 4, BLOCK A (San Marcos, Hays County, TX), from
 *   https://services5.arcgis.com/bVphnK8rPe5MHUSr/arcgis/rest/services/Hays_County_Parcels/FeatureServer/0
 *   outFields=*, returnGeometry=true, outSR=4326, f=geojson, fetched
 *   2026-09-16. Rings and situs strings below are those responses verbatim.
 * Street centerlines: OSM Overpass (overpass-api.de), way[highway] in the
 *   parcels' own bbox, fetched in the same window; way ids, tags and geometry
 *   are carried verbatim. FOUR ways cover both lots — Knockout Rose Drive is
 *   the street both are addressed on.
 *
 * WHY THESE TWO TOGETHER. "Curved frontage handled as one front" is a claim
 * about WHICH edges the front covers, so a fixture for it must carry a real
 * curve that really fronts a street — and, in the same subdivision, a real
 * curve that does NOT front one, or the rule cannot be told from "call every
 * curve front". 324 KNOCKOUT ROSE is the positive case; 312 KNOCKOUT ROSE is
 * the negative control.
 *
 * 324 KNOCKOUT ROSE DR (prop_id 191443, Lot 62, 0.298 acres) — POSITIVE:
 *   THE FRONTAGE IS A CURVE. Measured on the ring below (13 edges, metres,
 *   distance = edge midpoint to the Knockout Rose Drive centerline):
 *
 *     edge  len    dist   turn at its start vertex
 *      0    42.20  35.0    70.2  <-- side line, back of the lot
 *      1    24.34  55.4    91.0  <-- side line
 *      2    51.37  29.5    88.8  <-- side line
 *      3     9.77   3.8    90.9  <-- frontage, first chord
 *      4     0.84   3.9    11.2  <-- frontage, curve
 *      5     0.84   4.2     9.2
 *      6     0.84   4.6     9.2
 *      7     0.84   5.1     9.2
 *      8     0.84   5.7     9.2
 *      9     3.42   7.3     1.3
 *     10     3.42   9.7     9.2
 *     11     3.42  11.7     9.2
 *     12     3.42  13.2     9.2
 *
 *   Edges 3-12 (3.8 m to 13.2 m off the centerline, the distance growing as
 *   the curve wraps away from the street; every other street is 120 m+) are ONE
 *   curved frontage. The curve's own turns are 11.2 and 9.2 degrees, so the
 *   10-degree logical-edge grouping splits it at edge 3 (11.2 > 10) — exactly
 *   the case a chord-or-line-only labeller gets wrong: the nearest chord wins
 *   front and the other ~30 m of frontage is handed a 5 ft side setback.
 *
 * 312 KNOCKOUT ROSE DR (prop_id 191446, Lot 65, 0.246 acres) — NEGATIVE
 *   CONTROL: a curve that is NOT the frontage. Measured on its ring (7 edges):
 *
 *     edge  len    dist   turn at its start vertex
 *      0    10.36  41.8    89.2
 *      1    12.80  43.8    16.6  <-- curved line at the BACK of the lot
 *      2     3.57  45.8    27.8  <-- curved line at the BACK of the lot
 *      3    41.74  24.7    82.1
 *      4    11.89   3.7    89.7  <-- frontage (straight)
 *      5    12.34   3.9     1.0  <-- frontage, 1-degree artifact turn
 *      6    37.64  22.9    88.7
 *
 *   Its 3-chord curve (16.6 and 27.8 degree turns, 26.73 m) sits 41.8-45.8 m
 *   off the street: no front rule may claim it, and the logical-edge grouping
 *   must NOT fuse it (fusing would report a curve as one straight line). Its
 *   actual frontage is edges 4-5, which the 1.0-degree artifact turn makes ONE
 *   logical line of 24.23 m — the clean case of grouping done right.
 */

import type { WarmRoadSource } from "../types.js";
import type { Ring } from "../geometry.js";

/** 324 KNOCKOUT ROSE DR, SAN MARCOS, TX 78666 — 13 edges, curved frontage. */
export const PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS: Ring = [
  [-97.9994040291237, 29.8860540523707],
  [-97.9991979570625, 29.8857192777731],
  [-97.9994228156258, 29.8856197169046],
  [-97.9996753760669, 29.8860265478793],
  [-97.9995854268398, 29.8860670055802],
  [-97.9995770765859, 29.8860691159055],
  [-97.9995684470077, 29.8860700431282],
  [-97.9995597588882, 29.886069761827],
  [-97.9995512316478, 29.8860682799534],
  [-97.9995430844146, 29.8860656352299],
  [-97.999509563409, 29.8860555032048],
  [-97.9994746228374, 29.8860501252682],
  [-97.9994391466035, 29.8860496370283],
  [-97.9994040291237, 29.8860540523707],
];

export const SITUS_324_KNOCKOUT_ROSE = "324 KNOCKOUT ROSE DR, SAN MARCOS, TX 78666";

/** 312 KNOCKOUT ROSE DR, SAN MARCOS, TX 78666 — 7 edges, curve at the BACK. */
export const PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS: Ring = [
  [-97.9999852311507, 29.8855279440019],
  [-98.0000848089695, 29.8854928313099],
  [-98.0001883795494, 29.8854208389296],
  [-98.0002247439196, 29.8854147824916],
  [-98.000364057251, 29.8857701506325],
  [-98.0002475377746, 29.8858051373249],
  [-98.0001273574575, 29.8858432598628],
  [-97.9999852311507, 29.8855279440019],
];

export const SITUS_312_KNOCKOUT_ROSE = "312 KNOCKOUT ROSE DR, SAN MARCOS, TX 78666";

/** Real OSM highway ways around both lots (Overpass, 2026-09-16). */
export const ROADS_AROUND_KNOCKOUT_ROSE: WarmRoadSource[] = [
  {
    osmWayId: 1207193314,
    osmHighwayTag: "residential",
    name: "Knockout Rose Drive",
    classification: "residential" as const,
    polyline: [
      [-98.0046513, 29.8868396],
      [-98.0041891, 29.8863734],
      [-98.0041287, 29.8863216],
      [-98.0040351, 29.8862412],
      [-98.0033607, 29.8857186],
      [-98.0031028, 29.8854991],
      [-98.0029324, 29.8853942],
      [-98.0028109, 29.885326],
      [-98.0026626, 29.8852833],
      [-98.0025146, 29.8852572],
      [-98.0023509, 29.8852517],
      [-98.0022335, 29.8852612],
      [-98.0020482, 29.8853044],
      [-98.0018383, 29.8853746],
      [-98.0008483, 29.885669],
      [-98.0002698, 29.8858335],
      [-97.9999308, 29.8859498],
      [-97.999798, 29.8860105],
      [-97.9996086, 29.8860951],
      [-97.99944, 29.8861802],
    ],
  },
  {
    osmWayId: 1207193316,
    osmHighwayTag: "residential",
    name: "Big Muhly Pass",
    classification: "residential" as const,
    polyline: [
      [-98.0027427, 29.8881633],
      [-98.0021961, 29.8874629],
      [-98.0021492, 29.8873017],
      [-98.0021268, 29.8871653],
      [-98.0021316, 29.8870073],
      [-98.0021491, 29.8868875],
      [-98.0021877, 29.8866025],
      [-98.0022029, 29.8864357],
      [-98.0021923, 29.8863505],
      [-98.0021416, 29.8861385],
      [-98.0018383, 29.8853746],
    ],
  },
  {
    osmWayId: 1207193317,
    osmHighwayTag: "residential",
    name: "Cherokee Sedge Pass",
    classification: "residential" as const,
    polyline: [
      [-98.0008483, 29.885669],
      [-98.0010204, 29.8860886],
      [-98.0010606, 29.8862558],
      [-98.001067, 29.8863724],
      [-98.0010607, 29.8865129],
      [-98.0009995, 29.886696],
    ],
  },
  {
    osmWayId: 1495606499,
    osmHighwayTag: "residential",
    name: "Crabapple Court",
    classification: "residential" as const,
    polyline: [
      [-98.0058394, 29.8805238],
      [-98.0054925, 29.8807198],
      [-98.0050353, 29.8810342],
      [-98.0046922, 29.88133],
      [-98.0035699, 29.8822976],
      [-98.0026673, 29.8830759],
      [-98.002213, 29.8834675],
      [-98.0020028, 29.8836726],
      [-98.0017295, 29.8840873],
    ],
  },
];

/* Back-compat aliases: the 312 fixture shipped under these names first. */
export const ROADS_AROUND_312_KNOCKOUT_ROSE = ROADS_AROUND_KNOCKOUT_ROSE;
