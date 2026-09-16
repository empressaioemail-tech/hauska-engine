/**
 * P-262 fixtures — REAL parcel rings and REAL street centerlines.
 *
 * Both parcels are the dispatch's own: San Marcos 48209:97658 (629 Sturgeon Dr,
 * SF-6, setbacks 25/5/20/15) and Pflugerville 48453:427599 (203 E Oxford Dr).
 *
 * Rings were read from the LIVE county services on 2026-09-16, never from a
 * cached layer — the dispatch's own instruction ("Read the parcels' real rings
 * from the store or the county service; never from a cached layer (it has
 * holes)"). Each block names its service, the query, the fetch timestamp and
 * the service's own area, so any reader can re-fetch and compare rather than
 * trusting this file.
 *
 * Street centerlines are OSM Overpass ways, read live in the same window, and
 * are carried exactly as the engine already receives road sources (osmWayId,
 * osmHighwayTag, name, classification, polyline). A-177 is respected: no
 * road-name dictionary and no road-class rule is built here, and nothing in
 * this file is a new rail.
 */

import type { WarmRoadSource } from "../types.js";
import type { Ring } from "../geometry.js";

/**
 * 48209:97658 — 629 STURGEON DR, SAN MARCOS, TX 78666.
 *
 * Source: https://services5.arcgis.com/bVphnK8rPe5MHUSr/arcgis/rest/services/Hays_County_Parcels/FeatureServer/0
 *   (Hays County GIS, owner HaysCountyGIS, layer countygis.DBO.Parcels,
 *   native SR 102740/2278), where prop_id=97658, returnGeometry=true,
 *   outSR=4326, f=geojson. Fetched 2026-09-16T20:16Z.
 * Service row as fetched: OBJECTID 118321, situs_num 629, situs_street
 *   STURGEON, situs_street_sufix DR, situs_city SAN MARCOS, situs_zip 78666,
 *   legal_acreage 0.19, legal_desc "CONWAY ADDITION SEC IV, BLOCK 1, LOT 11,
 *   ACRES 0.19", Shape__Area 8584.1484375 sq ft.
 *
 * The ledger truth read for the same parcel (doc_repo
 * _inbox/2026-09-16_ledger-truth-parcel-48209-97658.json) independently agrees:
 *   situsAddress "629 STURGEON DR, SAN MARCOS, TX 78666", legalDescription
 *   "CONWAY ADDITION SEC IV, BLOCK 1, LOT 11, ACRES 0.19", acreageAcres 0.1900,
 *   zoningDistrict SF-6, zoningJurisdictionKey san-marcos-tx,
 *   setbackFrontFt 25 / setbackSideFt 5 / setbackRearFt 20 / setbackCornerFt 15,
 *   parcelAreaSqFt 8585.79 (the ledger's own ring area, 1.6 sq ft from this
 *   service's Shape__Area — the two were read from different vintages and I
 *   record both rather than picking one).
 *
 * THE SHAPE THAT MATTERS (this is why the parcel is the defect):
 * 9 edges, of which the county digitisation carries three collinear runs —
 *   e8,e0,e1 all bearing 135.2 deg (2.14 + 42.11 + 3.44 = 47.69 m, ONE long
 *     side line),
 *   e3,e4,e5 all bearing -44.8 deg (3.53 + 41.98 + 2.10 = 47.61 m, the
 *     OPPOSITE long side line),
 *   e6,e7 both bearing 45.2 deg (11.50 + 5.29 = 16.79 m, the FAR end line),
 *   e2 alone (bearing -134.6 deg, 16.80 m, the NEAR end line — the Sturgeon
 *     frontage).
 * Every turn INSIDE a run measures 0.0 degrees; every real corner measures
 * ~90 degrees. A labeller that labels chords instead of lot lines hands
 * different setbacks to two chords of one line, which is the collapse the
 * dispatch reports.
 */
export const PARCEL_48209_97658_SAN_MARCOS: Ring = [
  [-97.925972064798, 29.8720682852057],
  [-97.9256648156349, 29.8717997316522],
  [-97.9256397413157, 29.8717778338329],
  [-97.9257636638545, 29.8716719051342],
  [-97.9257894592033, 29.8716944420755],
  [-97.9260957706688, 29.8719621893658],
  [-97.9261110905976, 29.8719755947455],
  [-97.9260265481489, 29.8720484263016],
  [-97.9259876681067, 29.8720819130138],
  [-97.925972064798, 29.8720682852057],
];

/**
 * 48453:427599 — 203 E OXFORD DR, PFLUGERVILLE, TX 78660.
 *
 * Source: https://services1.arcgis.com/HGcSYZ5bvjRswoCb/ArcGIS/rest/services/TCAD_Parcels_Dec_2025/FeatureServer/0
 *   (Travis County TNR-published TCAD parcels), where PROP_ID=427599,
 *   returnGeometry=true, outSR=4326, f=geojson. Fetched 2026-09-16T20:15Z.
 * Service row as fetched: situs_address "203 E OXFORD DR PFLUGERVILLE 78660",
 *   tcad_acres 0.2149, GIS_acres 0.21942358, legal_desc "LOT 5 BLK D CREEKSIDE
 *   ADDN".
 *
 * THE CONTROL. 4 edges, every internal turn 89.4-95.0 degrees, no collinear
 * run, no chord shorter than 20 m: nothing for a ring scrub or a logical-edge
 * grouping to do. Measured against the engine's own rule (edge midpoint to road
 * polyline, 25 m threshold) only e1 is road-adjacent (East Oxford Drive,
 * 9.2 m); the situs path already resolves the front to e1 and the rear falls on
 * e3. This parcel must come out byte-identical.
 */
export const PARCEL_48453_427599_PFLUGERVILLE: Ring = [
  [-97.622934406367, 30.4337546672325],
  [-97.6227639922047, 30.4340866223401],
  [-97.6225463122914, 30.433983013277],
  [-97.6227448169153, 30.4336681497405],
  [-97.622934406367, 30.4337546672325],
];

/**
 * OSM Overpass ways around the San Marcos parcel (29.87195, -97.92595, 120 m
 * radius, [highway][name]), fetched 2026-09-16T20:17Z. Overpass base timestamp
 * 2026-09-16T20:17:16Z.
 *
 * Note the naming the engine must already tolerate: the situs says
 * "629 STURGEON DR" while OSM says "Sturgeon Street". normalizeStreetNameForMatch
 * drops the leading house number and the trailing type, so both reduce to
 * STURGEON — this fixture exercises that path with REAL data, no dictionary.
 */
export const ROAD_STURGEON_STREET: WarmRoadSource = {
  osmWayId: 15292464,
  osmHighwayTag: "residential",
  name: "Sturgeon Street",
  classification: "residential",
  polyline: [
    [-97.9272228, 29.8703407],
    [-97.9271381, 29.8703906],
    [-97.925387, 29.8718999],
    [-97.9237958, 29.8732654],
    [-97.9226089, 29.8742954],
    [-97.9214089, 29.8753298],
  ],
};

export const ROAD_CONWAY_DRIVE: WarmRoadSource = {
  osmWayId: 15297596,
  osmHighwayTag: "residential",
  name: "Conway Drive",
  classification: "residential",
  polyline: [
    [-97.9284458, 29.8709126],
    [-97.9278515, 29.8711192],
    [-97.9277609, 29.8711618],
    [-97.9276807, 29.8712157],
    [-97.9261387, 29.8725461],
    [-97.9245416, 29.8739087],
    [-97.9232669, 29.8750363],
    [-97.9220901, 29.876034],
    [-97.9182799, 29.8792748],
  ],
};

export const ROAD_CLAIRE_DRIVE: WarmRoadSource = {
  osmWayId: 15301941,
  osmHighwayTag: "residential",
  name: "Claire Drive",
  classification: "residential",
  polyline: [
    [-97.925387, 29.8718999],
    [-97.9261387, 29.8725461],
    [-97.9268825, 29.8731872],
  ],
};

/**
 * Every road candidate the engine would see within the fixture's 120 m window,
 * in the order Overpass returned them. The dispatch's defect prose says the
 * front comes from "the nearest street centerline" on this parcel; the fixture
 * carries all three real candidates so that claim is testable rather than
 * asserted — and so a future regression that makes Claire Drive (26.6 m from
 * the long side, i.e. just outside the 25 m threshold) win would be caught.
 */
export const ROADS_AROUND_48209_97658: WarmRoadSource[] = [
  ROAD_STURGEON_STREET,
  ROAD_CONWAY_DRIVE,
  ROAD_CLAIRE_DRIVE,
];

/**
 * OSM Overpass ways around the Pflugerville parcel (30.43389, -97.62284, 120 m
 * radius), fetched 2026-09-16T20:17Z. Both "East Oxford Drive" ways are carried
 * because the engine receives ways, not streets, and the situs "203 E OXFORD
 * DR" must match either of them.
 */
export const ROAD_EAST_OXFORD_DRIVE_TERIARY: WarmRoadSource = {
  osmWayId: 619637978,
  osmHighwayTag: "tertiary",
  name: "East Oxford Drive",
  classification: "minor_collector",
  polyline: [
    [-97.6240275, 30.4340035],
    [-97.6239549, 30.4340284],
    [-97.6235881, 30.4341673],
    [-97.6234095, 30.4342209],
    [-97.623275, 30.4342457],
    [-97.6231104, 30.4342584],
  ],
};

export const ROAD_EAST_OXFORD_DRIVE_RESIDENTIAL: WarmRoadSource = {
  osmWayId: 626729224,
  osmHighwayTag: "residential",
  name: "East Oxford Drive",
  classification: "residential",
  polyline: [
    [-97.6231104, 30.4342584],
    [-97.6229338, 30.4342325],
    [-97.6227685, 30.4341777],
    [-97.6225905, 30.4340986],
    [-97.6217578, 30.4337001],
    [-97.621695, 30.4336701],
    [-97.6216253, 30.4336368],
    [-97.6213092, 30.4334859],
  ],
};

export const ROADS_AROUND_48453_427599: WarmRoadSource[] = [
  ROAD_EAST_OXFORD_DRIVE_TERIARY,
  ROAD_EAST_OXFORD_DRIVE_RESIDENTIAL,
];

/** The situs strings exactly as the ledger and the county services hold them. */
export const SITUS_48209_97658 = "629 STURGEON DR, SAN MARCOS, TX 78666";
export const SITUS_48453_427599 = "203 E OXFORD DR PFLUGERVILLE 78660";

/** SF-6 San Marcos setbacks, from the ledger rails for 48209:97658. */
export const SETBACKS_SF6_SAN_MARCOS = {
  front_ft: 25,
  side_ft: 5,
  rear_ft: 20,
  side_corner_ft: 15,
};
