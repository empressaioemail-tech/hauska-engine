#!/usr/bin/env node
/**
 * onboard-preflight CLI — the OPS-8 pre-flight gate for a fips (operator-
 * ratified 2026-08-03). Same invocation style as block13-cert-grade.mjs:
 * env DATABASE_URL etc., exits on its own, prints JSON.
 *
 * READ-ONLY. Never throws for an expected condition — every check produces
 * PASS or a NAMED decline. Checks that need live DB/network run only when
 * creds/config are present; without them the check honestly declines
 * "not runnable: <missing env>" rather than faking a PASS.
 *
 *   DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/onboard-preflight.mjs --fips=48021
 *
 * Checks 5-7 (geometry parity / serve-path health / cost sample) additionally
 * need, respectively: DATABASE_URL + TXGIO_DATABASE_URL (or CORTEX_DATABASE_URL)
 * for a live cert-grade sample run (same creds as block13-cert-grade.mjs); and
 * RETRIEVAL_API_URL + RETRIEVAL_API_KEY for the deployed retrieval-api (the
 * key env name matches services/retrieval-api's existing
 * `Authorization: Bearer <RETRIEVAL_API_KEY>` convention — see
 * services/retrieval-api/DEPLOY.md and src/server.ts; RETRIEVAL_API_URL is
 * new, paired the same way, since no prior script in this repo probed a
 * deployed retrieval-api URL). Absent creds/config, each check honestly
 * declines "not runnable" per the module's existing contract.
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { runOnboardPreflight } from "../src/registry/onboard-preflight.ts";
import { loadRegistryDistrictCohort } from "../src/registry/parcel-cohort-loader.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { gradeOneParcelInQueryMode } from "./block13-cert-grade.mjs";
import {
  buildGeometryParityProbe,
  buildServePathHealthProbe,
  buildCostSampleProbe,
} from "../src/registry/preflight-probes.ts";

function parseArgs(argv) {
  const out = { fips: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fips") out.fips = String(argv[++i] || "").trim();
    else if (a.startsWith("--fips=")) out.fips = a.slice("--fips=".length).trim();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.fips) {
  console.error("FATAL: --fips=<fips> required");
  process.exit(2);
}

const url = resolveSubstrateDatabaseUrl();
const sql = url ? postgres(url, { ssl: "require", max: 2, prepare: false }) : null;

const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || process.env.CORTEX_DATABASE_URL?.trim() || url;
const txSql = url && txgioUrl ? postgres(txgioUrl, { ssl: "require", max: 2, prepare: false }) : null;
const storage = url ? createPgStorage({ databaseUrl: url, maxConnections: 2 }) : null;

const retrievalApiUrl = process.env.RETRIEVAL_API_URL?.trim() || null;
const retrievalApiKey = process.env.RETRIEVAL_API_KEY?.trim() || null;

/**
 * Deterministic ~5-parcel sample for a row's cohort: load the full
 * registry-keyed cohort (buildWhereClause via loadRegistryDistrictCohort,
 * same cohort source the roster loader uses) and take the first 5 by prop
 * id, sorted ascending as STRINGS (prop ids are not reliably numeric across
 * jurisdictions) so reruns compare byte-for-byte.
 */
async function loadDeterministicSample(row, sampleSize = 5) {
  const cohort = await loadRegistryDistrictCohort(row.fips, null);
  const sortedIds = [...cohort.parcelNodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sortedIds.slice(0, sampleSize);
}

/** Road-node context shared by the geometry-parity sample grade (mirrors block13-cert-grade.mjs's setup). */
async function loadRoadsForFips(fips) {
  if (!sql) return [];
  const roadRows = await sql`
    SELECT body FROM atoms WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${fips}
      AND coalesce(body->>'status', 'active') = 'active'
  `;
  return roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);
}

/** Rail A / zoning source reachability — a plain HTTP HEAD/GET against the registry row's URL. */
async function probeHttpReachable(targetUrl, label) {
  if (!targetUrl) return { reachable: false, detail: `${label}: no URL on row` };
  try {
    const res = await fetch(targetUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return { reachable: res.ok, detail: res.ok ? undefined : `${label} HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, detail: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const deps = {
  probeRailASource: async (row) => {
    const layerUrl = row.railPerParcel?.featureServerLayerUrl;
    if (!layerUrl) return { reachable: false, detail: "no railPerParcel featureServerLayerUrl on row" };
    return probeHttpReachable(`${layerUrl.replace(/\/$/, "")}?f=json`, "Rail A featureServer");
  },
  probeZoningSource: async (row) => {
    // The registry row does not yet carry a distinct zoning-source URL field
    // (zoning is served off the same Rail A layer for euclidean-zoned rows
    // today); probe the same layer as a reachability proxy.
    const layerUrl = row.railPerParcel?.featureServerLayerUrl;
    if (!layerUrl) return { reachable: false, detail: "no zoning source wired on row" };
    return probeHttpReachable(`${layerUrl.replace(/\/$/, "")}?f=json`, "zoning source");
  },
  // NOTE: buildable-envelope atom bodies carry `parcelNodeId` (e.g.
  // "48021:34145"), never a `countyFips` key — confirmed against
  // emit-buildable-envelope.ts and every other county-scoped query in this
  // repo (block13-cert-grade.mjs, depth-warm-*-batch.mjs, tally-*-depth.mjs
  // all filter on `body->>'parcelNodeId' LIKE '<fips>:%'`). Filtering on a
  // key that never exists on the row silently matches zero atoms — a 0/0
  // "PASS" that looks like "measured, zero superseded" but is actually
  // "measurement path broken" (caught live against Bastrop 2026-08-03; see
  // onboard-preflight.ts's MEASURE-EMPTY-COHORT decline, which is the
  // backstop for this class of bug even after this fix).
  probeSupersededCohort: sql
    ? async (row) => {
        const fipsPrefix = `${row.fips}:%`;
        const [{ total }] = await sql`
          SELECT count(*)::int AS total FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
        `;
        const [{ superseded }] = await sql`
          SELECT count(*)::int AS superseded FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
            AND body ? 'supersededVintage'
        `;
        return { supersededCount: superseded, totalCount: total };
      }
    : undefined,
  probeMixedVintageResidue: sql
    ? async (row) => {
        const fipsPrefix = `${row.fips}:%`;
        const [{ residue }] = await sql`
          SELECT count(*)::int AS residue FROM atoms
          WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' LIKE ${fipsPrefix}
            AND body ? 'staleResidue'
        `;
        return { residueCount: residue, measured: true };
      }
    : undefined,
  // Check 5 — geometry parity: needs DATABASE_URL (+ TXGIO/CORTEX_DATABASE_URL)
  // to run the same grading machinery block13-cert-grade.mjs uses, on a
  // deterministic ~5-parcel sample of the row's cohort.
  probeGeometryParity:
    sql && txSql && storage
      ? buildGeometryParityProbe({
          sql,
          txSql,
          storage,
          descriptor: bastropDescriptor,
          loadSample: loadDeterministicSample,
          loadRoads: loadRoadsForFips,
          gradeOneParcel: gradeOneParcelInQueryMode,
        })
      : undefined,
  // Check 6 — serve-path health: needs RETRIEVAL_API_URL + RETRIEVAL_API_KEY
  // for the deployed retrieval-api (GET /health/search, authed GET /search,
  // authed GET /property-nodes/:id/atom-chain). Ledger-write probing is a
  // named partial: the coverage ledger lives in map/cortex Neon, not engine.
  probeServePathHealth:
    retrievalApiUrl && retrievalApiKey
      ? buildServePathHealthProbe({
          baseUrl: retrievalApiUrl,
          apiKey: retrievalApiKey,
          loadSample: loadDeterministicSample,
        })
      : undefined,
  // Check 7 — cost sample: piggybacks on the geometry-parity sample run,
  // measuring wall-clock + external call count and extrapolating to the
  // row's full cohort size against the $200 commitment-#3 gate. Shares the
  // same creds as check 5 (no separate env needed).
  probeCostSample:
    sql && txSql && storage
      ? buildCostSampleProbe({
          sql,
          txSql,
          storage,
          descriptor: bastropDescriptor,
          loadSample: loadDeterministicSample,
          loadRoads: loadRoadsForFips,
          gradeOneParcel: gradeOneParcelInQueryMode,
          loadCohortCount: async (row) => (await loadRegistryDistrictCohort(row.fips, null)).count,
        })
      : undefined,
};

try {
  const { report, ledgerEvents } = await runOnboardPreflight(args.fips, deps);
  console.log(JSON.stringify({ report, ledgerEvents }, null, 2));
  const anyDecline = report.rows.some((r) => r.railPlan.declines.length > 0);
  if (anyDecline) process.exitCode = 0; // declines are expected output, not a script failure
} finally {
  if (storage) await storage.close();
  if (txSql) await txSql.end();
  if (sql) await sql.end();
}
