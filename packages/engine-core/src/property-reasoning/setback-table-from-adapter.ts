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
  /** The row's own citation (ordinance URL or ordinance number), carried onto the row. */
  citation_url?: string;
  max_height_ft?: number;
  max_lot_coverage_pct?: number;
  max_impervious_pct?: number;
  provenance?: Record<string, AdapterFieldProv | undefined>;
  display_meta?: import("./types.js").SetbackRowDisplayMeta;
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

/**
 * The corpus's canonical stated-absence sentinel for `max_height_ft`
 * (hauska-setback-corpus rule G7 / `NOT_SPECIFIED_MAX_HEIGHT_FT`). It is a
 * placeholder, not a height: the meaning lives in the row's
 * `provenance.max_height_ft.not_specified` flag, and the number carries none.
 * 999 ft is not a height any code in this corpus states.
 */
export const NOT_SPECIFIED_MAX_HEIGHT_FT = 999;

/**
 * True when a height is ABSENT rather than a number — either the honest form
 * (`provenance.max_height_ft.not_specified === true`) or the bare canonical
 * sentinel with no flag. The corpus gate (G8) blocks the bare shape from
 * shipping, but this boundary reads adapter JSON directly, so it fails closed
 * on the value too, mirroring legacy-design-tools' `heightIsAbsent()`
 * (`artifacts/api-server/src/routes/localSetbacks.ts`).
 */
export function heightIsAbsent(
  field: { value: number; not_specified?: boolean } | undefined,
): boolean {
  if (!field) return true;
  return field.not_specified === true || field.value === NOT_SPECIFIED_MAX_HEIGHT_FT;
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
    ...(prov?.not_specified === true ? { not_specified: true } : {}),
  };
}

/**
 * `fieldFrom` for `max_height_ft` only: additionally stamps the flag when the
 * value is the bare canonical sentinel, so `heightIsAbsent()` downstream sees
 * ONE honest shape for both ways a table can state no feet-based height.
 */
function heightFieldFrom(
  value: number | undefined,
  prov: AdapterFieldProv | undefined,
  fallbackConfidence: number,
): SetbackFieldProvenance | undefined {
  const field = fieldFrom(value, prov, fallbackConfidence);
  if (!field) return undefined;
  if (field.value === NOT_SPECIFIED_MAX_HEIGHT_FT && field.not_specified !== true) {
    return { ...field, not_specified: true };
  }
  return field;
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
  // P-154 wave 6 (R-1): the row's OWN citation travels with the row, so a
    // surface can print the followed value with the citation it rests on.
  const displayMeta = {
    ...(d.display_meta ?? {}),
    ...(d.citation_url ? { citation_url: d.citation_url } : {}),
  };
  return {
    atom_did,
    match_basis: "exact",
    district_code,
    front_ft: fieldFrom(d.front_ft, p.front_ft, 0.7),
    rear_ft: fieldFrom(d.rear_ft, p.rear_ft, 0.7),
    side_ft: fieldFrom(d.side_ft, p.side_ft, 0.7),
    side_corner_ft: fieldFrom(d.side_corner_ft, p.side_corner_ft, 0.6),
    max_height_ft: heightFieldFrom(d.max_height_ft, p.max_height_ft, 0.6),
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
    ...(Object.keys(displayMeta).length > 0 ? { display_meta: displayMeta } : {}),
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
