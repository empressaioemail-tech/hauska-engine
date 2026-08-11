#!/usr/bin/env node
/**
 * write-rail-corridor-fact-county.mjs — `rail-corridor-fact` writer.
 *
 * Railroad TRACKS via NTAD NARN (NOT Texas Railroad Commission oil/gas).
 * Evaluates parcel boundary rings against corridor lines within bufferMeters.
 *
 *   RAIL_CORRIDOR_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-rail-corridor-fact-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0] [--probe-only]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { RAIL_CORRIDOR_DEFAULT_BUFFER_METERS } from "@empressaio/atom-contract/property";

import {
  buildAtomsForRailCorridorPlan,
  fetchNtadGradeCrossingsForCounty,
  fetchNtadRailCorridorsForCounty,
  NTAD_GRADE_CROSSINGS_URL,
  NTAD_NARN_LINES_URL,
  NTAD_NARN_SOURCE_VINTAGE,
  planCountyRailCorridor,
  probeNtadRailSource,
  verifyStoredRailCorridorFactAtom,
} from "../src/rail-corridor-fact/index.ts";

const SOURCE_ADAPTER = "ntad-narn-proximity-v1";
const SOURCE_URL = NTAD_NARN_LINES_URL;

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    probeOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--probe-only") out.probeOnly = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

if (process.env.RAIL_CORRIDOR_FACT_PATH !== "1") {
  console.error("FATAL: RAIL_CORRIDOR_FACT_PATH=1 required (guards against an accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

const sql =
  poolUrl != null
    ? postgres(poolUrl, { max: 4, ssl: "require", prepare: false })
    : null;

async function readParcelRoster() {
  if (!sql) throw new Error("database pool required");
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

if (args.listCounties) {
  try {
    const parcels = await readParcelRoster();
    console.log(
      JSON.stringify(
        {
          event: "rail-corridor-fact.roster",
          source: "txgio_parcel geometry + NTAD NARN Lines (live fetch at execution time)",
          bufferMeters: RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
          endpoints: {
            narn: NTAD_NARN_LINES_URL,
            gradeCrossings: NTAD_GRADE_CROSSINGS_URL,
          },
          counties: parcels.map((p) => ({
            countyFips: p.county_fips,
            parcelRows: p.rows,
            parcelFeatures: p.features,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  if (sql) await sql.end({ timeout: 5 });
  process.exit(1);
}

if (args.probeOnly) {
  try {
    const probe = await probeNtadRailSource(args.county);
    console.log(JSON.stringify({ event: "rail-corridor-fact.probe", ...probe }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ event: "rail-corridor-fact.probe-failed", error: String(err) }));
    process.exitCode = 1;
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
  process.exit(process.exitCode ?? 0);
}

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required — store holding txgio_parcel geometry.");
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
  event: "rail-corridor-fact-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  bufferMeters: RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
  storeTruth: null,
  sourceProbe: null,
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
        event: "rail-corridor-fact-county.parcels-not-loaded",
        county: args.county,
        message: "county has zero rows in txgio_parcel — cannot plan rail-corridor facts",
      }),
    );
    process.exitCode = 1;
  } else {
    let corridors = [];
    let crossings = [];
    let sourceFetchFailed = false;
    try {
      summary.sourceProbe = await probeNtadRailSource(args.county);
      [corridors, crossings] = await Promise.all([
        fetchNtadRailCorridorsForCounty(args.county),
        fetchNtadGradeCrossingsForCounty(args.county),
      ]);
    } catch (err) {
      sourceFetchFailed = true;
      summary.sourceProbe = {
        error: String(err?.message ?? err),
        countyFips: args.county,
      };
    }

    summary.storeTruth = {
      parcelRows: parcelRow.rows,
      parcelFeatures: parcelRow.features,
      corridorsFetched: corridors.length,
      crossingsFetched: crossings.length,
      sourceFetchFailed,
      sourceVintage: NTAD_NARN_SOURCE_VINTAGE,
      note: "parcel-edge buffer-intersect against NTAD NARN lines + grade crossing points",
    };

    const parcels = [];
    let lastFeature = -1;
    while (true) {
      if (args.limit > 0 && parcels.length >= args.limit) break;
      const remaining =
        args.limit > 0 ? args.limit - parcels.length : Math.min(args.batch, 2000);
      const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
      const page = await sql`
        SELECT DISTINCT ON (feature_index)
               feature_index, prop_id, geometry
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND feature_index > ${lastFeature}
        ORDER BY feature_index
        LIMIT ${pageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        if (args.limit > 0 && parcels.length >= args.limit) break;
        parcels.push({
          parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
          geometry: p.geometry,
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < pageSize) break;
    }

    const plan = planCountyRailCorridor(parcels, corridors, crossings, {
      countyFips: args.county,
      sourceFetchFailed,
    });

    summary.plan = {
      parcelsRead: plan.parcelsRead,
      corridorsIndexed: plan.corridorsIndexed,
      crossingsIndexed: plan.crossingsIndexed,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWritePresentNear: plan.counts.presentNear,
      wouldWritePresentOutside: plan.counts.presentOutside,
      wouldWriteAbsent: plan.counts.absent,
      limitApplied: args.limit > 0 ? args.limit : null,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation: `NTAD NARN Lines ${NTAD_NARN_SOURCE_VINTAGE} county ${args.county}; grade crossings ${NTAD_GRADE_CROSSINGS_URL}`,
      sourceUrl: SOURCE_URL,
      sourceVintage: NTAD_NARN_SOURCE_VINTAGE,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForRailCorridorPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "rail-corridor-fact-county.dry-run-prediction",
          county: args.county,
          bufferMeters: RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
          ...summary.plan,
          sourceProbe: summary.sourceProbe,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            nearRailCorridor: a.nearRailCorridor ?? null,
            corridorStatus: a.corridorStatus ?? null,
            corridorClass: a.corridorClass ?? null,
            nearestCorridorDistanceMeters: a.nearestCorridorDistanceMeters ?? null,
            atGradeCrossingCount: a.atGradeCrossings?.length ?? 0,
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
        // stays the contract `railfact_<hex>` token), so the canonical did is what
        // the PK holds. `a.entityId` is the exact value written to `entity_id`
        // (for rail-corridor that is the bare parcelNodeId, not a suffixed key).
        const dids = slice.map((a) => `did:hauska:rail-corridor-fact:${a.entityId}`);
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
          const verdict = verifyStoredRailCorridorFactAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            outcome: atom.absence || atom.sourceTier === "absent" ? "absent" : "present",
            nearRailCorridor: atom.nearRailCorridor,
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
            event: "rail-corridor-fact-county.progress",
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
  if (sql) await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
