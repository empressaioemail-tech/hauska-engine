#!/usr/bin/env tsx
/**
 * P-260 — the wired-city registry table: every city this engine routes, per county,
 * with its registry row, its table status and its ATOM COHORT count, beside the LEDGER
 * count for the same city.
 *
 * WHY A SCRIPT AND NOT A HAND-TYPED TABLE. The mission asks for "a row for every wired city
 * whose cohort count matches the ledger". A hand-typed roster answers a different question
 * ("the cities I happened to list") and drifts the first time a city is wired; this table is
 * generated from the SAME registers the setback writer binds against
 * (`setback-writer/city-binding.ts#listWiredCityBindings` — zoning staging + the jurisdiction
 * registry), so a city that becomes wireable appears here with no edit to this file.
 *
 * THE COUNTING RULES (they travel with every figure):
 *
 *   Cohort count — active `setback-rule` + `buildable-envelope` atoms in the atoms store
 *   whose `parcelNodeId` is in this county and whose `jurisdictionTenant` equals
 *   `breadth_<fips>_<city>`. That is the tenant the breadth bake itself writes
 *   (`descriptorForCounty`, `bake-from-tier1-snapshot.ts`), so the cohort is read off the
 *   value storage persists rather than reconstructed from a naming guess.
 *
 *   Ledger count — the same city in the ledger store (`parcel_record_cell`). This is
 *   UNMEASURED unless the caller names the expression that attributes a LEDGER ROW to a city
 *   (`--ledger-city-field`): the cell's city attribution is the factory's schema, and a lane
 *   that guessed an expression here would be prescribing a reconstruction. An UNMEASURED
 *   ledger column is reported as UNMEASURED with its reason, never as zero.
 *
 * READ-ONLY: SELECT statements only, no writer, no apply. The atoms read takes the P-281
 * heavy-scan lease on the store HOST for its duration (the session holds it; see
 * `p263-envelope-outcome-census.mts` for why the lease is not taken inside the process).
 *
 * Usage:
 *   pnpm -C packages/engine-core exec tsx scripts/p260-wired-city-registry.mts \
 *       [--counties 48021,48055,...] [--json <out>] [--ledger-city-field "<sql expression>"]
 */
import { writeFileSync } from "node:fs";

import postgres from "postgres";

import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { listWiredCityBindings } from "../src/setback-writer/city-binding.js";

const SIX_COUNTIES = ["48021", "48055", "48209", "48309", "48453", "48491"];
const COUNTY_NAME = {
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48209": "Hays",
  "48309": "McLennan",
  "48453": "Travis",
  "48491": "Williamson",
};

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

const argv = process.argv.slice(2);
const counties = (argValue(argv, "--counties") ?? SIX_COUNTIES.join(","))
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const jsonOut = argValue(argv, "--json");
const ledgerCityField = argValue(argv, "--ledger-city-field");

const url = resolveSubstrateDatabaseUrl();
const hostFingerprint = (() => {
  try {
    return new URL(url).host.replace(/\.[a-z0-9-]+\.aws\.neon\.tech$/i, ".…neon.tech");
  } catch {
    return "unparseable";
  }
})();

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

/** tenant -> { setbackRule, buildableEnvelope } */
async function readCohorts() {
  const rows = await sql`
    SELECT body->>'jurisdictionTenant' AS tenant,
           body->>'entityType' AS kind,
           count(*)::int AS n
    FROM atoms
    WHERE entity_type IN ('setback-rule', 'buildable-envelope')
      AND coalesce(body->>'status', 'active') = 'active'
      AND substring(body->>'parcelNodeId' from 1 for 5) = ANY(${counties})
    GROUP BY 1, 2
  `;
  const byTenant = new Map();
  for (const r of rows) {
    const entry = byTenant.get(r.tenant) ?? { setbackRule: 0, buildableEnvelope: 0, total: 0 };
    if (r.kind === "setback-rule") entry.setbackRule += r.n;
    else if (r.kind === "buildable-envelope") entry.buildableEnvelope += r.n;
    entry.total += r.n;
    byTenant.set(r.tenant, entry);
  }
  return byTenant;
}

/** The tenant the breadth bake writes for a city: breadth_<fips>_<city segment>. */
function tenantForCity(fips, cityKey) {
  return `breadth_${fips}_${cityKey.replace(/-/g, "_")}`;
}

try {
  const cohorts = await readCohorts();

  const rows = [];
  for (const fips of counties) {
    for (const city of listWiredCityBindings(fips)) {
      const tenant = tenantForCity(fips, city.cityKey);
      const cohort = cohorts.get(tenant) ?? { setbackRule: 0, buildableEnvelope: 0, total: 0 };
      rows.push({
        county: fips,
        countyName: COUNTY_NAME[fips] ?? fips,
        cityKey: city.cityKey,
        countyFipsOfBinding: city.counties.join(","),
        derivation: city.derivation,
        tableLanded: city.tableLanded,
        tableNotLandedReason: city.tableNotLandedReason,
        cohortTenant: tenant,
        cohort: {
          setbackRule: cohort.setbackRule,
          buildableEnvelope: cohort.buildableEnvelope,
          total: cohort.total,
        },
        ledger: { state: "UNMEASURED", reason: null, count: null },
      });
    }
  }

  /**
   * The ledger half. Only run when the caller names the city attribution; the expression is
   * interpolated as an identifier-free SQL fragment the CALLER owns, and the scope is bound
   * to the six counties so a mistake cannot widen the read.
   */
  if (ledgerCityField) {
    const ledgerUrl = process.env.FACTORY_DATABASE_URL_RO;
    if (!ledgerUrl) {
      for (const r of rows) {
        r.ledger.reason = "FACTORY_DATABASE_URL_RO is not set in this session";
      }
    } else {
      const ledger = postgres(ledgerUrl, { ssl: "require", max: 1, prepare: false });
      try {
        const counts = await ledger.unsafe(`
          SELECT split_part(place_key, ':', 1) AS fips,
                 ${ledgerCityField} AS city,
                 count(*)::int AS n
          FROM parcel_record_cell
          WHERE split_part(place_key, ':', 1) = ANY($1)
          GROUP BY 1, 2`);
        const byCity = new Map(
          counts.map((c) => [`${c.fips}:${String(c.city ?? "").toLowerCase()}`, c.n]),
        );
        for (const r of rows) {
          const n = byCity.get(`${r.county}:${r.cityKey}`);
          if (n === undefined) {
            r.ledger = {
              state: "ZERO-ROWS",
              reason: `no ledger row attributes a cell to this city via ${ledgerCityField}`,
              count: 0,
            };
          } else {
            r.ledger = { state: "measured", reason: null, count: n };
          }
        }
      } finally {
        await ledger.end({ timeout: 5 });
      }
    }
  } else {
    for (const r of rows) {
      r.ledger.reason =
        "no city attribution for ledger rows was named (--ledger-city-field); the cell's city column is the factory's schema and this lane does not guess it";
    }
  }

  const artifact = {
    instrument: "p260-wired-city-registry",
    mode: "READ-ONLY (SELECT only; no write lease consumed by the process)",
    ranAt: new Date().toISOString(),
    storeHostFingerprint: hostFingerprint,
    countingRule: {
      wiredCity:
        "setback-writer/city-binding.ts#listWiredCityBindings (zoning staging + jurisdiction registry), unincorporated rows excluded",
      cohort:
        "active setback-rule + buildable-envelope atoms with body->>'jurisdictionTenant' = breadth_<fips>_<city> in the atoms store",
      ledger: ledgerCityField
        ? `parcel_record_cell rows in the same county grouped by ${ledgerCityField}`
        : "UNMEASURED — no city attribution named",
    },
    counties,
    rows,
    totals: {
      cities: rows.length,
      withTable: rows.filter((r) => r.tableLanded).length,
      withoutTable: rows.filter((r) => !r.tableLanded).length,
      withoutTableWithReason: rows.filter((r) => !r.tableLanded && r.tableNotLandedReason).length,
      citiesWithZeroCohort: rows.filter((r) => r.cohort.total === 0).length,
    },
  };

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));

  console.log(
    JSON.stringify(
      {
        mode: artifact.mode,
        storeHostFingerprint,
        totals: artifact.totals,
        rows: rows.map((r) => ({
          county: r.countyName,
          city: r.cityKey,
          table: r.tableLanded ? "landed" : `none — ${r.tableNotLandedReason}`,
          cohort: r.cohort,
          ledger: r.ledger.state === "measured" ? r.ledger.count : r.ledger.state,
        })),
        json: jsonOut ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
