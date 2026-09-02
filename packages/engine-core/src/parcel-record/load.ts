/**
 * Read-only DB loader — parcel_record + parcel_record_cell -> ParcelRecordRow[].
 *
 * One county per call, always. Never combine counties into one query: the
 * parcel-gap-ledger close recorded a 180s timeout on exactly that combined
 * shape (_inbox/2026-09-01_cell-ledger_cp1.json stepC.sixCountyPlan). This
 * module issues exactly two indexed, county-filtered SELECTs and returns
 * in-memory rows. It never writes and never closes the caller's connection.
 *
 * Row-absence on a rail cell is never silently treated as the stored
 * 'unaccounted' sentinel — a parcel_record row with fewer than the full
 * rail set behind it is a real data-integrity defect and this loader fails
 * loud on it (assertFullRecordCells), per ENFORCEMENT.md's "never default a
 * field whose correct value is unknown."
 */

import type { AnyCellState } from "./cell-state.js";
import { PARCEL_RECORD_RAIL_KEYS } from "./rail-keys.js";
import type { ParcelRecordCells, ParcelRecordRow } from "./record-shape.js";
import { assertFullRecordCells } from "./record-shape.js";

/**
 * Minimal duck-typed SQL client contract — matches the callable shape of a
 * `postgres()` instance (the `postgres` package already used elsewhere in
 * this package, e.g. scripts/prove-parcel-record-county.mjs). Kept as a
 * narrow interface rather than importing `postgres`'s types directly so
 * this module stays easy to call with a test double and does not couple
 * the parcel-record directory's DB-agnostic modules to one client library
 * beyond this single loader file.
 */
export interface ParcelRecordSqlClient {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}

interface ParcelRecordTableRow {
  place_key: string;
  county_fips: string;
  prop_id: string;
  incorporated: boolean | null;
  instantiated_at: string;
}

interface ParcelRecordCellTableRow {
  place_key: string;
  rail_key: string;
  cell_state: AnyCellState;
}

export interface LoadCountyParcelRecordsResult {
  countyFips: string;
  records: ParcelRecordRow[];
  /** Row count read from parcel_record for this county. */
  parcelRowCount: number;
  /** Row count read from parcel_record_cell for this county (join via parcel_record). */
  cellRowCount: number;
  /** Wall-clock time this loader's queries returned — moving-target stores mean this is a point-in-time read, not a snapshot. */
  readAt: string;
}

/**
 * Load one county's parcel_record + parcel_record_cell rows into
 * ParcelRecordRow[], mapped onto the existing closed ParcelRecordCells
 * shape. Read-only: two SELECTs, no writes, no session/connection
 * management (caller owns open/close and any read-only session pragma).
 */
export async function loadCountyParcelRecords(
  sql: ParcelRecordSqlClient,
  countyFips: string,
): Promise<LoadCountyParcelRecordsResult> {
  const parcelRows = await sql<ParcelRecordTableRow>`
    SELECT place_key, county_fips, prop_id, incorporated, instantiated_at
    FROM parcel_record
    WHERE county_fips = ${countyFips}
  `;

  const cellRows = await sql<ParcelRecordCellTableRow>`
    SELECT cell.place_key, cell.rail_key, cell.cell_state
    FROM parcel_record_cell cell
    JOIN parcel_record prc ON prc.place_key = cell.place_key
    WHERE prc.county_fips = ${countyFips}
  `;

  const cellsByPlaceKey = new Map<string, Map<string, AnyCellState>>();
  for (const row of cellRows) {
    let byRail = cellsByPlaceKey.get(row.place_key);
    if (!byRail) {
      byRail = new Map();
      cellsByPlaceKey.set(row.place_key, byRail);
    }
    byRail.set(row.rail_key, row.cell_state);
  }

  const records: ParcelRecordRow[] = parcelRows.map((p) => {
    const byRail = cellsByPlaceKey.get(p.place_key);
    const cells: Record<string, AnyCellState> = {};
    for (const railKey of PARCEL_RECORD_RAIL_KEYS) {
      const state = byRail?.get(railKey);
      if (state != null) cells[railKey] = state;
    }
    // Throws "missing rail column: X" if the stored row set is incomplete —
    // row-absence is a defect to surface, never a value to invent.
    assertFullRecordCells(cells);

    return {
      placeKey: p.place_key,
      countyFips: p.county_fips,
      propId: p.prop_id,
      incorporated: p.incorporated,
      cells: cells as ParcelRecordCells,
      instantiatedAt: p.instantiated_at,
    };
  });

  return {
    countyFips,
    records,
    parcelRowCount: parcelRows.length,
    cellRowCount: cellRows.length,
    readAt: new Date().toISOString(),
  };
}
