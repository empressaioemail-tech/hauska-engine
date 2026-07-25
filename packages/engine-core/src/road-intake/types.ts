/**
 * Road INTAKE types — jurisdiction descriptor slice + OSM observation inputs.
 * Jurisdiction knowledge (assumed ROW widths) lives in descriptor only (27a).
 */

import type { AccessPolicy, RoadClassification } from "@hauska-engine/atoms";

/** v1 assumed ROW width table keyed by road classification (feet). */
export interface AssumedRowWidthTable {
  readonly highway: number;
  readonly major_collector: number;
  readonly minor_collector: number;
  readonly residential: number;
  readonly alley: number;
  readonly gravel: number;
  readonly unclassified: number;
}

export const DEFAULT_ASSUMED_ROW_WIDTH_FT: AssumedRowWidthTable = {
  highway: 100,
  major_collector: 60,
  minor_collector: 50,
  residential: 50,
  alley: 20,
  gravel: 30,
  unclassified: 40,
};

export interface RoadIntakeDescriptor {
  key: string;
  displayName: string;
  jurisdictionTenant: string;
  countyFips: string;
  defaultAccessPolicy: AccessPolicy;
  assumedRowWidthFt: AssumedRowWidthTable;
  sourceAdapter: string;
  sourceUrl: string;
}

/** Parsed OSM way ready for road-node emit. */
export interface OsmRoadObservation {
  osmWayId: number;
  displayName?: string;
  osmHighwayTag: string;
  classification: RoadClassification;
  /** WGS84 [lng, lat] centerline vertices. */
  centerline: ReadonlyArray<readonly [number, number]>;
  sourceCitation: string;
  extractedAt: string;
}

export interface ParsedOsmElement {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: ReadonlyArray<{ lat: number; lon: number }>;
}
