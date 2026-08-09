#!/usr/bin/env node
/**
 * write-land-use-fact-county.mjs — `land-use-fact` writer.
 *
 * Two-table join in app code on ONE neondb pool (txgio_parcel ⨝ cad_property)
 * via normalizeForJoin. LANDUSE_JOIN_HOLD counties emit join-hold absences.
 * Cotality is extinguished — property_use_code only.
 *
 *   LAND_USE_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-land-use-fact-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0] [--tax-year=2026]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  buildAtomsForLandUseFactPlan,
  planCountyLandUseFacts,
  verifyStoredLandUseFactAtom,
} from "../src/land-use-fact/index.ts";

const SOURCE_ADAPTER = "cad-property-land-use-v1";
const SOURCE_URL = "cad_property.property_use_code";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    taxYear: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--tax-year") out.taxYear = Number(argv[++i] || 0) || null;
    else if (a.startsWith("--tax-year="))
      out.taxYear = Number(a.slice("--tax-year=".length)) || null;
  }
  return out;
}

if (process.env.LAND_USE_FACT_PATH !== "1") {
  console.error("FATAL: LAND_USE_FACT_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — one neondb pool holding BOTH txgio_parcel and cad_property.",
  );
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

async function readParcelRoster() {
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

async function readCadRoster() {
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           min(tax_year)::int AS min_year,
           max(tax_year)::int AS max_year
    FROM cad_property
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const parcels = await readParcelRoster();
    const cad = await readCadRoster();
    const cadBy = new Map(cad.map((r) => [r.county_fips, r]));
    console.log(
      JSON.stringify(
        {
          event: "land-use-fact.roster",
          source:
            "txgio_parcel ⨝ cad_property (read at execution time — no hardcoded allowlist)",
          counties: parcels.map((p) => ({
            countyFips: p.county_fips,
            parcelRows: p.rows,
            parcelFeatures: p.features,
            cadRows: cadBy.get(p.county_fips)?.rows ?? 0,
            cadTaxYears: cadBy.has(p.county_fips)
              ? cadBy.get(p.county_fips).min_year ===
                cadBy.get(p.county_fips).max_year
                ? String(cadBy.get(p.county_fips).min_year)
                : `${cadBy.get(p.county_fips).min_year}..${cadBy.get(p.county_fips).max_year}`
              : null,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "land-use-fact-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  plan: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  verifyFailures: [],
  errors: 0,
};

try {
  const parcelRoster = await readParcelRoster();
  const parcelRow = parcelRoster.find((r) => r.county_fips === args.county);
  if (!parcelRow) {
    console.error(
      JSON.stringify({
        event: "land-use-fact-county.parcels-not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel — cannot plan land-use facts",
      }),
    );
    process.exitCode = 1;
  } else {
    // Resolve tax year from store when not provided.
    const yearRows = await sql`
      SELECT tax_year, count(*)::int AS n
      FROM cad_property
      WHERE county_fips = ${args.county}
      GROUP BY tax_year
      ORDER BY tax_year DESC
    `;
    const taxYear =
      args.taxYear ?? (yearRows.length > 0 ? yearRows[0].tax_year : new Date().getUTCFullYear());

    summary.storeTruth = {
      parcelRows: parcelRow.rows,
      parcelFeatures: parcelRow.features,
      cadTaxYears: yearRows.map((r) => ({ taxYear: r.tax_year, rows: r.n })),
      chosenTaxYear: taxYear,
      note: "two-table join in app code on one pool (no SQL JOIN); store-truth at execution time",
    };

    // Scan parcels until the planned atom count reaches --limit (or EOF).
    // Feature order is not CAD join order — early StratMap prop_ids often miss
    // the roll — so limiting raw features under-fills the plan.
    const parcels = [];
    let lastFeature = -1;
    const scanPage = Math.max(50, Math.min(args.batch, 2000));
    const softCeiling =
      args.limit > 0 ? Math.max(args.limit * 40, args.limit) : Number.POSITIVE_INFINITY;
    while (parcels.length < softCeiling) {
      const page = await sql`
        SELECT DISTINCT ON (feature_index) feature_index, prop_id
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND feature_index > ${lastFeature}
          AND prop_id IS NOT NULL
          AND btrim(prop_id) <> ''
          AND prop_id !~ '^0+$'
        ORDER BY feature_index
        LIMIT ${scanPage}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        parcels.push({ parcelKey: p.prop_id });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < scanPage) break;
      if (args.limit > 0) {
        // Enough raw keys for a full limited plan in typical counties.
        if (parcels.length >= args.limit * 20) break;
      }
    }

    const cadPageSize = Math.max(50, Math.min(args.batch, 2000));
    const cadRows = [];
    let lastProp = "";
    while (true) {
      const page = await sql`
        SELECT prop_id, tax_year, property_use_code, source_vintage
        FROM cad_property
        WHERE county_fips = ${args.county}
          AND tax_year = ${taxYear}
          AND prop_id > ${lastProp}
        ORDER BY prop_id
        LIMIT ${cadPageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        cadRows.push({
          propId: p.prop_id,
          taxYear: p.tax_year,
          propertyUseCode: p.property_use_code,
          sourceVintage: p.source_vintage,
        });
      }
      lastProp = page[page.length - 1].prop_id;
      if (page.length < cadPageSize) break;
    }

    let plan = planCountyLandUseFacts(parcels, cadRows, {
      countyFips: args.county,
      taxYear,
    });
    if (args.limit > 0 && plan.planned.length > args.limit) {
      const sliced = plan.planned.slice(0, args.limit);
      const absentByKind = {
        "no-land-use-code": 0,
        "no-cad-row": 0,
        "join-hold": 0,
      };
      let present = 0;
      for (const p of sliced) {
        if (p.outcome === "present") present += 1;
        else absentByKind[p.absenceKind] += 1;
      }
      plan = {
        ...plan,
        planned: sliced,
        counts: {
          ...plan.counts,
          present,
          absent: sliced.length - present,
          absentByKind,
        },
      };
    }
    summary.plan = {
      parcelsRead: plan.parcelsRead,
      cadRowsRead: plan.cadRowsRead,
      hold: plan.hold,
      taxYear: plan.taxYear,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWriteAbsent: plan.counts.absent,
      wouldWriteAbsentByKind: plan.counts.absentByKind,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
      limitApplied: args.limit > 0 ? args.limit : null,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: `cad_property.property_use_code county ${args.county} taxYear=${taxYear}`,
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForLandUseFactPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "land-use-fact-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            taxYear: a.taxYear,
            entityId: a.entityId,
            landUseCode: a.landUseCode ?? null,
            absenceKind: a.absence?.kind ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
        }),
      );
    } else {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice);
        summary.atomsWritten += slice.length;

        const dids = slice.map((a) => a.atomDid);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE entity_type = 'land-use-fact'
            AND body->>'atomDid' IN ${handle.sql(dids)}
        `;
        const storedByDid = new Map(stored.map((s) => [s.body?.atomDid, s.body]));
        for (const atom of slice) {
          const back = storedByDid.get(atom.atomDid);
          if (!back) {
            summary.verifyFailures.push({
              atomDid: atom.atomDid,
              problem: "atom not readable back via body->>'atomDid' after write",
            });
            continue;
          }
          const verdict = verifyStoredLandUseFactAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            taxYear: atom.taxYear,
            outcome: atom.absence || atom.sourceTier === "absent" ? "absent" : "present",
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
            event: "land-use-fact-county.progress",
            county: args.county,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
