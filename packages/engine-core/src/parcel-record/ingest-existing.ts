/**
 * Ingest existing store data into parcel-record cells (no acquisition).
 *
 * Reads:
 *   - cad_property (CORTEX_DATABASE_URL / neondb) for CAD scalars
 *   - atoms (DATABASE_URL / hauska_mcp) for atom-family companions
 *
 * cad-null-verified: a MATCHED latest CAD row with a null/blank scalar emits
 * absent-verified. A join miss never reaches that emission (structural:
 * applyCadScalar is only called after cadByProp.get hits). living_area 0
 * stays unaccounted. $0 stays value 0.
 */

import type {
  CadNullVerifiedBasis,
  CompanionCellState,
  ScalarAbsentVerifiedCell,
  ScalarCellState,
} from "./cell-state.js";
import { isCompanionRail, type ParcelRecordRailKey } from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { placeKeyFromParts } from "./record-shape.js";

export interface CadPropertyRow {
  prop_id: string;
  tax_year: number | string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  legal_description: string | null;
  exemption_codes: string | null;
  land_value: number | null;
  improvement_value: number | null;
  market_value: number | null;
  assessed_value: number | null;
  year_built: number | null;
  living_area_sqft: number | null;
  land_acres: number | null;
  property_use_code: string | null;
}

export interface AtomPresenceRow {
  entity_type: string;
  entity_id: string;
  n: number;
}

const CAD_SOURCE = "cad_property" as const;
const ATOM_SOURCE = "hauska_mcp.atoms";

function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Null or blank string. An unexpected type (e.g. text[] exemption_codes) is not a CAD null. */
function isCadNullText(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim().length === 0);
}

function isCadNullNumber(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim().length === 0);
}

function livingAreaIsPresentPositive(v: unknown): boolean {
  return v != null && !(typeof v === "string" && v.trim().length === 0) && Number(v) > 0;
}

function livingAreaIsZero(v: unknown): boolean {
  return v != null && !(typeof v === "string" && v.trim().length === 0) && Number(v) === 0;
}

function scalarValue(
  value: string | number | boolean | null,
  source: string,
  vintage: string,
): ScalarCellState {
  return { kind: "value", value, source, vintage };
}

function companionRows(
  rowCount: number,
  source: string,
  vintage: string,
): CompanionCellState {
  return {
    kind: "value",
    disposition: rowCount === 0 ? "empty-set" : "rows",
    rowCount,
    source,
    vintage,
  };
}

/**
 * Typed cad-null-verified emission. Reachable only from applyCadScalar, which
 * is reachable only after ingestCadOntoRecords hits the map. Incomplete basis
 * (missing tax_year) refuses rather than emitting a fabricated year.
 */
function cadNullVerified(
  record: ParcelRecordRow,
  cad: CadPropertyRow,
  vintage: string,
): ScalarAbsentVerifiedCell | null {
  if (cad.tax_year == null) return null;
  if (typeof cad.tax_year === "string" && cad.tax_year.trim().length === 0) return null;
  const basis: CadNullVerifiedBasis = {
    source: CAD_SOURCE,
    countyFips: record.countyFips,
    propId: cad.prop_id,
    taxYear: cad.tax_year,
    vintage,
  };
  return { kind: "absent-verified", basis };
}

function applyCadScalar(
  record: ParcelRecordRow,
  cad: CadPropertyRow,
  vintage: string,
): number {
  let moved = 0;
  const c = record.cells;
  const stampValue = (key: keyof typeof c, value: string | number | null) => {
    if (c[key].kind !== "unaccounted") return;
    (c as Record<string, ScalarCellState>)[key] = scalarValue(value, CAD_SOURCE, vintage);
    moved += 1;
  };
  const stampAbsent = (key: keyof typeof c) => {
    if (c[key].kind !== "unaccounted") return;
    const next = cadNullVerified(record, cad, vintage);
    if (!next) return;
    (c as Record<string, ScalarCellState>)[key] = next;
    moved += 1;
  };
  const stampText = (key: keyof typeof c, raw: unknown) => {
    if (hasText(raw)) stampValue(key, (raw as string).trim());
    else if (isCadNullText(raw)) stampAbsent(key);
  };
  const stampNumber = (key: keyof typeof c, raw: unknown) => {
    if (isCadNullNumber(raw)) stampAbsent(key);
    else if (raw != null) stampValue(key, raw as number);
  };

  stampValue("apn", cad.prop_id);
  stampText("situsAddress", cad.situs_address);
  stampText("situsCity", cad.situs_city);
  stampText("situsZip", cad.situs_zip);
  stampText("legalDescription", cad.legal_description);
  stampText("exemptionCodes", cad.exemption_codes);
  if (hasText(cad.property_use_code)) {
    stampValue("landUseCode", cad.property_use_code!.trim());
    stampValue("landUseSource", "cad-roll");
  } else if (isCadNullText(cad.property_use_code)) {
    stampAbsent("landUseCode");
  }
  stampNumber("landValue", cad.land_value);
  stampNumber("improvementValue", cad.improvement_value);
  stampNumber("marketValue", cad.market_value);
  stampNumber("assessedValue", cad.assessed_value);
  stampNumber("yearBuilt", cad.year_built);
  if (livingAreaIsPresentPositive(cad.living_area_sqft)) {
    stampValue("livingAreaSqft", cad.living_area_sqft as number);
  } else if (livingAreaIsZero(cad.living_area_sqft)) {
    // existing >0 rule: 0 is not a CAD null and is not a value
  } else if (isCadNullNumber(cad.living_area_sqft)) {
    stampAbsent("livingAreaSqft");
  }
  if (isCadNullNumber(cad.land_acres)) {
    stampAbsent("acreageAcres");
  } else if (cad.land_acres != null) {
    stampValue("acreageAcres", cad.land_acres);
    stampValue("acreageMethod", "cad_property.land_acres");
  }

  return moved;
}

const ENTITY_TYPE_TO_RAIL: Record<string, ParcelRecordRailKey> = {
  "parcel-node": "parcelGeometry",
  "flood-hazard-fact": "flood",
  "well-fact": "wells",
  "rrc-pipeline-fact": "pipelines",
  "utility-easement": "easements",
  "building-footprint": "buildingFootprint",
  "special-district-fact": "specialDistricts",
  "setback-rule": "setbackRules",
  "road-node": "roads",
  "parcel-terrain-model": "terrain",
  "rail-corridor-fact": "railCorridor",
  "zoning-fact": "zoningDistrict",
  "land-use-fact": "landUseCode",
  "buildable-envelope": "buildableAreaSqFt",
};

export function applyAtomPresenceToRecord(
  record: ParcelRecordRow,
  atoms: readonly AtomPresenceRow[],
  vintage: string,
): number {
  let moved = 0;
  for (const row of atoms) {
    const rail = ENTITY_TYPE_TO_RAIL[row.entity_type];
    if (!rail) continue;
    const cell = record.cells[rail];
    if (cell.kind !== "unaccounted") continue;
    const next: ScalarCellState | CompanionCellState = isCompanionRail(rail)
      ? companionRows(row.n, ATOM_SOURCE, vintage)
      : scalarValue(row.n, ATOM_SOURCE, vintage);
    (record.cells as Record<string, ScalarCellState | CompanionCellState>)[rail] = next;
    moved += 1;
  }
  return moved;
}

/** Index atom rows keyed by `${county}:${prop}` place key. */
export function indexAtomsByPlaceKey(
  rows: readonly { entity_type: string; entity_id: string; n: number }[],
): Map<string, AtomPresenceRow[]> {
  const out = new Map<string, AtomPresenceRow[]>();
  for (const row of rows) {
    const list = out.get(row.entity_id) ?? [];
    list.push({ entity_type: row.entity_type, entity_id: row.entity_id, n: row.n });
    out.set(row.entity_id, list);
  }
  return out;
}

export function ingestAtomsOntoRecords(
  records: ParcelRecordRow[],
  atomsByPlace: ReadonlyMap<string, AtomPresenceRow[]>,
  vintage: string,
): { cellsMoved: number; parcelsTouched: number } {
  let cellsMoved = 0;
  let parcelsTouched = 0;
  for (const rec of records) {
    const key = placeKeyFromParts(rec.countyFips, rec.propId);
    const rows = atomsByPlace.get(key) ?? atomsByPlace.get(rec.propId) ?? [];
    const n = applyAtomPresenceToRecord(rec, rows, vintage);
    if (n > 0) {
      cellsMoved += n;
      parcelsTouched += 1;
    }
  }
  return { cellsMoved, parcelsTouched };
}

export function ingestCadOntoRecords(
  records: ParcelRecordRow[],
  cadByProp: ReadonlyMap<string, CadPropertyRow>,
  vintage: string,
): { cellsMoved: number; parcelsTouched: number } {
  let cellsMoved = 0;
  let parcelsTouched = 0;
  for (const rec of records) {
    const cad = cadByProp.get(rec.propId);
    if (!cad) continue;
    const n = applyCadScalar(rec, cad, vintage);
    if (n > 0) {
      cellsMoved += n;
      parcelsTouched += 1;
    }
  }
  return { cellsMoved, parcelsTouched };
}

export interface IngestSummary {
  before: Record<string, number>;
  after: Record<string, number>;
  cellsMovedOnExistingData: number;
}

export function diffCellStateCounts(
  records: readonly ParcelRecordRow[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of records) {
    for (const key of Object.keys(rec.cells)) {
      const kind = rec.cells[key as keyof typeof rec.cells].kind;
      out[kind] = (out[kind] ?? 0) + 1;
    }
  }
  return out;
}
