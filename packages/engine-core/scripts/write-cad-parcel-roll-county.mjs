#!/usr/bin/env node
/**
 * write-cad-parcel-roll-county.mjs — `cad-parcel-roll` writer.
 *
 * Store-truth from `cad_property` at execution time. No hardcoded county
 * allowlist. CROSSWALK_HOLD counties emit join-hold absences rather than
 * promoting untrusted joins.
 *
 *   CAD_PARCEL_ROLL_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-cad-parcel-roll-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0]
 *
 * Dry-run is the default and constructs the same atoms apply would write.
 * Verify looks rows up by the `atom_did` PRIMARY KEY column, computing the
 * canonical did as `did:hauska:cad-parcel-roll:<entityId>`. StoragePort rewrites
 * the atom_did column, so it does NOT equal `body->>'atomDid'` for this type
 * (column `did:hauska:cad-parcel-roll:48055:10005:2026` vs body `cadroll_...`);
 * matching on the jsonb expression is unindexed and seq-scans the atoms table.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
  releaseScopedLease,
} from "@hauska-engine/storage";

import {
  buildAtomsForCadParcelRollPlan,
  planCountyCadParcelRoll,
  verifyStoredCadParcelRollAtom,
} from "../src/cad-parcel-roll/index.ts";
import { resolveDeclaredCadVintage } from "../src/cad-vintage/resolve-declared-cad-vintage.ts";

const SOURCE_ADAPTER = "cad-property-ingest-v1";
const SOURCE_URL = "cad_property";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    taxYear: null,
    runId: null,
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
    else if (a === "--run-id") out.runId = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length).trim() || null;
  }
  return out;
}

if (process.env.CAD_PARCEL_ROLL_PATH !== "1") {
  console.error("FATAL: CAD_PARCEL_ROLL_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const cortexUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!cortexUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL (or TXGIO_DATABASE_URL / DATABASE_URL) required — the store holding cad_property.",
  );
  process.exit(1);
}

const cadSql = postgres(cortexUrl, { max: 4, ssl: "require", prepare: false });

async function readCountyRosterFromStore() {
  // CAD_PROPERTY_MULTI_YEAR_INVENTORY — intentional; not a single-vintage derivation
  return cadSql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT prop_id)::int AS props,
           min(tax_year)::int AS min_year,
           max(tax_year)::int AS max_year
    FROM cad_property
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const roster = await readCountyRosterFromStore();
    console.log(
      JSON.stringify(
        {
          event: "cad-parcel-roll.roster",
          source: "cad_property (read at execution time — no hardcoded allowlist)",
          countyCount: roster.length,
          totalRows: roster.reduce((a, r) => a + r.rows, 0),
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            rows: r.rows,
            props: r.props,
            taxYears:
              r.min_year === r.max_year
                ? String(r.min_year)
                : `${r.min_year}..${r.max_year}`,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await cadSql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await cadSql.end({ timeout: 5 });
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await cadSql.end({ timeout: 5 });
  process.exit(1);
}

if (args.apply && args.county !== "48029") {
  console.error(
    JSON.stringify({
      event: "cad-parcel-roll-county.refused",
      code: "OLD_SHAPE_FILL_FROZEN",
      county: args.county,
    }),
  );
  await cadSql.end({ timeout: 5 });
  process.exit(2);
}

if (args.apply && !args.runId) {
  console.error(
    JSON.stringify({
      event: "cad-parcel-roll-county.refused",
      code: "LEASE_REQUIRED",
      message: "--apply requires --run-id (a Factory runs row). HeldLease is minted from that id. v1 ATOMS_WRITER_LEASE_HOLDER cannot satisfy a write.",
    }),
  );
  await cadSql.end({ timeout: 5 });
  process.exit(2);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "cad-parcel-roll-county.done",
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
  const roster = await readCountyRosterFromStore();
  const row = roster.find((r) => r.county_fips === args.county);
  if (!row) {
    console.error(
      JSON.stringify({
        event: "cad-parcel-roll-county.not-loaded",
        county: args.county,
        message:
          "county has zero rows in cad_property — it is NOT-YET for this rail. " +
          "Do not invent verified-absence unless a source probe documented unpublished CAD.",
        loadedCounties: roster.map((r) => r.county_fips),
      }),
    );
    process.exitCode = 1;
  } else {
    const declared = resolveDeclaredCadVintage(args.county);
    if (args.taxYear != null && Number(args.taxYear) !== declared.taxYear) {
      console.error(
        JSON.stringify({
          event: "cad-parcel-roll-county.tax-year-mismatch",
          county: args.county,
          declaredTaxYear: declared.taxYear,
          requestedTaxYear: args.taxYear,
          message:
            "FAIL CLOSED: --taxYear must match resolveDeclaredCadVintage (no silent cross-vintage)",
        }),
      );
      process.exitCode = 1;
      await cadSql.end({ timeout: 5 });
      process.exit(1);
    }
    const taxYear = declared.taxYear;

    summary.storeTruth = {
      rows: row.rows,
      props: row.props,
      taxYears:
        row.min_year === row.max_year
          ? String(row.min_year)
          : `${row.min_year}..${row.max_year}`,
      chosenTaxYear: taxYear,
      note: "read from cad_property at execution time; always filtered to declared taxYear",
    };

    const rows = [];
    let lastProp = "";
    let lastYear = -1;
    while (true) {
      if (args.limit > 0 && rows.length >= args.limit) break;
      const remaining =
        args.limit > 0 ? args.limit - rows.length : Math.min(args.batch, 2000);
      const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
      const page = await cadSql`
        SELECT county_fips, prop_id, tax_year, owner_name, owner_mailing_address,
               situs_address, situs_city, situs_zip, legal_description,
               exemption_codes, land_value, improvement_value, market_value,
               assessed_value, year_built, living_area_sqft, land_acres,
               property_use_code, source_file, source_vintage
        FROM cad_property
        WHERE county_fips = ${args.county}
          AND tax_year = ${taxYear}
          AND (prop_id, tax_year) > (${lastProp}, ${lastYear})
        ORDER BY prop_id, tax_year
        LIMIT ${pageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        if (args.limit > 0 && rows.length >= args.limit) break;
        rows.push({
          countyFips: p.county_fips,
          propId: p.prop_id,
          taxYear: p.tax_year,
          ownerName: p.owner_name,
          ownerMailingAddress: p.owner_mailing_address,
          situsAddress: p.situs_address,
          situsCity: p.situs_city,
          situsZip: p.situs_zip,
          legalDescription: p.legal_description,
          exemptionCodes: p.exemption_codes,
          landValue: p.land_value == null ? null : Number(p.land_value),
          improvementValue:
            p.improvement_value == null ? null : Number(p.improvement_value),
          marketValue: p.market_value == null ? null : Number(p.market_value),
          assessedValue:
            p.assessed_value == null ? null : Number(p.assessed_value),
          yearBuilt: p.year_built,
          livingAreaSqft: p.living_area_sqft,
          landAcres: p.land_acres,
          propertyUseCode: p.property_use_code,
          sourceFile: p.source_file,
          sourceVintage: p.source_vintage,
        });
      }
      lastProp = page[page.length - 1].prop_id;
      lastYear = page[page.length - 1].tax_year;
      if (page.length < pageSize) break;
    }

    const plan = planCountyCadParcelRoll(rows, { countyFips: args.county });
    summary.plan = {
      rowsRead: plan.rowsRead,
      hold: plan.hold,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWriteAbsent: plan.counts.absent,
      wouldWriteAbsentByKind: plan.counts.absentByKind,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: `cad_property county ${args.county} taxYear=${taxYear}`,
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForCadParcelRollPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "cad-parcel-roll-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            taxYear: a.taxYear,
            entityId: a.entityId,
            absenceKind: a.absence?.kind ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
        }),
      );
    } else {
      const lease = await takeScopedLease(handle.sql, {
        scope: {
          scope_type: "write",
          entity_type: "cad-parcel-roll",
          county_fips: args.county,
        },
        holder_label:
          process.env.CLOUD_RUN_EXECUTION?.trim() ||
          process.env.K_REVISION?.trim() ||
          "cad-parcel-roll-writer",
        run_id: args.runId,
      });
      summary.lease = {
        holder_token: lease.holder_token,
        scope: lease.scope,
        stolen_from: lease.stolen_from,
      };
      try {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice, lease);
        summary.atomsWritten += slice.length;

        const dids = slice.map((a) => `did:hauska:cad-parcel-roll:${a.entityId}`);
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
              problem: "atom not readable back via atom_did column after write",
            });
            continue;
          }
          const verdict = verifyStoredCadParcelRollAtom(back, {
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
            event: "cad-parcel-roll-county.progress",
            county: args.county,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }
      } finally {
        await releaseScopedLease(handle.sql, lease);
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
  }
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await cadSql.end({ timeout: 5 });
  if (handle) await handle.close();
}
