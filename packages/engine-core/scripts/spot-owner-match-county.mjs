#!/usr/bin/env node
/**
 * Spot-audit owner-match for a county (breadth WDLL item 4).
 * Joins txgio_parcel.owner_name to cad_property.owner on prop_id.
 * Prints evaluateJoinIntegrity-equivalent rate (verbatim for ledger).
 *
 *   CORTEX_DATABASE_URL=... pnpm --filter @hauska-engine/engine-core exec \
 *     tsx scripts/spot-owner-match-county.mjs --county=48055 --sample=200
 */

import postgres from "postgres";

import { resolveDeclaredCadVintage } from "../src/cad-vintage/resolve-declared-cad-vintage.ts";

function parseArgs(argv) {
  const out = { county: null, sample: 200, join: "prop_id" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length);
    else if (a === "--sample") out.sample = Number(argv[++i] || 200);
    else if (a.startsWith("--sample="))
      out.sample = Number(a.slice("--sample=".length));
    else if (a === "--join") out.join = String(argv[++i] || "prop_id").trim();
    else if (a.startsWith("--join=")) out.join = a.slice("--join=".length);
  }
  return out;
}

function normAddr(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ownerLeadToken(raw) {
  if (!raw || typeof raw !== "string") return "";
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\b(LLC|INC|LTD|LP|JR|SR|II|III|IV|TRUST|ETAL|ET AL)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.split(" ")[0] || "";
}

function ownersAgree(a, b) {
  const la = ownerLeadToken(a);
  const lb = ownerLeadToken(b);
  if (!la || !lb) return false;
  if (la === lb) return true;
  const shorter = la.length <= lb.length ? la : lb;
  const longer = la.length <= lb.length ? lb : la;
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
  return false;
}

const args = parseArgs(process.argv.slice(2));
const cortexUrl = process.env.CORTEX_DATABASE_URL?.trim();
if (!args.county || !cortexUrl) {
  console.error("FATAL: --county=FIPS and CORTEX_DATABASE_URL required");
  process.exit(1);
}

const sql = postgres(cortexUrl, { max: 1, ssl: "require", prepare: false });
const declared = resolveDeclaredCadVintage(args.county);
const taxYear = declared.taxYear;

try {
  const pairs =
    args.join === "address"
      ? await sql`
          select t.prop_id,
                 t.owner_name as txgio_owner,
                 c.owner_name as cad_owner
          from txgio_parcel t
          join cad_property c
            on c.county_fips = t.county_fips
           and upper(regexp_replace(coalesce(c.situs_address,''), '[^A-Za-z0-9 ]', ' ', 'g'))
             = upper(regexp_replace(coalesce(t.situs_address,''), '[^A-Za-z0-9 ]', ' ', 'g'))
           and c.tax_year = ${taxYear}
          where t.county_fips = ${args.county}
            and coalesce(t.owner_name, '') <> ''
            and coalesce(c.owner_name, '') <> ''
            and coalesce(t.situs_address, '') <> ''
          order by md5(t.prop_id || t.owner_name)
          limit ${args.sample}
        `
      : await sql`
          select t.prop_id,
                 t.owner_name as txgio_owner,
                 c.owner_name as cad_owner
          from txgio_parcel t
          join cad_property c
            on c.county_fips = t.county_fips
           and c.prop_id = t.prop_id
           and c.tax_year = ${taxYear}
          where t.county_fips = ${args.county}
            and coalesce(t.owner_name, '') <> ''
            and coalesce(c.owner_name, '') <> ''
          order by md5(t.prop_id || t.owner_name)
          limit ${args.sample}
        `;

  let agreed = 0;
  let informative = 0;
  for (const p of pairs) {
    const ok = ownersAgree(p.txgio_owner, p.cad_owner);
    if (ownerLeadToken(p.txgio_owner) && ownerLeadToken(p.cad_owner)) {
      informative += 1;
      if (ok) agreed += 1;
    }
  }
  const rate = informative > 0 ? agreed / informative : 0;
  const minRate = 0.5;
  const verdict =
    informative < 30
      ? "insufficient-sample"
      : rate >= minRate
        ? "pass"
        : "block";

  const report = {
    event: "breadth.owner-match-spot",
    countyFips: args.county,
    join: args.join,
    sampled: pairs.length,
    informative,
    agreed,
    ownerMatchRate: Number(rate.toFixed(4)),
    integrityVerdict: verdict,
    minRate,
    verbatim: `owner-match(${args.join}) rate ${(rate * 100).toFixed(1)}% (${agreed}/${informative}) sample=${pairs.length} verdict=${verdict}`,
  };
  void normAddr;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
