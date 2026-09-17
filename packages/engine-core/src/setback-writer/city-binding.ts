/**
 * City-scoped setback binding. A county FIPS is not a city. A raw source
 * key is not a resolution. Membership comes from two existing registers
 * (zoning staging + jurisdiction registry), never from a guessed FIPS.
 */

import {
  SETBACK_ENGINE_REGISTRY,
  CORPUS_SETBACK_JURISDICTION_KEYS,
  getSetbackTable,
  requiresPerParcelSetbackRecord,
} from "@hauska-engine/adapters";

import {
  loadJurisdictionRegistryRowsForFips,
  type JurisdictionRegistryRow,
} from "../registry/jurisdiction-registry.js";
import {
  ZONING_STAGING_REGISTRY,
  type ZoningCityRegistryEntry,
} from "../zoning-staging/registry.js";
import { normalizeCityKey } from "../property-reasoning/setback-table-from-adapter.js";

export const CITY_REQUIRED = "CITY_REQUIRED";
export const COUNTY_REQUIRED = "COUNTY_REQUIRED";
export const JURISDICTION_BINDING_UNRESOLVED = "JURISDICTION_BINDING_UNRESOLVED";

export type NamedRuleSource = {
  id: string;
  citation: string;
};

export type SetbackCityBinding = {
  cityKey: string;
  countyFips: string;
  counties: readonly string[];
  tableLanded: boolean;
  namedSource: NamedRuleSource | null;
  /**
   * P-260 — why no table landed, spelled out instead of left as a null
   * `namedSource`. A city with no ruled table must SAY SO: the pre-P-260 shape
   * (`tableLanded: false, namedSource: null`) told a caller nothing it could
   * report, which is how a silent absence reads identically to "not checked".
   * Null only when `tableLanded` is true.
   */
  tableNotLandedReason: string | null;
  districtAliases: Readonly<Record<string, string>>;
  derivations: readonly string[];
};

export class SetbackWriterRefuseError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "SetbackWriterRefuseError";
    this.code = code;
    this.details = details;
  }
}

function hyphenate(raw: string): string {
  return raw.trim().toLowerCase().replace(/_/g, "-");
}

function isUnincorporatedRow(row: JurisdictionRegistryRow): boolean {
  return (
    row.zoningRegime === "unzoned" ||
    row.rowId.toLowerCase().includes("unincorporated")
  );
}

function aliasesFromStaging(entry: ZoningCityRegistryEntry): Record<string, string> {
  return { ...(entry.codeDomainMap ?? {}) };
}

function aliasesFromRegistry(row: JurisdictionRegistryRow): Record<string, string> {
  return { ...(row.warmRunner?.gisDistrictAliases ?? {}) };
}

function tableLandedForCity(cityKey: string): boolean {
  if (requiresPerParcelSetbackRecord(cityKey)) return false;
  const table = getSetbackTable(cityKey);
  return Boolean(table && Array.isArray(table.districts) && table.districts.length > 0);
}

/**
 * P-260 — why this city key has no table, in words a close can print.
 * Distinguishes the three real cases so "no table" is never read as "no
 * setback law": authored from a live per-parcel record by standing ruling (R13),
 * carried by the corpus but not served by this engine, or genuinely not in the
 * corpus at all (the city is not yet researched).
 */
export function setbackTableNotLandedReason(cityKey: string): string {
  const key = hyphenate(cityKey);
  if (requiresPerParcelSetbackRecord(key)) {
    return "authored from the city's live per-parcel setback record, not a codified table (R13) — no table row is expected";
  }
  const notServed = SETBACK_ENGINE_REGISTRY.find((r) => r.key === key);
  if (notServed && !notServed.served) return notServed.reason;
  if (CORPUS_SETBACK_JURISDICTION_KEYS.includes(key)) {
    // Carried by the corpus but not in this engine's served policy — a registry
    // that is not total, which the divergence test refuses; never silent here.
    return "corpus carries this table but this engine's setback registry does not serve it — registry gap";
  }
  return "no ruled setback table: @empressaio/setback-corpus does not carry this city key";
}

export function nameSetbackTableSource(cityKey: string): NamedRuleSource | null {
  const table = getSetbackTable(cityKey);
  if (!table) return null;
  const citation =
    (typeof table.jurisdictionDisplayName === "string" &&
    table.jurisdictionDisplayName.trim()
      ? table.jurisdictionDisplayName.trim()
      : null) ??
    table.districts[0]?.citation_url?.trim() ??
    null;
  const id = table.jurisdictionKey?.trim() ?? "";
  if (!id || !citation) return null;
  return { id, citation };
}

function candidatesForCounty(countyFips: string): Array<{
  cityKey: string;
  counties: string[];
  aliases: Record<string, string>;
  derivation: string;
}> {
  const out: Array<{
    cityKey: string;
    counties: string[];
    aliases: Record<string, string>;
    derivation: string;
  }> = [];

  for (const entry of Object.values(ZONING_STAGING_REGISTRY)) {
    const counties = [entry.parentCountyFips, ...(entry.allCountyFips ?? [])].filter(
      (c, i, all) => /^\d{5}$/.test(c) && all.indexOf(c) === i,
    );
    if (!counties.includes(countyFips)) continue;
    out.push({
      cityKey: entry.cityKey,
      counties,
      aliases: aliasesFromStaging(entry),
      derivation: `zoning-staging:${entry.cityKey}`,
    });
  }

  for (const row of loadJurisdictionRegistryRowsForFips(countyFips)) {
    if (isUnincorporatedRow(row)) continue;
    if (row.zoningRegime !== "euclidean-zoned") continue;
    const keys = new Set<string>();
    if (row.warmRunner?.layer23CityKey) keys.add(hyphenate(row.warmRunner.layer23CityKey));
    if (row.warmRunner?.descriptorId) keys.add(hyphenate(row.warmRunner.descriptorId));
    if (row.warmRunner?.jurisdictionLabel) keys.add(hyphenate(row.warmRunner.jurisdictionLabel));
    for (const cityKey of keys) {
      out.push({
        cityKey,
        counties: [row.fips],
        aliases: aliasesFromRegistry(row),
        derivation: `jurisdiction-registry:${row.rowId}`,
      });
    }
  }

  return out;
}

/**
 * Resolve an incorporated-city binding. County membership must be named by
 * staging or the jurisdiction registry. A table key alone is not a binding.
 */
export function resolveSetbackCityBinding(
  cityKeyRaw: string | null | undefined,
  countyFipsRaw: string | null | undefined,
): SetbackCityBinding {
  const countyFips = String(countyFipsRaw ?? "").trim();
  if (!/^\d{5}$/.test(countyFips)) {
    throw new SetbackWriterRefuseError(COUNTY_REQUIRED, { county: countyFipsRaw ?? null });
  }
  const cityKey = normalizeCityKey(cityKeyRaw);
  if (!cityKey) {
    throw new SetbackWriterRefuseError(CITY_REQUIRED, { city: cityKeyRaw ?? null });
  }
  if (cityKey.includes("unincorporated")) {
    throw new SetbackWriterRefuseError(JURISDICTION_BINDING_UNRESOLVED, {
      city: cityKey,
      county: countyFips,
      reason: "unincorporated is not a city binding",
    });
  }

  const matches = candidatesForCounty(countyFips).filter((c) => c.cityKey === cityKey);
  if (matches.length === 0) {
    throw new SetbackWriterRefuseError(JURISDICTION_BINDING_UNRESOLVED, {
      city: cityKey,
      county: countyFips,
      reason: "city key is not a resolved incorporated-city binding in this county",
    });
  }

  const counties = [...new Set(matches.flatMap((m) => m.counties))];
  const aliases = Object.assign({}, ...matches.map((m) => m.aliases));
  const derivations = [...new Set(matches.map((m) => m.derivation))];
  const landed = tableLandedForCity(cityKey);

  return {
    cityKey,
    countyFips,
    counties,
    tableLanded: landed,
    namedSource: landed ? nameSetbackTableSource(cityKey) : null,
    tableNotLandedReason: landed ? null : setbackTableNotLandedReason(cityKey),
    districtAliases: aliases,
    derivations,
  };
}
