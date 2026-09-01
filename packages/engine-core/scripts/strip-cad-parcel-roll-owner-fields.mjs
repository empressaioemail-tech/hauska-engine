#!/usr/bin/env node
/**
 * strip-cad-parcel-roll-owner-fields.mjs — Option B backfill (2026-09-01).
 *
 * Removes `ownerName` and `ownerMailingAddress` from existing `cad-parcel-roll`
 * atom bodies. Owner data belongs on `owner-fact` (public-paid) only.
 *
 * Default is dry-run. Pass --apply to mutate. Do NOT run against production
 * without operator go and a forward-fix deploy on the writer path.
 *
 *   STRIP_CAD_PARCEL_ROLL_OWNER_PATH=1 \
 *   SUBSTRATE_DATABASE_URL=...direct... \
 *     pnpm --filter @hauska-engine/engine-core exec node \
 *       scripts/strip-cad-parcel-roll-owner-fields.mjs [--apply] [--county=48021] [--batch=500]
 *
 * Checkpoint: ./strip-cad-parcel-roll-owner-fields.checkpoint.json (cwd)
 * Log:        ./strip-cad-parcel-roll-owner-fields.log
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

const CHECKPOINT = "strip-cad-parcel-roll-owner-fields.checkpoint.json";
const LOG = "strip-cad-parcel-roll-owner-fields.log";
const ENTITY_TYPE = "cad-parcel-roll";
const ACCESS_POLICY = "public-free";

function log(line) {
  const row = `${new Date().toISOString()}\t${line}\n`;
  appendFileSync(LOG, row, "utf8");
  process.stdout.write(row);
}

function loadCheckpoint() {
  try {
    return JSON.parse(readFileSync(CHECKPOINT, "utf8"));
  } catch {
    return { lastAtomDid: null, updated: 0 };
  }
}

function saveCheckpoint(state) {
  writeFileSync(CHECKPOINT, JSON.stringify(state, null, 2));
}

function parseArgs(argv) {
  const out = { apply: false, county: null, batch: 500 };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim() || null;
    else if (a === "--county") out.county = String(argv[argv.indexOf(a) + 1] || "").trim() || null;
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length)) || 500;
    else if (a === "--batch") out.batch = Number(argv[argv.indexOf(a) + 1]) || 500;
  }
  return out;
}

function directDatabaseUrl(raw) {
  return raw.replace("-pooler.", ".");
}

if (process.env.STRIP_CAD_PARCEL_ROLL_OWNER_PATH !== "1") {
  console.error(
    "FATAL: STRIP_CAD_PARCEL_ROLL_OWNER_PATH=1 required (guards against accidental invocation).",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const rawUrl = resolveSubstrateDatabaseUrl();
if (!rawUrl) {
  console.error("FATAL: SUBSTRATE_DATABASE_URL (or DATABASE_URL) required.");
  process.exit(1);
}

if (args.apply && rawUrl.includes("-pooler.")) {
  console.error("FATAL: refuse pooler URL for --apply; strip -pooler. from host.");
  process.exit(1);
}

const databaseUrl = args.apply ? directDatabaseUrl(rawUrl) : rawUrl;
const sql = postgres(databaseUrl, { max: 1, ssl: "require", prepare: false });
const state = loadCheckpoint();

async function countWithOwnerFields(countyFips) {
  const countyFilter = countyFips
    ? sql`AND jurisdiction_tenant = ${`tx_${countyFips}`}`
    : sql``;
  const [row] = await sql`
    SELECT
      count(*) FILTER (WHERE body ? 'ownerName')::int AS with_owner_name,
      count(*) FILTER (WHERE body ? 'ownerMailingAddress')::int AS with_mailing,
      count(*) FILTER (
        WHERE body ? 'ownerName' OR body ? 'ownerMailingAddress'
      )::int AS with_either
    FROM atoms
    WHERE entity_type = ${ENTITY_TYPE}
      AND access_policy = ${ACCESS_POLICY}
      ${countyFilter}
  `;
  return row;
}

log(
  `start mode=${args.apply ? "apply" : "dry-run"} county=${args.county ?? "ALL"} batch=${args.batch} resumeFrom=${state.lastAtomDid ?? "START"}`,
);

try {
  const before = await countWithOwnerFields(args.county);
  log(
    `before withOwnerName=${before.with_owner_name} withMailing=${before.with_mailing} withEither=${before.with_either}`,
  );

  if (!args.apply) {
    if (before.with_either === 0) {
      log("dry-run complete: nothing to strip");
      process.exit(0);
    }

    const sample = args.county
      ? await sql`
          SELECT atom_did, body->>'ownerName' AS owner_name
          FROM atoms
          WHERE entity_type = ${ENTITY_TYPE}
            AND access_policy = ${ACCESS_POLICY}
            AND jurisdiction_tenant = ${`tx_${args.county}`}
            AND (body ? 'ownerName' OR body ? 'ownerMailingAddress')
          ORDER BY atom_did ASC
          LIMIT 5
        `
      : await sql`
          SELECT atom_did, body->>'ownerName' AS owner_name
          FROM atoms
          WHERE entity_type = ${ENTITY_TYPE}
            AND access_policy = ${ACCESS_POLICY}
            AND (body ? 'ownerName' OR body ? 'ownerMailingAddress')
          ORDER BY atom_did ASC
          LIMIT 5
        `;
    log(`dry-run sample=${JSON.stringify(sample)}`);
    log(
      `dry-run complete: would strip ${before.with_either} bodies; re-run with --apply to mutate`,
    );
    process.exit(0);
  }

  for (;;) {
    const countyFilter = args.county
      ? sql`AND jurisdiction_tenant = ${`tx_${args.county}`}`
      : sql``;
    const resumeFilter = state.lastAtomDid
      ? sql`AND atom_did > ${state.lastAtomDid}`
      : sql``;

    const rows = await sql`
      SELECT atom_did
      FROM atoms
      WHERE entity_type = ${ENTITY_TYPE}
        AND access_policy = ${ACCESS_POLICY}
        AND (body ? 'ownerName' OR body ? 'ownerMailingAddress')
        ${countyFilter}
        ${resumeFilter}
      ORDER BY atom_did ASC
      LIMIT ${args.batch}
    `;

    if (rows.length === 0) break;

    const dids = rows.map((r) => r.atom_did);
    const updated = await sql`
      UPDATE atoms
      SET body = body - 'ownerName' - 'ownerMailingAddress',
          updated_at = now()
      WHERE atom_did IN ${sql(dids)}
        AND entity_type = ${ENTITY_TYPE}
        AND access_policy = ${ACCESS_POLICY}
        AND (body ? 'ownerName' OR body ? 'ownerMailingAddress')
      RETURNING atom_did
    `;

    state.updated += updated.length;
    state.lastAtomDid = dids[dids.length - 1];
    saveCheckpoint(state);
    log(`batch updated=${updated.length} total=${state.updated} last=${state.lastAtomDid}`);
  }

  const after = await countWithOwnerFields(args.county);
  log(
    `after withOwnerName=${after.with_owner_name} withMailing=${after.with_mailing} withEither=${after.with_either}`,
  );
  log(`complete totalUpdated=${state.updated}`);
} finally {
  await sql.end({ timeout: 5 });
}
