/**
 * City-scoped setback binding. A county FIPS is not a city. A raw source
 * key is not a resolution. Membership comes from two existing registers
 * (zoning staging + jurisdiction registry), never from a guessed FIPS.
 */

import {
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
    districtAliases: aliases,
    derivations,
  };
}
