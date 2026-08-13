/**
 * Read Texas RRC surface wells from staged `tx_rrc_well` (first-party statewide).
 * NEVER use the Harris County ArcGIS mirror for apply — it holds ~0.92% of TX.
 */

import type { BBoxInput, CountyWellFetchResult, RrcWellFeature } from "./fetch-wells.js";

export const STAGED_WELL_SOURCE = "tx_rrc_well";
export const STAGED_WELL_ADAPTER = "tx-rrc-well-staged-v1";

/** Minimal tagged-template SQL handle (postgres.js compatible). */
type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<ReadonlyArray<Record<string, unknown>>>;
};

function parseStagedWell(row: Record<string, unknown>): RrcWellFeature | null {
  const lng = Number(row.lng);
  const lat = Number(row.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    surfaceId: Number(row.uniqid ?? 0),
    symnum: Number(row.symnum ?? 0),
    api: String(row.api ?? ""),
    wellId: String(row.gis_well_number ?? row.well_row_id ?? ""),
    lng,
    lat,
    reliab: row.reliab != null ? String(row.reliab) : null,
  };
}

/** True when the table exists in the connected database. */
export async function stagedWellTableExists(sql: SqlTag): Promise<boolean> {
  const rows = await sql`SELECT to_regclass('public.tx_rrc_well') AS reg`;
  return rows[0]?.reg != null;
}

/**
 * Fetch wells whose points intersect the county bbox (same shape as the old
 * ArcGIS bbox query). Includes county_fips-null residue via lng/lat.
 */
export async function fetchRrcWellsFromStagedTable(
  sql: SqlTag,
  bbox: BBoxInput,
): Promise<CountyWellFetchResult & { source: typeof STAGED_WELL_SOURCE }> {
  const rows = await sql`
    SELECT well_row_id, uniqid, api, gis_well_number, symnum, reliab, lng, lat
    FROM tx_rrc_well
    WHERE west_lng <= ${bbox.eastLng}
      AND east_lng >= ${bbox.westLng}
      AND south_lat <= ${bbox.northLat}
      AND north_lat >= ${bbox.southLat}
  `;
  const wells: RrcWellFeature[] = [];
  for (const row of rows) {
    const parsed = parseStagedWell(row as Record<string, unknown>);
    if (parsed) wells.push(parsed);
  }
  return {
    wells,
    truncated: false,
    fieldNames: [
      "well_row_id",
      "uniqid",
      "api",
      "gis_well_number",
      "symnum",
      "reliab",
      "lng",
      "lat",
    ],
    source: STAGED_WELL_SOURCE,
  };
}
