/**
 * Registry-derived RoadIntakeDescriptor for statewide Geofabrik intake.
 *
 * Per-jurisdiction hand-authored descriptors survive only for non-OSM
 * overlays (county surveyed / CAD / roadway MapServer). OSM statewide uses
 * one adapter identity + DEFAULT_ASSUMED_ROW_WIDTH_FT, with tenant/key/FIPS
 * derived from the county registry row.
 */

import type { AccessPolicy } from "@hauska-engine/atoms";

import {
  DEFAULT_ASSUMED_ROW_WIDTH_FT,
  type AssumedRowWidthTable,
  type RoadIntakeDescriptor,
} from "./types.js";

/**
 * Geofabrik Texas extract URL (mutable latest). Statewide ingest MUST pin a
 * dated snapshot URL + published MD5; verified download 2026-08-09:
 * Content-Length 713163541, Last-Modified 2026-08-06, MD5 4dd27afd6bc1c654f9b9635b709cf424.
 */
export const GEOFABRIK_TEXAS_PBF_URL =
  "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf";

export const STATEWIDE_OSM_SOURCE_ADAPTER = "road-intake-osm-geofabrik-pbf";

export interface CountyRegistryRoadRow {
  countyFips: string;
  countyName: string;
  /** Optional override; default breadth_{fips}_{slug}. */
  jurisdictionTenant?: string;
  /** Optional ROW table override; default DEFAULT_ASSUMED_ROW_WIDTH_FT. */
  assumedRowWidthFt?: AssumedRowWidthTable;
  defaultAccessPolicy?: AccessPolicy;
}

function slugifyCountyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Derive a RoadIntakeDescriptor from a county registry row.
 * What is LOST vs hand-authored descriptors: per-city displayName/key,
 * city-scoped sourceAdapter labels (elgin/caldwell-osm), and any future
 * per-jurisdiction ROW tables that diverge from DEFAULT.
 */
export function roadIntakeDescriptorFromCountyRegistry(
  row: CountyRegistryRoadRow,
  opts: {
    sourceUrl?: string;
    sourceAdapter?: string;
  } = {},
): RoadIntakeDescriptor {
  if (!/^\d{5}$/.test(row.countyFips)) {
    throw new Error(`countyFips must be 5 digits, got ${row.countyFips}`);
  }
  const slug = slugifyCountyName(row.countyName);
  const tenant =
    row.jurisdictionTenant ?? `breadth_${row.countyFips}_${slug || "county"}`;
  return {
    key: `tx_${row.countyFips}_${slug || "county"}_osm_geofabrik`,
    displayName: `${row.countyName} OSM roads (Geofabrik statewide extract)`,
    jurisdictionTenant: tenant,
    countyFips: row.countyFips,
    defaultAccessPolicy: row.defaultAccessPolicy ?? "public-free",
    assumedRowWidthFt: row.assumedRowWidthFt ?? DEFAULT_ASSUMED_ROW_WIDTH_FT,
    sourceAdapter: opts.sourceAdapter ?? STATEWIDE_OSM_SOURCE_ADAPTER,
    sourceUrl: opts.sourceUrl ?? GEOFABRIK_TEXAS_PBF_URL,
  };
}
