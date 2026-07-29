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

/**
 * Load txgio_parcel rows once and build the in-memory adjacency index.
 *
 * Selects situs_address for situs-street front labeling when the column
 * exists; a source without it degrades gracefully (entries carry
 * situsAddress: null and front labeling falls back to the adjacency
 * heuristic).
 */
export async function loadParcelAdjacencyIndexFromNeon(
  sql: postgres.Sql,
  countyFips: string,
  options?: LoadParcelIndexOptions,
): Promise<ParcelAdjacencyIndex> {
  let rows: postgres.RowList<postgres.Row[]>;
  try {
    rows = options?.propIds?.length
      ? await sql`
          SELECT prop_id, geometry, west_lng, south_lat, east_lng, north_lat, situs_address
          FROM txgio_parcel
          WHERE county_fips = ${countyFips}
            AND prop_id = ANY(${options.propIds as string[]})
            AND geometry IS NOT NULL
        `
      : await sql`
          SELECT prop_id, geometry, west_lng, south_lat, east_lng, north_lat, situs_address
          FROM txgio_parcel
          WHERE county_fips = ${countyFips}
            AND geometry IS NOT NULL
        `;
  } catch {
    // situs_address column absent in this source — degrade to geometry-only.
    rows = options?.propIds?.length
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
  }

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
    const rawSitus =
      typeof row.situs_address === "string" ? row.situs_address.trim() : "";
    entries.push({
      countyFips,
      propId,
      parcelNodeId: `${countyFips}:${propId}`,
      situsAddress: rawSitus.length > 0 ? rawSitus : null,
      ring,
      westLng,
      southLat,
      eastLng,
      northLat,
    });
  }

  return buildParcelAdjacencyIndex(countyFips, entries);
}
