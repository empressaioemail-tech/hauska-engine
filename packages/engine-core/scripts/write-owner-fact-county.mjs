#!/usr/bin/env node
/**
 * write-owner-fact-county.mjs — `owner-fact` writer (OWN rail).
 *
 * Two-table join in app code on ONE neondb pool (txgio_parcel ⨝ cad_property)
 * via normalizeForJoin, mirroring the land-use writer. Cotality is
 * extinguished — owner identity comes from the CAD roll only.
 *
 *   OWNER_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-owner-fact-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0] [--tax-year=2026]
 *
 * THE PAID RAIL. Every atom this CLI writes carries `accessPolicy:
 * public-paid` — enforced by the contract schema, re-checked against the
 * STORED BYTES in verifyStoredOwnerFactAtom. A row that somehow lands on the
 * free tier is a verify FAILURE and stops the run, because owner identity
 * resting on the free tier is worse than no owner rail at all.
 *
 * EXEMPTION CODES NEVER REACH AN ATOM. The plan carries raw CAD codes; the
 * atom builder reduces them to four booleans. Nothing downstream of
 * `buildAtomForPlannedOwnerFact` can see a raw code.
 *
 * DRY RUN IS THE DEFAULT and it PREDICTS the apply — same rows, same plan,
 * same constructed atoms. Compare its numbers to the apply's; they must match.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  buildAtomsForOwnerFactPlan,
  planCountyOwnerFacts,
  verifyStoredOwnerFactAtom,
} from "../src/owner-fact/index.ts";
import { resolveDeclaredCadVintage } from "../src/cad-vintage/resolve-declared-cad-vintage.ts";
import { isUsablePropId, normalizeForJoin } from "@hauska-engine/atoms";

const SOURCE_ADAPTER = "cad-property-owner-v1";
const SOURCE_URL = "cad_property.owner_name";

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

if (process.env.OWNER_FACT_PATH !== "1") {
  console.error("FATAL: OWNER_FACT_PATH=1 required (guards against an accidental invocation).");
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
  // CAD_PROPERTY_MULTI_YEAR_INVENTORY — intentional; not a single-vintage derivation
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(owner_name)::int AS with_owner,
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
          event: "owner-fact.roster",
          source:
            "txgio_parcel ⨝ cad_property (read at execution time — no hardcoded allowlist)",
          counties: parcels.map((p) => {
            const c = cadBy.get(p.county_fips);
            return {
              countyFips: p.county_fips,
              parcelRows: p.rows,
              parcelFeatures: p.features,
              cadRows: c?.rows ?? 0,
              cadRowsWithOwner: c?.with_owner ?? 0,
              cadTaxYears: c
                ? c.min_year === c.max_year
                  ? String(c.min_year)
                  : `${c.min_year}..${c.max_year}`
                : null,
            };
          }),
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
  event: "owner-fact-county.done",
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
        event: "owner-fact-county.parcels-not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel — cannot plan owner facts",
      }),
    );
    process.exitCode = 1;
  } else {
    const declared = resolveDeclaredCadVintage(args.county);
    // CAD_PROPERTY_MULTI_YEAR_INVENTORY — intentional; not a single-vintage derivation
    const yearRows = await sql`
      SELECT tax_year, count(*)::int AS n, count(owner_name)::int AS with_owner
      FROM cad_property
      WHERE county_fips = ${args.county}
      GROUP BY tax_year
      ORDER BY tax_year DESC
    `;
    if (args.taxYear != null && Number(args.taxYear) !== declared.taxYear) {
      console.error(
        JSON.stringify({
          event: "owner-fact-county.tax-year-mismatch",
          county: args.county,
          declaredTaxYear: declared.taxYear,
          requestedTaxYear: args.taxYear,
          message:
            "FAIL CLOSED: --taxYear must match resolveDeclaredCadVintage (no silent cross-vintage)",
        }),
      );
      process.exitCode = 1;
      await sql.end({ timeout: 5 });
      process.exit(1);
    }
    const taxYear = declared.taxYear;

    summary.storeTruth = {
      parcelRows: parcelRow.rows,
      parcelFeatures: parcelRow.features,
      cadTaxYears: yearRows.map((r) => ({
        taxYear: r.tax_year,
        rows: r.n,
        withOwner: r.with_owner,
      })),
      chosenTaxYear: taxYear,
      note: "two-table join in app code on one pool (no SQL JOIN); store-truth at execution time",
    };

    // Scan parcels until the planned atom count reaches --limit (or EOF).
    // Feature order is not CAD join order, so limiting raw features
    // under-fills the plan.
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
      if (args.limit > 0 && parcels.length >= args.limit * 20) break;
    }

    const cadPageSize = Math.max(50, Math.min(args.batch, 2000));
    const cadRows = [];
    let lastProp = "";
    while (true) {
      const page = await sql`
        SELECT prop_id, tax_year, owner_name, owner_mailing_address,
               exemption_codes, source_vintage
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
          ownerName: p.owner_name,
          ownerMailingAddress: p.owner_mailing_address,
          exemptionCodes: Array.isArray(p.exemption_codes) ? p.exemption_codes : null,
          sourceVintage: p.source_vintage,
        });
      }
      lastProp = page[page.length - 1].prop_id;
      if (page.length < cadPageSize) break;
    }

    const otherVintageKeys = new Set();
    {
      let lastOther = "";
      while (true) {
        const page = await sql`
          SELECT DISTINCT prop_id
          FROM cad_property
          WHERE county_fips = ${args.county}
            AND tax_year <> ${taxYear}
            AND prop_id > ${lastOther}
          ORDER BY prop_id
          LIMIT ${cadPageSize}
        `;
        if (page.length === 0) break;
        for (const p of page) {
          if (isUsablePropId(p.prop_id)) {
            otherVintageKeys.add(normalizeForJoin(p.prop_id));
          }
        }
        lastOther = page[page.length - 1].prop_id;
        if (page.length < cadPageSize) break;
      }
    }

    let plan = planCountyOwnerFacts(parcels, cadRows, {
      countyFips: args.county,
      taxYear,
      otherVintageKeys,
    });
    if (args.limit > 0 && plan.planned.length > args.limit) {
      const sliced = plan.planned.slice(0, args.limit);
      const absentByKind = {
        "no-owner-name": 0,
        "owner-withheld": 0,
        "no-cad-row": 0,
        "vintage-gap": 0,
        "join-hold": 0,
      };
      let present = 0;
      let withMailingAddress = 0;
      for (const p of sliced) {
        if (p.outcome === "present") {
          present += 1;
          if (p.ownerMailingAddress) withMailingAddress += 1;
        } else absentByKind[p.absenceKind] += 1;
      }
      plan = {
        ...plan,
        planned: sliced,
        counts: {
          ...plan.counts,
          present,
          absent: sliced.length - present,
          withMailingAddress,
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
      wouldWriteWithMailingAddress: plan.counts.withMailingAddress,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
      limitApplied: args.limit > 0 ? args.limit : null,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: `cad_property.owner_name county ${args.county} taxYear=${taxYear}`,
      sourceUrl: SOURCE_URL,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForOwnerFactPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    // Fail-closed paid-tier gate BEFORE any write. The schema already pins
    // public-paid, so this can only fire if the contract regressed — which is
    // exactly the case worth stopping for.
    const leaked = atoms.filter((a) => a.accessPolicy !== "public-paid");
    if (leaked.length > 0) {
      throw new Error(
        `REFUSING TO WRITE: ${leaked.length} owner atom(s) are not public-paid ` +
          `(first: ${leaked[0].atomDid}). Owner identity must never rest on the free tier.`,
      );
    }

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "owner-fact-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          atomsBuilt: atoms.length,
          // Sample deliberately omits ownerName / mailing address: a dry-run
          // log is not a place to print PII.
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            taxYear: a.taxYear,
            entityId: a.entityId,
            accessPolicy: a.accessPolicy,
            hasOwnerName: Boolean(a.ownerName),
            hasMailingAddress: Boolean(a.ownerMailingAddress),
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

        // Look rows up by the atoms PRIMARY KEY (`atom_did`), never by the
        // `body->>'atomDid'` jsonb expression: no index serves the expression, so
        // every batch seq-scanned the whole atoms table. StoragePort upserts under
        // the canonical `did:hauska:<entityType>:<entityId>` form (body.atomDid
        // stays the contract `ownfact_<hex>` token), so the canonical did is what
        // the PK holds. `a.entityId` is the exact value written to `entity_id`.
        const dids = slice.map((a) => `did:hauska:owner-fact:${a.entityId}`);
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
              problem: "atom not readable back via body->>'atomDid' after write",
            });
            continue;
          }
          const verdict = verifyStoredOwnerFactAtom(back, {
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
            event: "owner-fact-county.progress",
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
