/**
 * Comptroller SPDPID registry loader for optional tax-rate enrichment.
 *
 * Rates are sparse (~425/3028 entities carry totl_rate_pc>0). Missing rate
 * after a spatial hit is honest — never substitute zero.
 */

import { readFileSync } from "node:fs";

export interface ComptrollerRegistryEntry {
  spdPublId: string;
  entityName: string;
  entityType: string;
  countyCode: string;
  reportYear: number;
  totalRatePc: number | null;
  effectiveAvtRatePc: number | null;
}

export interface ComptrollerTaxRateEnrichment {
  totalRatePc?: number;
  effectiveAvtRatePc?: number;
  reportYear?: number;
  registrySpdPublId: string;
  source: "comptroller-spdpid";
}

const TCEQ_TYPE_TO_COMPTROLLER: Record<string, string> = {
  MUD: "Municipal Utility District",
  WCID: "Water Control and Improvement District",
  MMD: "Municipal Management District",
  MD: "Municipal Management District",
  FWSD: "Fresh Water Supply District",
  SUD: "Special Utility District",
  WID: "Water Improvement District",
  DD: "Drainage District",
  LID: "Levee Improvement District",
  ID: "Irrigation District",
  ND: "Navigation District",
  RA: "River Authority",
  RD: "Regional District",
  OTH: "Other",
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === "," && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countyFipsFromComptrollerCode(countyCode: string): string | null {
  const n = Number(countyCode);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `48${String(n).padStart(3, "0")}`;
}

export function loadComptrollerRegistryFromCsv(
  csvPath: string,
): Map<string, ComptrollerRegistryEntry> {
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const hdr = parseCsvLine(lines[0]!);
  const ix = (name: string) => hdr.indexOf(name);
  const latestByPub = new Map<string, ComptrollerRegistryEntry>();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    const pub = cols[ix("spd_publ_id")]!;
    const yr = Number(cols[ix("rpt_yr")]);
    const prev = latestByPub.get(pub);
    if (prev && yr <= prev.reportYear) continue;
    const totalRaw = cols[ix("totl_rate_pc")];
    const avtRaw = cols[ix("avt_eff_rate_pc")];
    const totalRatePc =
      totalRaw && Number(totalRaw) > 0 ? Number(totalRaw) : null;
    const effectiveAvtRatePc =
      avtRaw && Number(avtRaw) > 0 ? Number(avtRaw) : null;
    latestByPub.set(pub, {
      spdPublId: pub,
      entityName: cols[ix("ent_dis_nm")]!,
      entityType: cols[ix("ent_ty_tx")]!,
      countyCode: cols[ix("cnty_cd")]!,
      reportYear: yr,
      totalRatePc,
      effectiveAvtRatePc,
    });
  }

  const byKey = new Map<string, ComptrollerRegistryEntry>();
  for (const entry of latestByPub.values()) {
    const fips = countyFipsFromComptrollerCode(entry.countyCode);
    if (!fips) continue;
    const key = `${fips}|${entry.entityType}|${normalizeName(entry.entityName)}`;
    byKey.set(key, entry);
  }
  return byKey;
}

export function lookupComptrollerTaxRate(
  registry: Map<string, ComptrollerRegistryEntry>,
  opts: {
    countyFips: string;
    districtType: string;
    districtName: string;
  },
): ComptrollerTaxRateEnrichment | undefined {
  const entityType = TCEQ_TYPE_TO_COMPTROLLER[opts.districtType.trim()] ?? null;
  if (!entityType) return undefined;
  const key = `${opts.countyFips}|${entityType}|${normalizeName(opts.districtName)}`;
  const hit = registry.get(key);
  if (!hit) return undefined;
  if (hit.totalRatePc == null && hit.effectiveAvtRatePc == null) return undefined;
  return {
    ...(hit.totalRatePc != null ? { totalRatePc: hit.totalRatePc } : {}),
    ...(hit.effectiveAvtRatePc != null
      ? { effectiveAvtRatePc: hit.effectiveAvtRatePc }
      : {}),
    reportYear: hit.reportYear,
    registrySpdPublId: hit.spdPublId,
    source: "comptroller-spdpid",
  };
}

export function tceqCountyFipsFromFields(
  fips3: string | null | undefined,
  txCnty: string | null | undefined,
): string | null {
  const raw = (fips3 ?? txCnty ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `48${String(n).padStart(3, "0")}`;
}
