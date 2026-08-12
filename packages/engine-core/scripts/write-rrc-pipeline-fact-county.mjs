#!/usr/bin/env node
/**
 * write-rrc-pipeline-fact-county.mjs — `rrc-pipeline-fact` writer.
 *
 * RRC T-4 pipeline LINE proximity from staged `tx_rrc_pipeline` (NOT live RRC
 * fetch; NOT railroad tracks / NTAD NARN).
 *
 *   RRC_PIPELINE_FACT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-rrc-pipeline-fact-county -- \
 *       --county=48329 [--apply] [--batch=500] [--limit=0]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { RRC_PIPELINE_DEFAULT_BUFFER_METERS } from "@empressaio/atom-contract/property";

import {
  buildAtomsForRrcPipelinePlan,
  planCountyRrcPipeline,
  verifyStoredRrcPipelineFactAtom,
} from "../src/rrc-pipeline-fact/index.ts";

const SOURCE_ADAPTER = "tx-rrc-pipeline-staged-v1";
const SOURCE_URL = "tx_rrc_pipeline";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
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
  }
  return out;
}

if (process.env.RRC_PIPELINE_FACT_PATH !== "1") {
  console.error(
    "FATAL: RRC_PIPELINE_FACT_PATH=1 required (guards against an accidental invocation).",
  );
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

async function pipelineTableExists() {
  if (!sql) return false;
  const rows = await sql`SELECT to_regclass('public.tx_rrc_pipeline') AS reg`;
  return rows[0]?.reg != null;
}

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
    const hasTable = await pipelineTableExists();
    let pipelineRows = null;
    if (hasTable) {
      const r = await sql`SELECT count(*)::int AS n FROM tx_rrc_pipeline`;
      pipelineRows = r[0]?.n ?? 0;
    }
    console.log(
      JSON.stringify(
        {
          event: "rrc-pipeline-fact.roster",
          source: "txgio_parcel geometry + staged tx_rrc_pipeline",
          bufferMeters: RRC_PIPELINE_DEFAULT_BUFFER_METERS,
          pipelineTablePresent: hasTable,
          pipelineRows,
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

if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — store holding txgio_parcel + tx_rrc_pipeline.",
  );
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error(
    "FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).",
  );
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "rrc-pipeline-fact-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  bufferMeters: RRC_PIPELINE_DEFAULT_BUFFER_METERS,
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
        event: "rrc-pipeline-fact-county.parcels-not-loaded",
        county: args.county,
        message:
          "county has zero rows in txgio_parcel — cannot plan rrc-pipeline facts",
      }),
    );
    process.exitCode = 1;
  } else {
    let segments = [];
    let sourceReadFailed = false;
    let sourceVintage = null;
    let sourceCitation = null;

    const hasTable = await pipelineTableExists();
    if (!hasTable) {
      sourceReadFailed = true;
    } else {
      try {
        const pipelineRows = await sql`
          SELECT pipeline_row_id, p5_num, t4permit, operator, system_name,
                 commodity, commodity_description, system_type, status, diameter,
                 interstate, geometry, west_lng, south_lat, east_lng, north_lat,
                 source_vintage, source_citation
          FROM tx_rrc_pipeline
          WHERE county_fips = ${args.county}
        `;
        segments = pipelineRows.map((d) => ({
          pipelineRowId: String(d.pipeline_row_id),
          t4permit: d.t4permit != null ? String(d.t4permit) : null,
          p5Num: d.p5_num != null ? String(d.p5_num) : null,
          operatorName: d.operator != null ? String(d.operator) : null,
          systemName: d.system_name != null ? String(d.system_name) : null,
          commodity: d.commodity != null ? String(d.commodity) : null,
          commodityDescription:
            d.commodity_description != null
              ? String(d.commodity_description)
              : null,
          systemType: d.system_type != null ? String(d.system_type) : null,
          status: d.status != null ? String(d.status) : null,
          diameter:
            d.diameter != null && Number.isFinite(Number(d.diameter))
              ? Number(d.diameter)
              : null,
          interstate:
            d.interstate === null || d.interstate === undefined
              ? null
              : typeof d.interstate === "boolean"
                ? d.interstate
                : String(d.interstate),
          geometry: d.geometry,
          westLng: Number(d.west_lng),
          southLat: Number(d.south_lat),
          eastLng: Number(d.east_lng),
          northLat: Number(d.north_lat),
        }));
        if (pipelineRows.length > 0) {
          sourceVintage = pipelineRows[0].source_vintage ?? null;
          sourceCitation = pipelineRows[0].source_citation ?? null;
        }
      } catch (err) {
        sourceReadFailed = true;
        summary.sourceReadError = String(err?.message ?? err);
      }
    }

    summary.storeTruth = {
      parcelRows: parcelRow.rows,
      parcelFeatures: parcelRow.features,
      pipelineTablePresent: hasTable,
      pipelinesFetched: segments.length,
      sourceReadFailed,
      sourceVintage,
      note: "parcel-edge buffer-intersect against staged tx_rrc_pipeline lines; dedupe t4permit|p5_num",
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

    const plan = planCountyRrcPipeline(parcels, segments, {
      countyFips: args.county,
      sourceReadFailed,
    });

    summary.plan = {
      parcelsRead: plan.parcelsRead,
      pipelinesIndexed: plan.pipelinesIndexed,
      pipelinesDeduped: plan.pipelinesDeduped,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWritePresentNear: plan.counts.presentNear,
      wouldWritePresentOutside: plan.counts.presentOutside,
      wouldWriteAbsent: plan.counts.absent,
      limitApplied: args.limit > 0 ? args.limit : null,
    };

    const provenance = {
      sourceAdapter: SOURCE_ADAPTER,
      sourceCitation:
        sourceCitation ??
        `tx_rrc_pipeline staged county ${args.county} (RRC T-4 pipeline GIS)`,
      sourceUrl: SOURCE_URL,
      sourceVintage: sourceVintage ?? undefined,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForRrcPipelinePlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      const nearSample = atoms.find((a) => a.nearPipeline === true);
      const outsideSample = atoms.find((a) => a.nearPipeline === false);
      console.log(
        JSON.stringify({
          event: "rrc-pipeline-fact-county.dry-run-prediction",
          county: args.county,
          bufferMeters: RRC_PIPELINE_DEFAULT_BUFFER_METERS,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            entityId: a.entityId,
            parcelNodeId: a.parcelNodeId,
            nearPipeline: a.nearPipeline ?? null,
            t4permit: a.t4permit ?? null,
            p5Num: a.p5Num ?? null,
            nearestPipelineDistanceMeters:
              a.nearestPipelineDistanceMeters ?? null,
            bufferMeters: a.bufferMeters,
            absenceKind: a.absence?.kind ?? null,
          })),
          sampleNear: nearSample
            ? {
                atomDid: nearSample.atomDid,
                entityId: nearSample.entityId,
                bufferMeters: nearSample.bufferMeters,
                nearPipeline: nearSample.nearPipeline,
                t4permit: nearSample.t4permit ?? null,
                p5Num: nearSample.p5Num ?? null,
                nearestPipelineDistanceMeters:
                  nearSample.nearestPipelineDistanceMeters ?? null,
                operatorName: nearSample.operatorName ?? null,
              }
            : null,
          sampleOutside: outsideSample
            ? {
                atomDid: outsideSample.atomDid,
                entityId: outsideSample.entityId,
                bufferMeters: outsideSample.bufferMeters,
                nearPipeline: outsideSample.nearPipeline,
              }
            : null,
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
        // stays the contract `pipefact_<hex>` token), so the canonical did is what
        // the PK holds. `a.entityId` is the exact value written to `entity_id`
        // (for rrc-pipeline-fact that is the bare parcelNodeId, not a suffixed key).
        const dids = slice.map(
          (a) => `did:hauska:rrc-pipeline-fact:${a.entityId}`,
        );
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
              problem: "atom not readable back via atom_did PK after write",
            });
            continue;
          }
          const verdict = verifyStoredRrcPipelineFactAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            outcome:
              atom.absence || atom.sourceTier === "absent" ? "absent" : "present",
            nearPipeline: atom.nearPipeline,
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
            event: "rrc-pipeline-fact-county.progress",
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
