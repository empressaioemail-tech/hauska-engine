/**
 * Ingest existing store data into parcel-record cells (no acquisition).
 *
 * Reads:
 *   - cad_property (CORTEX_DATABASE_URL / neondb) for CAD scalars
 *   - atoms (DATABASE_URL / hauska_mcp) for atom-family companions
 *
 * Does NOT convert unaccounted → absent-verified.
 */

import type { CompanionCellState, ScalarCellState } from "./cell-state.js";
import { isCompanionRail, type ParcelRecordRailKey } from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";
import { placeKeyFromParts } from "./record-shape.js";

export interface CadPropertyRow {
  prop_id: string;
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

const CAD_SOURCE = "cad_property";
const ATOM_SOURCE = "hauska_mcp.atoms";

function hasText(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
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

function applyCadScalar(
  record: ParcelRecordRow,
  cad: CadPropertyRow,
  vintage: string,
): number {
  let moved = 0;
  const c = record.cells;
  const stamp = (key: keyof typeof c, value: string | number | null) => {
    if (c[key].kind !== "unaccounted") return;
    (c as Record<string, ScalarCellState>)[key] = scalarValue(value, CAD_SOURCE, vintage);
    moved += 1;
  };

  stamp("apn", cad.prop_id);
  if (hasText(cad.situs_address)) stamp("situsAddress", cad.situs_address!.trim());
  if (hasText(cad.situs_city)) stamp("situsCity", cad.situs_city!.trim());
  if (hasText(cad.situs_zip)) stamp("situsZip", cad.situs_zip!.trim());
  if (hasText(cad.legal_description)) stamp("legalDescription", cad.legal_description!.trim());
  if (hasText(cad.exemption_codes)) stamp("exemptionCodes", cad.exemption_codes!.trim());
  if (hasText(cad.property_use_code)) {
    stamp("landUseCode", cad.property_use_code!.trim());
    stamp("landUseSource", "cad-roll");
  }
  if (cad.land_value != null) stamp("landValue", cad.land_value);
  if (cad.improvement_value != null) stamp("improvementValue", cad.improvement_value);
  if (cad.market_value != null) stamp("marketValue", cad.market_value);
  if (cad.assessed_value != null) stamp("assessedValue", cad.assessed_value);
  if (cad.year_built != null) stamp("yearBuilt", cad.year_built);
  if (cad.living_area_sqft != null && cad.living_area_sqft > 0) {
    stamp("livingAreaSqft", cad.living_area_sqft);
  }
  if (cad.land_acres != null) {
    stamp("acreageAcres", cad.land_acres);
    stamp("acreageMethod", "cad_property.land_acres");
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
