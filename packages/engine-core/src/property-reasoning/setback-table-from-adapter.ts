/**
 * Convert adapter setback JSON (districts + optional fan-gift provenance)
 * into JurisdictionDescriptor.setbackTable rows for emitSetbackRule.
 * Jurisdiction keys come from the caller (snapshot cityKey) — no city
 * literals here (WDLL 3.8 grep gate).
 */

import type {
  SetbackFieldProvenance,
  SetbackTableDescriptor,
  SetbackTableRowProvenance,
} from "./types.js";

type AdapterFieldProv = {
  atom_did?: string;
  confidence?: number;
  verification_state?: string;
  not_specified?: boolean;
};

type AdapterDistrict = {
  district_name: string;
  front_ft: number;
  rear_ft: number;
  side_ft: number;
  side_corner_ft: number;
  max_height_ft?: number;
  max_lot_coverage_pct?: number;
  max_impervious_pct?: number;
  provenance?: Record<string, AdapterFieldProv | undefined>;
};

type AdapterSetbackTable = {
  districts?: AdapterDistrict[];
};

function leadingDistrictToken(districtName: string): string {
  const t = districtName.trim().split(/\s+/)[0] ?? "";
  return t;
}

function mapVerification(
  raw: string | undefined,
): SetbackFieldProvenance["verification_state"] {
  if (raw === "human-verified" || raw === "transcribed" || raw === "unverified") {
    return raw;
  }
  // Fan-gift tables use "asserted" — treat as transcribed for emit path.
  return "transcribed";
}

function fieldFrom(
  value: number | undefined,
  prov: AdapterFieldProv | undefined,
  fallbackConfidence: number,
): SetbackFieldProvenance | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return {
    value,
    confidence:
      typeof prov?.confidence === "number" ? prov.confidence : fallbackConfidence,
    verification_state: mapVerification(prov?.verification_state),
  };
}

function rowFromDistrict(d: AdapterDistrict): SetbackTableRowProvenance | null {
  const district_code = leadingDistrictToken(d.district_name);
  if (!district_code) return null;
  const p = d.provenance ?? {};
  const atom_did =
    p.front_ft?.atom_did ||
    p.rear_ft?.atom_did ||
    p.side_ft?.atom_did ||
    `${district_code}/setback-table`;
  return {
    atom_did,
    match_basis: "exact",
    district_code,
    front_ft: fieldFrom(d.front_ft, p.front_ft, 0.7),
    rear_ft: fieldFrom(d.rear_ft, p.rear_ft, 0.7),
    side_ft: fieldFrom(d.side_ft, p.side_ft, 0.7),
    side_corner_ft: fieldFrom(d.side_corner_ft, p.side_corner_ft, 0.6),
    max_height_ft: fieldFrom(d.max_height_ft, p.max_height_ft, 0.6),
    max_lot_coverage_pct: fieldFrom(
      d.max_lot_coverage_pct,
      p.max_lot_coverage_pct,
      0.6,
    ),
    max_impervious_pct: fieldFrom(
      d.max_impervious_pct,
      p.max_impervious_pct,
      0.6,
    ),
  };
}

/** Build descriptor setback table from an adapter JSON table (or null). */
export function setbackTableDescriptorFromAdapter(
  table: AdapterSetbackTable | null | undefined | { districts?: unknown },
): SetbackTableDescriptor | undefined {
  if (!table || !Array.isArray(table.districts) || table.districts.length === 0) {
    return undefined;
  }
  const rows: SetbackTableRowProvenance[] = [];
  for (const raw of table.districts) {
    const d = raw as AdapterDistrict;
    const row = rowFromDistrict(d);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return undefined;
  return { rows };
}

/** Normalize snapshot jurisdictionKey (underscore or hyphen) to adapter key. */
export function normalizeCityKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/_/g, "-");
  return t.length > 0 ? t : null;
}
