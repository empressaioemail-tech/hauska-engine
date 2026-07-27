/**
 * One Neon SELECT for county parcel geometry + bbox (PRE-2 load path).
 */

import type postgres from "postgres";

import {
  buildParcelAdjacencyIndex,
  exteriorRingFromGeoJson,
} from "./adjacency-grid.js";
import type { ParcelAdjacencyIndex, ParcelIndexEntry } from "./types.js";

export interface LoadParcelIndexOptions {
  /** Optional row filter for tests / cohort batches. */
  propIds?: ReadonlyArray<string>;
}

/** Load txgio_parcel rows once and build the in-memory adjacency index. */
export async function loadParcelAdjacencyIndexFromNeon(
  sql: postgres.Sql,
  countyFips: string,
  options?: LoadParcelIndexOptions,
): Promise<ParcelAdjacencyIndex> {
  const rows = options?.propIds?.length
    ? await sql`
        SELECT prop_id, geometry, west_lng, south_lat, east_lng, north_lat
        FROM txgio_parcel
        WHERE county_fips = ${countyFips}
          AND prop_id = ANY(${options.propIds as string[]})
          AND geometry IS NOT NULL
      `
    : await sql`
        SELECT prop_id, geometry, west_lng, south_lat, east_lng, north_lat
        FROM txgio_parcel
        WHERE county_fips = ${countyFips}
          AND geometry IS NOT NULL
      `;

  const entries: ParcelIndexEntry[] = [];
  for (const row of rows) {
    const ring = exteriorRingFromGeoJson(row.geometry);
    if (!ring) continue;
    const westLng = Number(row.west_lng);
    const southLat = Number(row.south_lat);
    const eastLng = Number(row.east_lng);
    const northLat = Number(row.north_lat);
    if (
      !Number.isFinite(westLng) ||
      !Number.isFinite(southLat) ||
      !Number.isFinite(eastLng) ||
      !Number.isFinite(northLat)
    ) {
      continue;
    }
    const propId = String(row.prop_id);
    entries.push({
      countyFips,
      propId,
      parcelNodeId: `${countyFips}:${propId}`,
      ring,
      westLng,
      southLat,
      eastLng,
      northLat,
    });
  }

  return buildParcelAdjacencyIndex(countyFips, entries);
}
