#!/usr/bin/env node
/**
 * write-special-district-fact-county.mjs — `special-district-fact` writer (mud rail).
 *
 * CP1 / SF-6 true-geometry path only:
 *   membershipMethodId = postgis-zone-major-st-intersects-true-geom
 *   Predicate: ST_Intersects(district_geom, parcel_geom), district-major.
 *
 * Modes:
 *   --plan-only --out=<path>     PostGIS plan → persist JSON artifact (no atoms)
 *   --drain --plan=<path> --apply  Load artifact, fail-closed method assert, write atoms
 *   --apply                        Plan + drain in-process (same true-geom path)
 *   (neither)                      Dry-run: true-geom plan counts only
 *
 *   SPECIAL_DISTRICT_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-special-district-fact-county -- \
 *       --county=48201 [--plan-only|--drain|--apply] [--batch=5000] [--limit=0]
 */

import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  TRUE_GEOM_MEMBERSHIP_METHOD,
  attachComptrollerTaxRates,
  buildAtomForPlannedSpecialDistrict,
  buildAtomsForSpecialDistrictPlan,
  buildPlanPayload,
  drainSpecialDistrictPlanPayload,
  loadComptrollerRegistryFromCsv,
  lookupComptrollerTaxRate,
  planCountySpecialDistrictsPostgis,
  readPlanPayload,
  verifyStoredSpecialDistrictFactAtom,
  writePlanPayload,
} from "../src/special-district-fact/index.ts";

const SOURCE_ADAPTER = "tceq-water-districts-v1";
const SOURCE_URL = "tx_special_district";
const DEFAULT_REGISTRY_CSV =
  process.env.COMPTROLLER_SPDPID_CSV?.trim() ||
  "P:/tmp/mud_recon/spdpid-entity.csv";
const DEFAULT_BATCH = 5000;

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    planOnly: false,
    drain: false,
    planPath: null,
    batch: DEFAULT_BATCH,
    limit: 0,
    out: null,
    listCounties: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--plan-only") out.planOnly = true;
    else if (a === "--drain") out.drain = true;
    else if (a === "--plan") out.planPath = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--plan=")) out.planPath = a.slice("--plan=".length).trim() || null;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || DEFAULT_BATCH);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  if (!Number.isFinite(out.batch) || out.batch < 1) out.batch = DEFAULT_BATCH;
  return out;
}

if (process.env.SPECIAL_DISTRICT_FACT_PATH !== "1") {
  console.error("FATAL: SPECIAL_DISTRICT_FACT_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

async function districtTableExists(sql) {
  const rows = await sql`SELECT to_regclass('public.tx_special_district') AS reg`;
  return rows[0]?.reg != null;
}

async function readParcelRoster(sql) {
  return sql`
    SELECT county_fips, count(*)::int AS rows
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

function loadTaxLookup(summary) {
  if (!existsSync(DEFAULT_REGISTRY_CSV)) {
    summary.storeTruth.registryCsvMissing = DEFAULT_REGISTRY_CSV;
    return undefined;
  }
  const registry = loadComptrollerRegistryFromCsv(DEFAULT_REGISTRY_CSV);
  return (countyFips, districtType, districtName) =>
    lookupComptrollerTaxRate(registry, {
      countyFips,
      districtType,
      districtName,
    });
}

function defaultProvenance(countyFips, districtsIndexed, observedAt) {
  return {
    sourceAdapter: SOURCE_ADAPTER,
    sourceCitation: `TCEQ tx_special_district (${districtsIndexed} rows for county ${countyFips})`,
    sourceUrl: SOURCE_URL,
    observedAt,
    jurisdictionTenant: `tx_${countyFips}`,
    verificationStatus: "machine",
    sourceVintage: "2026-08-10",
  };
}

async function writeAtomsFromPlan(plan, provenance, summary) {
  const substrateUrl = resolveSubstrateDatabaseUrl();
  if (!substrateUrl) {
    throw new Error(
      "FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).",
    );
  }
  // Match sibling writers: options object, not a bare URL string.
  // Passing a string made options.databaseUrl undefined and crashed on .includes.
  const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 });
  const atoms = buildAtomsForSpecialDistrictPlan(plan, provenance);
  summary.atomsBuilt = atoms.length;

  for (let i = 0; i < atoms.length; i += args.batch) {
    const slice = atoms.slice(i, i + args.batch);
    await handle.storage.writePropertyAtomsBatch(slice);
    summary.atomsWritten += slice.length;

    // Verify by PK atom_did IN kept; use a.entityId (never reconstruct DID shape
    // from parcel+district by hand beyond the storage-canonical form).
    const dids = slice.map((a) => `did:hauska:special-district-fact:${a.entityId}`);
    const stored = await handle.sql`
        SELECT body FROM atoms
        WHERE atom_did IN ${handle.sql(dids)}
      `;
    const storedByDid = new Map(stored.map((s) => [s.body?.atomDid, s.body]));
    for (const atom of slice) {
      const back = storedByDid.get(atom.atomDid);
      if (!back) {
        summary.verifyFailures.push({
          atomDid: atom.atomDid,
          entityId: atom.entityId,
          problem: "atom not readable back via atom_did PK after write",
        });
        continue;
      }
      const verdict = verifyStoredSpecialDistrictFactAtom(back, {
        parcelNodeId: atom.parcelNodeId,
        outcome: atom.absence ? "absent" : "present",
        districtId: atom.districtId,
      });
      if (verdict.ok) summary.verified += 1;
      else summary.verifyFailures.push(verdict);
    }

    if (summary.verifyFailures.length > 0) {
      throw new Error(
        `write-then-verify FAILED on ${summary.verifyFailures.length} atom(s); ` +
          `first: ${JSON.stringify(summary.verifyFailures[0])}`,
      );
    }

    console.log(
      JSON.stringify({
        event: "special-district-fact-county.progress",
        county: summary.county,
        membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
        written: summary.atomsWritten,
        verified: summary.verified,
        ofTotal: atoms.length,
      }),
    );
  }
}

if (args.listCounties) {
  if (!poolUrl) {
    console.error("FATAL: CORTEX_DATABASE_URL required.");
    process.exit(1);
  }
  const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });
  try {
    const roster = await readParcelRoster(sql);
    const hasTable = await districtTableExists(sql);
    let districtRows = null;
    if (hasTable) {
      const r = await sql`SELECT count(*)::int AS n FROM tx_special_district`;
      districtRows = r[0]?.n ?? 0;
    }
    console.log(
      JSON.stringify({
        event: "special-district-fact.roster",
        districtTablePresent: hasTable,
        districtRows,
        counties: roster,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (args.planOnly && args.drain) {
  console.error("FATAL: --plan-only and --drain are mutually exclusive.");
  process.exit(1);
}
if (args.planOnly && args.apply) {
  console.error("FATAL: --plan-only cannot combine with --apply.");
  process.exit(1);
}
if (args.drain && !args.planPath) {
  console.error("FATAL: --drain requires --plan=<path>.");
  process.exit(1);
}
if (args.planOnly && !args.out) {
  console.error("FATAL: --plan-only requires --out=<path>.");
  process.exit(1);
}

const summary = {
  county: args.county,
  apply: args.apply,
  planOnly: args.planOnly,
  drain: args.drain,
  membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
  storeTruth: {},
  plan: {},
  atomsBuilt: 0,
  atomsWritten: 0,
  rateEnrichedCount: 0,
  verified: 0,
  verifyFailures: [],
};

const t0 = performance.now();

// ---------------------------------------------------------------------------
// Drain-from-artifact path (no PostGIS pool required for the plan step)
// ---------------------------------------------------------------------------
if (args.drain) {
  try {
    const payload = readPlanPayload(args.planPath);
    const drained = drainSpecialDistrictPlanPayload(payload);
    summary.county = drained.countyFips;
    summary.membershipMethodId = TRUE_GEOM_MEMBERSHIP_METHOD;
    summary.storeTruth = payload.storeTruth ?? {};
    summary.plan = {
      parcelsRead: drained.plan.parcelsRead,
      districtsIndexed: drained.plan.districtsIndexed,
      emptyDistrictIndex: drained.plan.emptyDistrictIndex,
      absenceReasoningRuleId: drained.absenceReasoningRuleId,
      wouldWriteTotal:
        drained.plan.counts.presentMemberships + drained.plan.counts.absentOutside,
      wouldWritePresentMemberships: drained.plan.counts.presentMemberships,
      wouldWriteAbsentOutside: drained.plan.counts.absentOutside,
      parcelsInDistrict: drained.plan.counts.parcelsInDistrict,
      parcelsOutside: drained.plan.counts.parcelsOutside,
    };

    let plan = drained.plan;
    const taxLookup = loadTaxLookup(summary);
    if (args.apply && taxLookup) {
      plan = attachComptrollerTaxRates(plan, taxLookup);
    }
    summary.rateEnrichedCount = plan.counts.rateEnrichedCount;

    const provenance =
      drained.provenance ??
      defaultProvenance(
        drained.countyFips,
        plan.districtsIndexed,
        payload.plannedAt || new Date().toISOString(),
      );

    if (!args.apply) {
      const sampleEntries = plan.planned.slice(0, 5);
      const sampleAtoms = sampleEntries.map((entry) =>
        buildAtomForPlannedSpecialDistrict(entry, plan.countyFips, provenance),
      );
      console.log(
        JSON.stringify({
          event: "special-district-fact-county.drain-dry-run",
          county: drained.countyFips,
          membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
          elapsedMs: Math.round(performance.now() - t0),
          ...summary,
          sample: sampleAtoms.map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            entityId: a.entityId,
            districtType: a.districtType ?? null,
            districtId: a.districtId ?? null,
            absenceKind: a.absence?.kind ?? null,
          })),
          note: "drain dry-run — pass --apply to write atoms",
        }),
      );
      process.exit(0);
    }

    await writeAtomsFromPlan(plan, provenance, summary);
    const donePayload = {
      event: "special-district-fact-county.done",
      membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
      ...summary,
    };
    console.log(JSON.stringify(donePayload));
    if (args.out) writeFileSync(args.out, JSON.stringify(donePayload, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "special-district-fact-county.error",
        message: String(err),
      }),
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Plan path (PostGIS true-geom) — plan-only, apply-in-process, or dry-run
// ---------------------------------------------------------------------------
if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}
if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=##### required (5-digit FIPS).");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

try {
  const hasTable = await districtTableExists(sql);
  summary.storeTruth.districtTablePresent = hasTable;
  if (!hasTable) {
    throw new Error("tx_special_district missing — run migration + ingest first");
  }

  const result = await planCountySpecialDistrictsPostgis(sql, {
    countyFips: args.county,
    limit: args.limit > 0 ? args.limit : undefined,
  });

  let plan = result.plan;
  summary.storeTruth.districtRowsInCounty = plan.districtsIndexed;
  summary.storeTruth.parcelsLoaded = plan.parcelsRead;
  summary.storeTruth.skippedNullGeometry = result.meta.skippedNullGeometry;

  const taxLookup = loadTaxLookup(summary);
  if ((args.apply || args.planOnly) && taxLookup) {
    // Enrich before persist so drain resumes with rates when present.
    if (args.planOnly || args.apply) {
      plan = attachComptrollerTaxRates(plan, taxLookup);
    }
  } else if (!args.apply && !args.planOnly && taxLookup) {
    plan = attachComptrollerTaxRates(plan, taxLookup);
  }
  summary.rateEnrichedCount = plan.counts.rateEnrichedCount;

  const wouldWriteTotal =
    plan.counts.presentMemberships + plan.counts.absentOutside;

  summary.plan = {
    parcelsRead: plan.parcelsRead,
    districtsIndexed: plan.districtsIndexed,
    emptyDistrictIndex: plan.emptyDistrictIndex,
    absenceReasoningRuleId: result.meta.absenceReasoningRuleId,
    membershipMethodId: result.meta.membershipMethodId,
    sqlMs: result.meta.sqlMs,
    wouldWriteTotal,
    wouldWritePresentMemberships: plan.counts.presentMemberships,
    wouldWriteAbsentOutside: plan.counts.absentOutside,
    parcelsInDistrict: plan.counts.parcelsInDistrict,
    parcelsOutside: plan.counts.parcelsOutside,
    inDistrictRatio:
      plan.parcelsRead > 0
        ? Math.round((plan.counts.parcelsInDistrict / plan.parcelsRead) * 10000) /
          10000
        : 0,
    skippedUnusableKey: plan.counts.skippedUnusableKey,
    skippedNullGeometry: result.meta.skippedNullGeometry,
  };

  const provenance = defaultProvenance(
    args.county,
    plan.districtsIndexed,
    result.meta.plannedAt,
  );

  const payload = buildPlanPayload(plan, result.meta, {
    storeTruth: { ...summary.storeTruth },
    provenance,
  });

  if (args.planOnly) {
    writePlanPayload(args.out, payload);
    console.log(
      JSON.stringify({
        event: "special-district-fact-county.plan-only",
        county: args.county,
        membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
        out: args.out,
        elapsedMs: Math.round(performance.now() - t0),
        ...summary,
      }),
    );
    try {
      await sql.end({ timeout: 2 });
    } catch {
      /* ignore hung pooler end */
    }
    process.exit(0);
  }

  if (!args.apply) {
    const sampleEntries = plan.planned.slice(0, 5);
    const sampleAtoms = sampleEntries.map((entry) =>
      buildAtomForPlannedSpecialDistrict(entry, plan.countyFips, provenance),
    );
    const dry = {
      event: "special-district-fact-county.dry-run-prediction",
      county: args.county,
      membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
      elapsedMs: Math.round(performance.now() - t0),
      ...summary,
      sample: sampleAtoms.map((a) => ({
        atomDid: a.atomDid,
        parcelNodeId: a.parcelNodeId,
        entityId: a.entityId,
        districtType: a.districtType ?? null,
        districtId: a.districtId ?? null,
        absenceKind: a.absence?.kind ?? null,
        taxRate: a.taxRate ?? null,
      })),
      note:
        "TRUE-GEOM ST_Intersects (zone-major) — no bbox-midpoint; --apply not run",
    };
    console.log(JSON.stringify(dry));
    if (args.out) writeFileSync(args.out, JSON.stringify(dry, null, 2));
  } else {
    // In-process plan+drain convenience; membershipMethodId always recorded.
    // Persist the plan artifact when --out is set so a later --drain can resume.
    if (args.out) writePlanPayload(args.out, payload);
    await writeAtomsFromPlan(plan, provenance, summary);
    const donePayload = {
      event: "special-district-fact-county.done",
      membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
      ...summary,
    };
    console.log(JSON.stringify(donePayload));
    try {
      await sql.end({ timeout: 2 });
    } catch {
      /* ignore hung pooler end */
    }
    process.exit(0);
  }
} catch (err) {
  console.error(
    JSON.stringify({
      event: "special-district-fact-county.error",
      message: String(err),
    }),
  );
  process.exit(1);
} finally {
  await sql.end({ timeout: 10 });
}
