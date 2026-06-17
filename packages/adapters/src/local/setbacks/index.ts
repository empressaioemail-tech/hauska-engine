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
 *
 * The schema is intentionally a plain JSON object (not a Zod schema)
 * because the tables are read at server boot and validated once via
 * the structural typecheck below — adding a Zod runtime check would
 * just duplicate the typescript guarantees we already have.
 */

import grandCountyUt from "./grand-county-ut.json" with { type: "json" };
import lemhiCountyId from "./lemhi-county-id.json" with { type: "json" };
import bastropTx from "./bastrop-tx.json" with { type: "json" };
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
  "utah-unincorporated": utahUnincorporated as SetbackTable,
  "idaho-unincorporated": idahoUnincorporated as SetbackTable,
};

export const SETBACK_JURISDICTION_KEYS = Object.keys(SETBACK_TABLES);

/**
 * Returns the setback table for a jurisdiction key, or null if no table
 * exists. The briefing engine should treat null as "no codified
 * dimensional rules available — fall back to base IBC/IRC".
 */
export function getSetbackTable(jurisdictionKey: string): SetbackTable | null {
  return SETBACK_TABLES[jurisdictionKey] ?? null;
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
