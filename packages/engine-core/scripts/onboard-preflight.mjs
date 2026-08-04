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
 * declines "not runnable" via the module's existing contract.
 *
 * Grading machinery (checks 5/7) is imported from
 * src/registry/cert-grade-core.ts, NOT from block13-cert-grade.mjs — that
 * script depends on cert-grade-core.ts, not the reverse, so this CLI's own
 * module graph never pulls in the sibling script's top-level side effects.
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { runOnboardPreflight } from "../src/registry/onboard-preflight.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { gradeOneParcelInQueryMode } from "../src/registry/cert-grade-core.ts";
import { buildOnboardPreflightDeps } from "../src/registry/preflight-probes.ts";

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
const storageHandle = url ? createPgStorage({ databaseUrl: url, maxConnections: 2 }) : null;

const retrievalApiUrl = process.env.RETRIEVAL_API_URL?.trim() || null;
const retrievalApiKey = process.env.RETRIEVAL_API_KEY?.trim() || null;

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

// NOTE: buildable-envelope atom bodies carry `parcelNodeId` (e.g.
// "48021:34145"), never a `countyFips` key — confirmed against
// emit-buildable-envelope.ts and every other county-scoped query in this
// repo (block13-cert-grade.mjs, depth-warm-*-batch.mjs, tally-*-depth.mjs
// all filter on `body->>'parcelNodeId' LIKE '<fips>:%'`). Filtering on a
// key that never exists on the row silently matches zero atoms — a 0/0
// "PASS" that looks like "measured, zero superseded" but is actually
// "measurement path broken" (caught live against Bastrop; see
// onboard-preflight.ts's MEASURE-EMPTY-COHORT decline, which is the
// backstop for this class of bug even after this fix). Preserved inside
// buildOnboardPreflightDeps (S4) — the probe-wiring itself moved to
// src/registry/preflight-probes.ts so block13-cert-grade.mjs's internal
// preflight can reuse the SAME live wiring instead of an empty deps object.
const deps = buildOnboardPreflightDeps({
  sql: sql ?? undefined,
  txSql: txSql ?? undefined,
  storage: storageHandle?.storage,
  descriptor: bastropDescriptor,
  retrievalApiUrl,
  retrievalApiKey,
  gradeOneParcel: gradeOneParcelInQueryMode,
  loadRoads: loadRoadsForFips,
});

try {
  const { report, ledgerEvents } = await runOnboardPreflight(args.fips, deps);
  console.log(JSON.stringify({ report, ledgerEvents }, null, 2));
  const anyDecline = report.rows.some((r) => r.railPlan.declines.length > 0);
  if (anyDecline) process.exitCode = 0; // declines are expected output, not a script failure
} finally {
  if (storageHandle) await storageHandle.close();
  if (txSql) await txSql.end();
  if (sql) await sql.end();
}
