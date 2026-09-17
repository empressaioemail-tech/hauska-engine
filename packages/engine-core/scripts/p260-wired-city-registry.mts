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

import {
  CORPUS_SETBACK_JURISDICTION_KEYS,
  SETBACK_ENGINE_REGISTRY,
} from "@hauska-engine/adapters";

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
const storeHostFingerprint = (() => {
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

/**
 * The two spellings the SAME city appears under. The registry keys cities by the corpus/city
 * key (`san-marcos-tx`); the breadth bake writes `jurisdictionTenant` from the raw CAD
 * situsCity (`san_marcos`), and BOTH spellings are on record for one city (measured
 * 2026-09-17: `breadth_48453_austin-tx` 301,404 atoms beside `breadth_48209_austin` 7,363).
 * A cohort read that accepted only one spelling would report a city as empty that is not.
 */
function tenantSpellings(fips, cityKey) {
  const underscored = cityKey.replace(/-/g, "_");
  const withoutState = cityKey.replace(/-tx$/, "");
  return [...new Set([
    `breadth_${fips}_${cityKey}`,
    `breadth_${fips}_${underscored}`,
    `breadth_${fips}_${withoutState.replace(/-/g, "_")}`,
  ])];
}

/**
 * Does the CORPUS carry a table for a cohort segment, and does THIS ENGINE serve it?
 *
 * The segment is a raw CAD situsCity (`san_marcos`); corpus keys are hyphenated city keys
 * (`san-marcos-tx`), so the match normalizes underscores to hyphens and tries the key with and
 * without the `-tx` state suffix. A miss is reported as "not-in-corpus", NOT as "no setback
 * law": the corpus is our acquisition record, and a city we have not acquired a table for is a
 * named gap, which is exactly what this column exists to say.
 */
function corpusStatusFor(segment) {
  const base = segment.replace(/_/g, "-").toLowerCase();
  const candidates = [base, `${base}-tx`];
  for (const key of candidates) {
    const row = SETBACK_ENGINE_REGISTRY.find((r) => r.key === key);
    if (row) {
      return row.served
        ? { status: "served", matchedKey: key, routing: row.routing }
        : { status: "not-served", matchedKey: key, reason: row.reason };
    }
  }
  return {
    status: "not-in-corpus",
    matchedKey: null,
    reason: `@empressaio/setback-corpus carries no key among ${candidates.join(", ")} (it carries ${CORPUS_SETBACK_JURISDICTION_KEYS.length} keys)`,
  };
}

try {
  const cohorts = await readCohorts();

  /**
   * (county, tenant segment) -> merged cohort, for rows the registry does not name. Keyed by
   * COUNTY as well as segment: `unknown` is a segment in several counties (406,935 atoms in
   * 48491 beside 52,869 in 48021 at 2026-09-17), and merging those into one row would report
   * two counties' cohorts as one city's.
   */
  const cohortBySegment = new Map();
  for (const [tenant, cohort] of cohorts) {
    const text = String(tenant ?? "");
    const fips = /^breadth_(\d{5})_/.exec(text)?.[1] ?? null;
    const segment = text.replace(/^breadth_\d{5}_/, "");
    const key = `${fips ?? "*"}:${segment}`;
    const prev = cohortBySegment.get(key) ?? {
      fips,
      segment,
      setbackRule: 0,
      buildableEnvelope: 0,
      total: 0,
    };
    cohortBySegment.set(key, {
      ...prev,
      setbackRule: prev.setbackRule + cohort.setbackRule,
      buildableEnvelope: prev.buildableEnvelope + cohort.buildableEnvelope,
      total: prev.total + cohort.total,
    });
  }

  const matchedSegments = new Set();
  const rows = [];
  for (const fips of counties) {
    for (const city of listWiredCityBindings(fips)) {
      const spellings = tenantSpellings(fips, city.cityKey);
      const cohort = spellings.reduce(
        (acc, t) => {
          const c = cohorts.get(t);
          if (!c) return acc;
          /**
           * Keyed by (county, segment): a segment alone is not unique across counties, and
           * matching on it hid an atom in the first run of this instrument (1,056,047 summed
           * against 1,056,048 total, 2026-09-17) because one county's spelling marked another
           * county's tenant as already-counted.
           */
          matchedSegments.add(`${fips}:${t.replace(/^breadth_\d{5}_/, "")}`);
          return {
            setbackRule: acc.setbackRule + c.setbackRule,
            buildableEnvelope: acc.buildableEnvelope + c.buildableEnvelope,
            total: acc.total + c.total,
          };
        },
        { setbackRule: 0, buildableEnvelope: 0, total: 0 },
      );
      rows.push({
        county: fips,
        countyName: COUNTY_NAME[fips] ?? fips,
        cityKey: city.cityKey,
        countyFipsOfBinding: city.counties.join(","),
        derivation: city.derivation,
        registryRow: true,
        engineRegistry:
          SETBACK_ENGINE_REGISTRY.find((r) => r.key === city.cityKey)?.served === true
            ? { status: "served", matchedKey: city.cityKey }
            : { status: "not-a-corpus-key", matchedKey: city.cityKey },
        corpus: corpusStatusFor(city.cityKey),
        tableLanded: city.tableLanded,
        tableNotLandedReason: city.tableNotLandedReason,
        cohortTenants: spellings,
        cohort,
        ledger: { state: "UNMEASURED", reason: null, count: null },
      });
    }
  }

  /**
   * The other direction, and the one the mission's sentence is about: cities the BAKE holds a
   * cohort for that no registry row names. Reported, never silently dropped — a city with
   * atoms and no registry row is exactly "a wired city missing its registry row".
   */
  const unregistered = [];
  for (const [key, entry] of cohortBySegment) {
    const tenant = key.slice(key.indexOf(":") + 1);
    if (matchedSegments.has(`${entry.fips}:${tenant}`)) continue;
    unregistered.push({
      county: entry.fips,
      segment: entry.segment,
      cohort: {
        setbackRule: entry.setbackRule,
        buildableEnvelope: entry.buildableEnvelope,
        total: entry.total,
      },
    });
  }
  unregistered.sort((a, b) => b.cohort.total - a.cohort.total);
  for (const u of unregistered) {
    rows.push({
      county: u.county,
      countyName: COUNTY_NAME[u.county] ?? u.county,
      cityKey: u.segment,
      countyFipsOfBinding: u.county,
      derivation: "atoms:jurisdictionTenant (no registry row names this city)",
      registryRow: false,
      engineRegistry: null,
      corpus: corpusStatusFor(u.segment),
      tableLanded: false,
      tableNotLandedReason: null,
      cohortTenants: [`breadth_${u.county}_${u.segment}`],
      cohort: u.cohort,
      ledger: { state: "UNMEASURED", reason: null, count: null },
    });
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
    storeHostFingerprint,
    countingRule: {
      wiredCity:
        "setback-writer/city-binding.ts#listWiredCityBindings (zoning staging + jurisdiction registry), unincorporated rows excluded",
      cohort:
        "active setback-rule + buildable-envelope atoms whose body->>'jurisdictionTenant' is breadth_<fips>_<city>, accepting BOTH recorded spellings of a city (hyphenated city key and the bake's underscored situsCity segment)",
      ledger: ledgerCityField
        ? `parcel_record_cell rows in the same county grouped by ${ledgerCityField}`
        : "UNMEASURED — no city attribution named",
    },
    counties,
    rows,
    totals: {
      cities: rows.length,
      citiesWithRegistryRow: rows.filter((r) => r.registryRow).length,
      citiesWithCohortButNoRegistryRow: rows.filter((r) => !r.registryRow).length,
      withTable: rows.filter((r) => r.tableLanded).length,
      withoutTable: rows.filter((r) => !r.tableLanded).length,
      withoutTableWithReason: rows.filter((r) => !r.tableLanded && r.tableNotLandedReason).length,
      citiesWithZeroCohort: rows.filter((r) => r.cohort.total === 0).length,
      cohortAtomsTotaled: rows.reduce((a, r) => a + r.cohort.total, 0),
      /**
       * The mission's sentence, as a number: cities the bake holds a cohort for whose table the
       * corpus CARRIES while this engine serves it to nobody. They are the named gap P-260's
       * registry makes sayable (each is a `served: false` row with a reason) and the wiring work
       * a later lane or the operator owns.
       */
      cohortCitiesWhoseCorpusTableIsNotServed: rows.filter((r) => r.corpus?.status === "not-served")
        .length,
      cohortCitiesWithNoCorpusTable: rows.filter((r) => r.corpus?.status === "not-in-corpus").length,
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
          registryRow: r.registryRow,
          table: r.registryRow
            ? r.tableLanded
              ? "landed"
              : `none — ${r.tableNotLandedReason}`
            : "(no registry row)",
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
