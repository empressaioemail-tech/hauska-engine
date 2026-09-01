/**
 * Ingest public-record permits onto parcel-record rows (companion rail).
 */

import type { CompanionCellState } from "./cell-state.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { placeKeyFromParts } from "./record-shape.js";
import {
  sourcedEmptyPermitsCell,
  sourcedPermitsWithRowsCell,
  type ParcelPermitRow,
} from "./permits-field.js";

export const AUSTIN_SODA_PERMIT_SOURCE = "austin-soda:3syk-w9eu";
export const TRAVIS_COUNTY_FIPS = "48453";
export const AUSTIN_TX_JURISDICTION = "austin_tx";

/** Map Austin SODA tcad_id to Travis CAD prop_id for place_key join. */
export function tcadIdToTravisPropId(tcadId: string): string {
  const t = tcadId.trim();
  if (!t) throw new Error("tcad_id must not be empty");
  // Numeric geo ids: strip leading zeros to match cad_property.prop_id
  if (/^\d+$/.test(t)) {
    const stripped = t.replace(/^0+/, "");
    return stripped.length > 0 ? stripped : "0";
  }
  // Condo / alternate account prefixes (e.g. R064814) — use verbatim
  return t;
}

export function placeKeyFromTcadId(tcadId: string): string {
  return placeKeyFromParts(TRAVIS_COUNTY_FIPS, tcadIdToTravisPropId(tcadId));
}

export interface RawAustinSodaPermitRow {
  permit_number?: string;
  permit_type_desc?: string;
  status_current?: string;
  issue_date?: string;
  statusdate?: string;
  tcad_id?: string;
  link?: { url?: string };
}

export function normalizeAustinSodaPermitRow(
  row: RawAustinSodaPermitRow,
  sourceId: string = AUSTIN_SODA_PERMIT_SOURCE,
): ParcelPermitRow | null {
  const permitNumber = row.permit_number?.trim();
  if (!permitNumber) return null;
  const status = row.status_current?.trim() ?? "unknown";
  const issueRaw = row.issue_date ?? row.statusdate ?? null;
  let issueDate: string | null = null;
  if (issueRaw) {
    const d = new Date(issueRaw);
    if (!Number.isNaN(d.getTime())) issueDate = d.toISOString();
  }
  const sourceUrl =
    row.link && typeof row.link.url === "string" && row.link.url.trim()
      ? row.link.url.trim()
      : null;

  return {
    permitNumber,
    permitType: row.permit_type_desc?.trim() ?? null,
    status,
    issueDate,
    sourceId,
    sourceUrl,
  };
}

export interface PermitsByPlaceKey {
  placeKey: string;
  rows: ParcelPermitRow[];
}

export function indexPermitsByPlaceKey(
  entries: readonly { tcadId: string; row: ParcelPermitRow }[],
): Map<string, ParcelPermitRow[]> {
  const out = new Map<string, ParcelPermitRow[]>();
  for (const { tcadId, row } of entries) {
    const key = placeKeyFromTcadId(tcadId);
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}

export function applyPermitsToRecord(
  record: ParcelRecordRow,
  rows: readonly ParcelPermitRow[],
  source: string,
  vintage: string,
): CompanionCellState {
  const next =
    rows.length === 0
      ? sourcedEmptyPermitsCell(source, vintage)
      : sourcedPermitsWithRowsCell(rows.length, source, vintage);
  record.cells.permits = next;
  return next;
}

export function ingestPermitsOntoRecords(
  records: ParcelRecordRow[],
  permitsByPlace: ReadonlyMap<string, readonly ParcelPermitRow[]>,
  source: string,
  vintage: string,
): { parcelsTouched: number; totalRows: number; emptySets: number; withRows: number } {
  let parcelsTouched = 0;
  let totalRows = 0;
  let emptySets = 0;
  let withRows = 0;

  for (const rec of records) {
    const key = placeKeyFromParts(rec.countyFips, rec.propId);
    const rows = permitsByPlace.get(key) ?? [];
    applyPermitsToRecord(rec, rows, source, vintage);
    parcelsTouched += 1;
    totalRows += rows.length;
    if (rows.length === 0) emptySets += 1;
    else withRows += 1;
  }

  return { parcelsTouched, totalRows, emptySets, withRows };
}
