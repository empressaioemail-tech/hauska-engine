#!/usr/bin/env node
/**
 * warden-sweep CLI — OPS-9 S5 post-onboarding sweep (operator-authorized
 * 2026-08-04, the Warden). Same invocation style as onboard-preflight.mjs /
 * block13-cert-grade.mjs: env DATABASE_URL etc., exits on its own, prints
 * JSON. FILES-NEVER-FIXES: this script and every module it imports from
 * src/warden/** read state and report findings; none of them write an atom.
 *
 *   DATABASE_URL=... TXGIO_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/warden-sweep.mjs \
 *       --row-id=Bastrop [--checks=neighborConsistency,servePathTruth] \
 *       [--sample=10] [--cert-artifact=path/to/cert.json] [--out=path/to/report.json]
 *
 * Env — THREE separate connections/endpoints, each serving a DIFFERENT store.
 * Mixing these up is the exact bug this script's header once let slip through
 * (a live prod sweep hit `PostgresError: relation "txgio_parcel" does not
 * exist` because neighborConsistency's adjacency loader was wired to the
 * wrong connection — see the git history on this comment block):
 *   DATABASE_URL — the ATOMS Neon (zoning-fact / buildable-envelope /
 *     road-node atoms). Required for neighborConsistency, crossStoreConsistency,
 *     certFreshness (all read atoms; loadZoningByParcel/loadDbTruthForParcel/
 *     loadRoadsForFips all query this connection, never txgio_parcel).
 *   TXGIO_DATABASE_URL (falls back to CORTEX_DATABASE_URL, then DATABASE_URL
 *     — see the honest-degrade note below) — the LDT DEPLOYMENT Neon carrying
 *     `txgio_parcel` (cadastral geometry + bbox). In prod this is the
 *     legacy-design-tools-prod DEPLOYMENT_DATABASE_URL secret, a DIFFERENT
 *     database from the atoms Neon. Required for neighborConsistency's
 *     adjacency load (loadParcelAdjacencyIndexFromNeon reads txgio_parcel)
 *     and for crossStoreConsistency/certFreshness's situs-address lookup
 *     inside cert-grade-core.ts (also txgio_parcel, via ctx.txSql — never
 *     ctx.sql). The DATABASE_URL fallback exists so a single-Neon local dev
 *     setup (one DB carrying both tables) still runs; it is NOT a safe prod
 *     default when the two stores are actually separate deployments, which
 *     is why prod must set TXGIO_DATABASE_URL explicitly.
 *   RETRIEVAL_API_URL + RETRIEVAL_API_KEY — the deployed retrieval-api.
 *     Required for servePathTruth only (health/search, search, atom-chain
 *     probes — no DB connection).
 *   LEDGER_INGEST_URL + LEDGER_INGEST_KEY — optional; when set, findings are
 *     also POSTed to the cortex-side onboarding-ledger per the pinned
 *     contract in src/warden/ledger-write.ts. Absent, artifact-only.
 *
 * Exit code: 0 on a clean sweep OR a sweep that produced flag findings
 * (findings are DATA, not a script failure) — non-zero ONLY on a tooling
 * failure (e.g. unknown --row-id, DB connection failure at startup).
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { loadJurisdictionRegistryRowById } from "../src/registry/jurisdiction-registry.ts";
import { loadRegistryDistrictCohort } from "../src/registry/parcel-cohort-loader.ts";
import { loadParcelAdjacencyIndexFromNeon, getParcelEdgeNeighbors } from "../src/boundary-primitive/index.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };

import { classifyNeighborConsistency } from "../src/warden/neighbor-consistency.ts";
import { runServePathTruthCheck } from "../src/warden/serve-path-truth.ts";
import { runCrossStoreConsistencyCheck } from "../src/warden/cross-store-consistency.ts";
import { runCertFreshnessCheck } from "../src/warden/cert-freshness.ts";
import { buildSweepReport, writeFindingsToJsonArtifact, postFindingsToLedger } from "../src/warden/ledger-write.ts";

const ALL_CHECK_IDS = ["neighborConsistency", "servePathTruth", "crossStoreConsistency", "certFreshness"];

function parseArgs(argv) {
  const out = { rowId: null, checks: null, sample: 10, certArtifact: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--row-id") out.rowId = String(argv[++i] || "").trim();
    else if (a.startsWith("--row-id=")) out.rowId = a.slice("--row-id=".length).trim();
    else if (a === "--checks") out.checks = String(argv[++i] || "").trim();
    else if (a.startsWith("--checks=")) out.checks = a.slice("--checks=".length).trim();
    else if (a === "--sample") out.sample = Number(argv[++i]);
    else if (a.startsWith("--sample=")) out.sample = Number(a.slice("--sample=".length));
    else if (a === "--cert-artifact") out.certArtifact = String(argv[++i] || "").trim();
    else if (a.startsWith("--cert-artifact=")) out.certArtifact = a.slice("--cert-artifact=".length).trim();
    else if (a === "--out") out.out = String(argv[++i] || "").trim();
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.rowId) {
  console.error("FATAL: --row-id=<rowId> required (e.g. --row-id=Bastrop)");
  process.exit(2);
}
const row = loadJurisdictionRegistryRowById(args.rowId);
if (!row) {
  console.error(`FATAL: unknown --row-id=${args.rowId} (no such row in the frozen jurisdiction registry)`);
  process.exit(2);
}

const requestedChecks = args.checks ? args.checks.split(",").map((c) => c.trim()).filter(Boolean) : ALL_CHECK_IDS;
const unknownCheck = requestedChecks.find((c) => !ALL_CHECK_IDS.includes(c));
if (unknownCheck) {
  console.error(`FATAL: unknown --checks entry "${unknownCheck}" (valid: ${ALL_CHECK_IDS.join(", ")})`);
  process.exit(2);
}
const sampleSize = Number.isFinite(args.sample) && args.sample > 0 ? args.sample : 10;

const sweepId = `warden-${row.fips}-${row.rowId.replace(/\s+/g, "_")}-${Date.now()}`;
const now = () => new Date();

console.log(`[warden-sweep] sweepId=${sweepId} rowId=${row.rowId} fips=${row.fips} checks=${requestedChecks.join(",")} sample=${sampleSize}`);

const url = resolveSubstrateDatabaseUrl();
const sql = url ? postgres(url, { ssl: "require", max: 2, prepare: false }) : null;
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || process.env.CORTEX_DATABASE_URL?.trim() || url;
const txSql = url && txgioUrl ? postgres(txgioUrl, { ssl: "require", max: 2, prepare: false }) : null;
const storageHandle = url ? createPgStorage({ databaseUrl: url, maxConnections: 2 }) : null;

const retrievalApiUrl = process.env.RETRIEVAL_API_URL?.trim() || null;
const retrievalApiKey = process.env.RETRIEVAL_API_KEY?.trim() || null;
const ledgerIngestUrl = process.env.LEDGER_INGEST_URL?.trim() || null;
const ledgerIngestKey = process.env.LEDGER_INGEST_KEY?.trim() || null;

/** Deterministic first-N-by-prop-id sample, sorted ascending as strings (mirrors onboard-preflight.mjs's sample convention). */
async function loadDeterministicSample(fips, sampleSizeArg = sampleSize) {
  const cohort = await loadRegistryDistrictCohort(fips, null);
  const sortedIds = [...cohort.parcelNodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { cohort, sample: sortedIds.slice(0, sampleSizeArg) };
}

async function loadRoadsForFips(fips) {
  if (!sql) return [];
  const roadRows = await sql`
    SELECT body FROM atoms WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${fips}
      AND coalesce(body->>'status', 'active') = 'active'
  `;
  return roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);
}

/** Loads zoning-fact district (or null for honest-absence) for a set of parcelNodeIds — READ ONLY. */
async function loadZoningByParcel(parcelNodeIds) {
  const map = new Map();
  if (!sql || parcelNodeIds.length === 0) return map;
  const rows = await sql`
    SELECT DISTINCT ON (body->>'parcelNodeId') body->>'parcelNodeId' AS parcel_node_id, body
    FROM atoms
    WHERE entity_type = 'zoning-fact' AND body->>'parcelNodeId' = ANY(${parcelNodeIds})
    ORDER BY body->>'parcelNodeId', updated_at DESC NULLS LAST
  `;
  for (const r of rows) {
    const district = r.body?.absence ? null : (r.body?.district ?? null);
    map.set(r.parcel_node_id, {
      parcelNodeId: r.parcel_node_id,
      propId: r.parcel_node_id.split(":")[1] ?? "",
      district,
    });
  }
  return map;
}

/** Loads DB truth (zoning-fact presence + district, buildable-envelope presence) for the servePathTruth body-sanity comparison. */
async function loadDbTruthForParcel(parcelNodeId) {
  if (!sql) return { hasZoningFact: false, district: null, hasBuildableEnvelope: false };
  const [zf] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const [env] = await sql`
    SELECT 1 FROM atoms WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId} LIMIT 1
  `;
  const hasZoningFact = !!zf && !zf.body?.absence;
  return {
    hasZoningFact,
    district: hasZoningFact ? (zf.body?.district ?? null) : null,
    hasBuildableEnvelope: !!env,
  };
}

/** Tolerant loader for a --cert-artifact JSON (block13-cert-grade.mjs output shape, or a Warden report). */
async function loadPriorCertVerdict(path) {
  if (!path) return undefined;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  const json = JSON.parse(raw);
  const passByParcel = {};
  const results = json.results ?? json.parcels ?? json.roster ?? [];
  for (const entry of Array.isArray(results) ? results : []) {
    const parcelNodeId = entry.parcelNodeId ?? entry.parcel_node_id;
    if (parcelNodeId) passByParcel[parcelNodeId] = !!entry.pass;
  }
  return {
    passByParcel,
    artifactPath: path,
    artifactTs: json.ts ?? json.timestamp ?? json.generatedAt ?? null,
  };
}

async function main() {
  const findings = [];
  const checksRun = [];

  const { cohort, sample } = await loadDeterministicSample(row.fips, sampleSize);
  console.log(`[warden-sweep] cohort size=${cohort.count} sample size=${sample.length}`);

  if (requestedChecks.includes("neighborConsistency")) {
    checksRun.push("neighborConsistency");
    if (!sql || !txSql) {
      console.log("[warden-sweep] neighborConsistency: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      // txgio_parcel lives in the TXGIO Neon (the ldt deployment DB), NOT the
      // atoms Neon — the adjacency index MUST be built from txSql. zoningByParcel
      // below correctly stays on sql (the atoms DB), since zoning-fact atoms
      // live there.
      const index = await loadParcelAdjacencyIndexFromNeon(txSql, row.fips);
      const zoningByParcel = await loadZoningByParcel(cohort.parcelNodeIds);
      // Also resolve every neighbor referenced by the cohort so cross-cohort
      // edges (a cohort parcel bordering a parcel outside the row's filter,
      // e.g. a city-filtered row bordering unincorporated county) still have
      // zoning state to compare against, when present.
      const neighborIds = new Set();
      for (const parcelNodeId of cohort.parcelNodeIds) {
        const neighbors = index.entries.has(parcelNodeId)
          ? getParcelEdgeNeighbors(index, parcelNodeId)
          : null;
        for (const propId of neighbors ?? []) {
          if (propId) neighborIds.add(`${row.fips}:${propId}`);
        }
      }
      const extraZoning = await loadZoningByParcel([...neighborIds]);
      for (const [k, v] of extraZoning) if (!zoningByParcel.has(k)) zoningByParcel.set(k, v);

      const neighborFindings = classifyNeighborConsistency({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        row,
        index,
        zoningByParcel,
        cohortParcelNodeIds: cohort.parcelNodeIds,
        now,
      });
      findings.push(...neighborFindings);
      console.log(`[warden-sweep] neighborConsistency: ${neighborFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("servePathTruth")) {
    checksRun.push("servePathTruth");
    if (!retrievalApiUrl || !retrievalApiKey) {
      console.log("[warden-sweep] servePathTruth: skipped, RETRIEVAL_API_URL/RETRIEVAL_API_KEY not configured");
    } else {
      const servePathFindings = await runServePathTruthCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          baseUrl: retrievalApiUrl,
          apiKey: retrievalApiKey,
          sample,
          loadDbTruth: loadDbTruthForParcel,
        },
      });
      findings.push(...servePathFindings);
      console.log(`[warden-sweep] servePathTruth: ${servePathFindings.length} finding(s)`);
    }
  }

  const priorVerdict = await loadPriorCertVerdict(args.certArtifact);

  if (requestedChecks.includes("crossStoreConsistency")) {
    checksRun.push("crossStoreConsistency");
    if (!sql || !txSql || !storageHandle) {
      console.log("[warden-sweep] crossStoreConsistency: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const roads = await loadRoadsForFips(row.fips);
      const crossStoreFindings = await runCrossStoreConsistencyCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          ctx: { sql, txSql, storage: storageHandle.storage, roads, descriptor: bastropDescriptor },
          sample,
          row,
          priorVerdict,
        },
      });
      findings.push(...crossStoreFindings);
      console.log(`[warden-sweep] crossStoreConsistency: ${crossStoreFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("certFreshness")) {
    checksRun.push("certFreshness");
    if (!sql || !txSql || !storageHandle) {
      console.log("[warden-sweep] certFreshness: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const roads = await loadRoadsForFips(row.fips);
      const certFreshnessFindings = await runCertFreshnessCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          ctx: { sql, txSql, storage: storageHandle.storage, roads, descriptor: bastropDescriptor },
          sample,
          row,
          priorVerdict,
        },
      });
      findings.push(...certFreshnessFindings);
      console.log(`[warden-sweep] certFreshness: ${certFreshnessFindings.length} finding(s)`);
    }
  }

  const report = buildSweepReport({
    sweepId,
    rowId: row.rowId,
    fips: row.fips,
    checksRun,
    findings,
    now,
  });

  const outPath = args.out ?? `warden-sweep-${sweepId}.json`;
  await writeFindingsToJsonArtifact(outPath, report);
  console.log(`[warden-sweep] artifact written: ${outPath}`);

  const ledgerResult = await postFindingsToLedger(ledgerIngestUrl, ledgerIngestKey, report);
  console.log(`[warden-sweep] ledger post: ${JSON.stringify(ledgerResult)}`);

  console.log(JSON.stringify({ sweepId: report.sweepId, rowId: report.rowId, fips: report.fips, clean: report.clean, findingCount: report.findings.length, checksRun: report.checksRun }, null, 2));
}

try {
  await main();
  // findings (clean or flagged) are expected DATA, never a tooling failure.
  process.exitCode = 0;
} catch (err) {
  console.error(`FATAL: warden-sweep tooling failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (storageHandle) await storageHandle.close();
  if (txSql) await txSql.end();
  if (sql) await sql.end();
}
