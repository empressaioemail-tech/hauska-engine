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

import grandCountyUt from "./grand-county-ut.json" with { type: "json" };
import lemhiCountyId from "./lemhi-county-id.json" with { type: "json" };
import bastropTx from "./bastrop-tx.json" with { type: "json" };
import bastropCityTx from "./bastrop-city-tx.json" with { type: "json" };
import bastropDevelopmentCode from "./bastrop-development-code.json" with { type: "json" };
import austinTx from "./austin-tx.json" with { type: "json" };
import sanAntonioTx from "./san-antonio-tx.json" with { type: "json" };
import utahUnincorporated from "./utah-unincorporated.json" with { type: "json" };
import idahoUnincorporated from "./idaho-unincorporated.json" with { type: "json" };

/** Per locked decision #9 — one row per zoning district per jurisdiction. */
export interface SetbackDistrict {
  district_name: string;
  front_ft: number;
  rear_ft: number;
  side_ft: number;
  side_corner_ft: number;
  max_height_ft: number;
  max_lot_coverage_pct: number;
  max_impervious_pct: number;
  citation_url: string;
  /** Fan-gift per-field provenance (optional on legacy tables). */
  provenance?: Record<string, unknown>;
}

export interface SetbackTable {
  jurisdictionKey: string;
  jurisdictionDisplayName: string;
  /** Optional context note for fallback / statewide-default tables. */
  note?: string;
  districts: SetbackDistrict[];
}

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
  "austin-tx": austinTx as SetbackTable,
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
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(code) ||
    /^PDD(?:$|[-_\s])/.test(code)
  );
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
  return (
    isBdcEuclideanCode(code) ||
    /^(MU|GC|PI|IND|OS)(?:$|[-_\s])/.test(code) ||
    /^P\/OS(?:$|[-_\s])/.test(code) ||
    /^P-OS(?:$|[-_\s])/.test(code)
  );
}

function isBastropCityJurisdiction(normalizedKey: string): boolean {
  return (
    normalizedKey === "bastrop-tx" ||
    normalizedKey === "bastrop-city-tx" ||
    normalizedKey === "bastrop-development-code"
  );
}

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
 * City of Bastrop (current law = BDC / Ord. 2026-06):
 *   - SF-1 / SF-2 / SF-3 / RR (and any clean match in the BDC table) →
 *     bastrop-development-code (ordinance-text scalars).
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC, PDD) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *     Historical B3 remains available only via getSetbackTable("bastrop-city-tx").
 *   - Conditional BDC districts without rows (MU/GC/PI/IND/P/OS/…) → BDC
 *     table returned; callers honest-decline on missing district row
 *     (CORRECTION C — no fabricated scalars).
 *
 * County / other jurisdictions: fall through to the keyed table
 * (e.g. bastrop-tx legacy R-MD rows for non-city codes).
 */
export function getSetbackTableForZoning(
  jurisdictionKey: string,
  zoningCode: string | null | undefined,
): SetbackTable | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  const code = (zoningCode ?? "").trim().toUpperCase();

  if (isBastropCityJurisdiction(normalized)) {
    if (code && isRepealedB3PlaceType(code)) {
      // Explicit: repealed B3 is not current law. Honest-decline.
      return null;
    }

    const bdc = SETBACK_TABLES["bastrop-development-code"] ?? null;
    if (!bdc) return null;

    if (
      !code ||
      isKnownBdcDistrictCode(code) ||
      tableHasDistrict(bdc, code) ||
      normalized === "bastrop-city-tx" ||
      normalized === "bastrop-development-code"
    ) {
      return bdc;
    }

    // bastrop-tx + non-BDC code (e.g. legacy county R-MD): fall through.
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
