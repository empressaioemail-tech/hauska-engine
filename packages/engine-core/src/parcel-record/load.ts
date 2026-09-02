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
import type { ParcelRecordRailKey } from "./rail-keys.js";
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

interface RailCellTableRow {
  place_key: string;
  cell_state: AnyCellState;
}

export interface RailCell {
  placeKey: string;
  state: AnyCellState;
}

export interface RailCellPage {
  cells: RailCell[];
  /** Cursor for the next page; null when this was the last page. */
  nextAfter: string | null;
}

export const DEFAULT_RAIL_CELL_PAGE_SIZE = 500;

/**
 * The lower-bound seed for the first page of a county — every real place_key
 * for a county is strictly greater than this (place_key = countyFips + ':' +
 * propId, propId always non-empty), and it sorts correctly against every
 * other county's rows too since ':' (0x3A) is a fixed separator.
 */
export function countyRailCellsFirstAfter(countyFips: string): string {
  return `${countyFips}:`;
}

/**
 * Load ONE PAGE of one county's cells for ONE rail, ordered by place_key.
 * PARCEL-B-GATE-SCHED CP2 correction: an earlier, unpaged version of this
 * function (CP1) issued a single (county_fips, rail_key)-scoped statement
 * and measured 408.8ms on the smallest county (48055, 24,988 parcels) — but
 * that same unpaged shape, in BOTH a parcel_record join form and a direct
 * place_key-range form, timed out at 120s against Travis (48453, 380,917
 * parcels) with the live store otherwise idle (pg_stat_activity showed no
 * contention at the time). EXPLAIN showed why: parcel_record_cell's primary
 * key orders rows by (place_key, rail_key) — for a WIDE place_key range, an
 * index scan filtering on the trailing rail_key column cannot skip the other
 * ~64 sibling rail rows per parcel without walking them (pre-skip-scan btree
 * behavior), so cost scales with rows-in-range x 65, not rows matching the
 * rail. A bounded page (this function, LIMIT 500 by default) keeps each
 * statement's cost to page_size x 65 leaf entries regardless of county size —
 * measured 100-180ms/page against Travis, the same county that timed out
 * unpaged. This is the actual "streaming/batched per rail" the mission
 * names, more literally than CP1's initial reading of it.
 *
 * Callers loop: start with after = countyRailCellsFirstAfter(countyFips);
 * stop when nextAfter is null.
 */
export async function loadCountyRailCellsPage(
  sql: ParcelRecordSqlClient,
  countyFips: string,
  railKey: ParcelRecordRailKey,
  after: string,
  pageSize: number = DEFAULT_RAIL_CELL_PAGE_SIZE,
): Promise<RailCellPage> {
  const upper = `${countyFips};`;
  const rows = await sql<RailCellTableRow>`
    SELECT place_key, cell_state
      FROM parcel_record_cell
     WHERE place_key > ${after} AND place_key < ${upper} AND rail_key = ${railKey}
     ORDER BY place_key
     LIMIT ${pageSize}
  `;
  return {
    cells: rows.map((r) => ({ placeKey: r.place_key, state: r.cell_state })),
    nextAfter: rows.length === pageSize ? rows[rows.length - 1].place_key : null,
  };
}

export interface LoadCountyRailCellsResult {
  countyFips: string;
  railKey: ParcelRecordRailKey;
  cells: RailCell[];
  pageCount: number;
  /** Row count read from parcel_record for this county — the full parcel roster, independent of this rail. */
  parcelRowCount: number;
  readAt: string;
}

/**
 * Page through an entire county's cells for one rail and accumulate them.
 * The accumulation happens in JS memory (cheap — one small {placeKey,state}
 * object per parcel, not a full 65-rail ParcelRecordRow), never as one SQL
 * statement over the whole county; see loadCountyRailCellsPage's doc comment
 * for why the unpaged form is a measured dead end on the two largest
 * counties. Fails loud (never a silent partial evaluation) if the
 * accumulated cell count does not match parcel_record's row count for the
 * county, per the full-shape-at-instantiation rule.
 */
export async function loadCountyRailCells(
  sql: ParcelRecordSqlClient,
  countyFips: string,
  railKey: ParcelRecordRailKey,
  pageSize: number = DEFAULT_RAIL_CELL_PAGE_SIZE,
): Promise<LoadCountyRailCellsResult> {
  const [{ count: parcelRowCountRaw }] = await sql<{ count: string | number }>`
    SELECT count(*) AS count FROM parcel_record WHERE county_fips = ${countyFips}
  `;
  const parcelRowCount = Number(parcelRowCountRaw);

  const cells: RailCell[] = [];
  let after = countyRailCellsFirstAfter(countyFips);
  let pageCount = 0;
  while (true) {
    const page = await loadCountyRailCellsPage(sql, countyFips, railKey, after, pageSize);
    cells.push(...page.cells);
    pageCount += 1;
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  }

  if (cells.length !== parcelRowCount) {
    throw new Error(
      `loadCountyRailCells: county ${countyFips} rail "${railKey}" has ${parcelRowCount} parcel_record rows ` +
        `but accumulated ${cells.length} parcel_record_cell rows across ${pageCount} pages -- every parcel must ` +
        `carry a cell for every rail per the full-shape-at-instantiation rule; a mismatch is a data-integrity ` +
        `defect, not an absence to skip over.`,
    );
  }

  return {
    countyFips,
    railKey,
    cells,
    pageCount,
    parcelRowCount,
    readAt: new Date().toISOString(),
  };
}
