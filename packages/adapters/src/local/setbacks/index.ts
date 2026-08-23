/**
 * Per-jurisdiction setback table loader.
 *
 * Loads the hand-curated `<jurisdiction>.json` tables (locked decision
 * #9) and exposes them through a typed lookup. The briefing engine
 * (DA-PI-3) calls {@link getSetbackTable} keyed by the resolved
 * jurisdiction key when it builds dimensional-rule prose.
 *
 * Adding a new jurisdiction:
 *   1. Drop a `<jurisdiction-key>.json` next to this file.
 *   2. Append the import + entry to the SETBACK_TABLES record below.
 */

// elgin-development-code.json RATIFIED 2026-08-04 by operator (after
// planner row-verification vs corpus atoms; see doc_repo
// _sessions/2026-08-03_elgin_foundation_and_city_code_refs). Operator
// directives: conditional cells route to their governing district's values
// in display (see governed_by fields); story/corner rule details render in
// the detail/X-ray surface from provenance notes.
import elginDevelopmentCode from "./elgin-development-code.json" with { type: "json" };
import grandCountyUt from "./grand-county-ut.json" with { type: "json" };
import lemhiCountyId from "./lemhi-county-id.json" with { type: "json" };
import bastropTx from "./bastrop-tx.json" with { type: "json" };
import bastropCityTx from "./bastrop-city-tx.json" with { type: "json" };
import bastropDevelopmentCode from "./bastrop-development-code.json" with { type: "json" };
import austinTx from "./austin-tx.json" with { type: "json" };
import pflugervilleTx from "./pflugerville-tx.json" with { type: "json" };
import sanAntonioTx from "./san-antonio-tx.json" with { type: "json" };
import utahUnincorporated from "./utah-unincorporated.json" with { type: "json" };
import idahoUnincorporated from "./idaho-unincorporated.json" with { type: "json" };

export type { SetbackDistrict, SetbackTable } from "./table-types.js";
import type { SetbackDistrict, SetbackTable } from "./table-types.js";

import {
  setbackTableFromBastropPerParcelRecord,
} from "./bastrop-per-parcel-record.js";

const SETBACK_TABLES: Readonly<Record<string, SetbackTable>> = {
  "grand-county-ut": grandCountyUt as SetbackTable,
  "lemhi-county-id": lemhiCountyId as SetbackTable,
  "bastrop-tx": bastropTx as SetbackTable,
  // Historical B3 Place Type rows (REPEALED by Ord. 2026-06 / 2026-04-14).
  // Kept for C1 hash-lock + archival getSetbackTable("bastrop-city-tx") only.
  // getSetbackTableForZoning MUST NOT serve these as current law (WDLL STEP 3).
  "bastrop-city-tx": bastropCityTx as SetbackTable,
  // CURRENT City of Bastrop Euclidean setbacks (BDC Sec. 14.02.003 / Ord. 2026-06).
  // Sole authoring survivor for city Euclidean VALUES (WDLL STEP 3 item 1+3).
  "bastrop-development-code": bastropDevelopmentCode as SetbackTable,
  "elgin-development-code": elginDevelopmentCode as SetbackTable,
  // Tier-1 stamps cityKey/jurisdictionKey as elgin-tx — alias to the ratified table.
  "elgin-tx": elginDevelopmentCode as SetbackTable,
  "austin-tx": austinTx as SetbackTable,
  "pflugerville-tx": pflugervilleTx as SetbackTable,
  "san-antonio-tx": sanAntonioTx as SetbackTable,
  "utah-unincorporated": utahUnincorporated as SetbackTable,
  "idaho-unincorporated": idahoUnincorporated as SetbackTable,
};

export const SETBACK_JURISDICTION_KEYS = Object.keys(SETBACK_TABLES);

function normalizeJurisdictionKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/** Repealed B3 Place Types — must not be served as current setback law. */
function isRepealedB3PlaceType(code: string): boolean {
  return (
    /^P-[1-5](?:$|[-_\s])/.test(code) ||
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(code)
  );
}

/** BDC districts whose scalars live on layer 23 only (not ordinance chart). */
export function isBdcPerParcelDistrictCode(code: string): boolean {
  return /^(MU|GC|PDD|PI|IND|OS)(?:$|[-_\s])/.test(code) ||
    /^P\/OS(?:$|[-_\s])/.test(code) ||
    /^P-OS(?:$|[-_\s])/.test(code);
}

/** BDC Euclidean districts with ordinance-text scalar rows in bastrop-development-code. */
function isBdcEuclideanCode(code: string): boolean {
  return /^(SF-[123]|RR)(?:$|[-_\s])/.test(code);
}

/**
 * Any known BDC Chapter 14 district stamp (Euclidean + conditional).
 * Conditional codes (MU/GC/…) still route to the BDC table so callers
 * honest-decline on the missing row (CORRECTION C) instead of falling
 * through to the legacy bastrop-tx county table.
 */
function isKnownBdcDistrictCode(code: string): boolean {
  return isBdcEuclideanCode(code) || isBdcPerParcelDistrictCode(code);
}

function isBastropCityJurisdiction(normalizedKey: string): boolean {
  return (
    normalizedKey === "bastrop-tx" ||
    normalizedKey === "bastrop-city-tx" ||
    normalizedKey === "bastrop-development-code" ||
    normalizedKey === "bastrop-per-parcel-record"
  );
}

export type SetbackTableResolveOptions = {
  /**
   * Pre-fetched Bastrop layer-23 record (AMENDMENT 2+3). When set for a
   * Bastrop city jurisdiction, NUMBERS come from here — not
   * bastrop-development-code.json chart rows.
   */
  bastropPerParcelRecord?: import("./bastrop-per-parcel-record.js").BastropPerParcelSetbackParsed;
  /** District code for per-parcel row labeling (defaults to zoningCode arg). */
  districtCode?: string;
};

function tableHasDistrict(table: SetbackTable, code: string): boolean {
  const wanted = leadingDistrictToken(code);
  if (!wanted) return false;
  return table.districts.some(
    (d) => leadingDistrictToken(d.district_name) === wanted,
  );
}

/**
 * Returns the setback table for a jurisdiction key, or null if no table
 * exists. The briefing engine should treat null as "no codified
 * dimensional rules available — fall back to base IBC/IRC".
 */
export function getSetbackTable(jurisdictionKey: string): SetbackTable | null {
  return SETBACK_TABLES[normalizeJurisdictionKey(jurisdictionKey)] ?? null;
}

/**
 * Resolve the table for a parcel's stamped zoning code.
 *
 * City of Bastrop (current law = per-parcel layer 23, AMENDMENT 2+3):
 *   - When `options.bastropPerParcelRecord` is supplied, NUMBERS come from
 *     that record (cited to Ordinance_Link). Chart table is verification only.
 *   - Without a per-parcel record, returns bastrop-development-code for
 *     edition/citation lookup only — callers MUST NOT use chart scalars as
 *     warm authors for Bastrop city (fetch layer 23 first).
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *   - MU / GC / PDD (layer 23 only): without `bastropPerParcelRecord` → null
 *     so callers fetch layer 23 instead of honest-decline on missing chart rows.
 *
 * County / other jurisdictions: fall through to the keyed table
 * (e.g. bastrop-tx legacy R-MD rows for non-city codes).
 */
export function getSetbackTableForZoning(
  jurisdictionKey: string,
  zoningCode: string | null | undefined,
  options?: SetbackTableResolveOptions,
): SetbackTable | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  const code = (zoningCode ?? "").trim().toUpperCase();

  if (options?.bastropPerParcelRecord && isBastropCityJurisdiction(normalized)) {
    const district = (options.districtCode ?? code).trim();
    if (!district) return null;
    return setbackTableFromBastropPerParcelRecord(
      options.bastropPerParcelRecord,
      district,
    );
  }

  if (isBastropCityJurisdiction(normalized)) {
    if (code && isRepealedB3PlaceType(code)) {
      return null;
    }

    // County-only legacy codes (R-MD, etc.) on bastrop-tx key — not city BDC.
    if (
      normalized === "bastrop-tx" &&
      code &&
      !isKnownBdcDistrictCode(code)
    ) {
      return SETBACK_TABLES["bastrop-tx"] ?? null;
    }

    // R13 (AMENDMENT 8): city BDC districts require layer-23 per-parcel record.
    return null;
  }

  if (normalized === "elgin-tx" || normalized === "elgin-development-code") {
    return SETBACK_TABLES["elgin-development-code"] ?? null;
  }

  return SETBACK_TABLES[normalized] ?? null;
}

/**
 * Look up a single zoning district within a jurisdiction. Case-
 * insensitive on the district name to absorb the small spelling
 * differences between the GIS layer and the ordinance PDF.
 */
export function getSetbackDistrict(
  jurisdictionKey: string,
  districtName: string,
): SetbackDistrict | null {
  const table = getSetbackTable(jurisdictionKey);
  if (!table) return null;
  const wanted = districtName.trim().toLowerCase();
  return (
    table.districts.find(
      (d) => d.district_name.toLowerCase() === wanted,
    ) ?? null
  );
}

export function listSetbackTables(): SetbackTable[] {
  return Object.values(SETBACK_TABLES);
}

export {
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
  BASTROP_ZONE_TYPE_CLASS,
  fetchBastropPerParcelSetbackRecord,
  flagBastropChartDisagreement,
  parseBastropPerParcelAttributes,
  parseScalarSetbackFeet,
  parseSideSetbackText,
  resolveBastropLayer23DominantRow,
  selectBastropLayer23Attributes,
  setbackTableFromBastropPerParcelRecord,
  type BastropChartDisagreement,
  type BastropPerParcelHonestDecline,
  type BastropPerParcelSetbackParsed,
  type FetchBastropPerParcelOptions,
  type ParsedSideSetback,
} from "./bastrop-per-parcel-record.js";
export {
  BASTROP_AUTHORITATIVE_SETBACK_ADAPTER,
  bastropSetbackPendingRewarmReason,
  isAuthoritativeBastropCitySetbackSource,
  isBastropCountyParcelNodeId,
  isStaleBastropCitySetbackRule,
  requiresPerParcelSetbackRecord,
} from "./bastrop-setback-currency.js";
