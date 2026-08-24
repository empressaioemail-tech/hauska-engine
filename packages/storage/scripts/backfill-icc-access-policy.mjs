#!/usr/bin/env node
/**
 * Bounded, resumable backfill: set platform-internal on ICC model-code atoms
 * that still carry public-free from pre-fix ingests.
 *
 * Run ONLY after writer fix + migration 010 are merged and applied.
 *
 * Usage:
 *   DATABASE_URL=... node packages/storage/scripts/backfill-icc-access-policy.mjs
 *
 * Checkpoint file: ./backfill-icc-access-policy.checkpoint.json (cwd)
 * Record log:       ./backfill-icc-access-policy.log
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const BATCH_SIZE = 500;
const TENANT = "icc-model-code";
const TARGET_POLICY = "platform-internal";
const CHECKPOINT = "backfill-icc-access-policy.checkpoint.json";
const LOG = "backfill-icc-access-policy.log";

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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const state = loadCheckpoint();

log(
  `start tenant=${TENANT} batch=${BATCH_SIZE} resumeFrom=${state.lastAtomDid ?? "START"}`,
);

try {
  for (;;) {
    const rows = state.lastAtomDid
      ? await sql`
          SELECT atom_did FROM atoms
          WHERE jurisdiction_tenant = ${TENANT}
            AND access_policy = 'public-free'
            AND atom_did > ${state.lastAtomDid}
          ORDER BY atom_did ASC
          LIMIT ${BATCH_SIZE}
        `
      : await sql`
          SELECT atom_did FROM atoms
          WHERE jurisdiction_tenant = ${TENANT}
            AND access_policy = 'public-free'
          ORDER BY atom_did ASC
          LIMIT ${BATCH_SIZE}
        `;

    if (rows.length === 0) break;

    const dids = rows.map((r) => r.atom_did);
    const updated = await sql`
      UPDATE atoms
      SET access_policy = ${TARGET_POLICY}, updated_at = now()
      WHERE atom_did IN ${sql(dids)}
        AND jurisdiction_tenant = ${TENANT}
        AND access_policy = 'public-free'
      RETURNING atom_did
    `;

    state.updated += updated.length;
    state.lastAtomDid = dids[dids.length - 1];
    saveCheckpoint(state);
    log(`batch updated=${updated.length} total=${state.updated} last=${state.lastAtomDid}`);
  }

  log(`complete totalUpdated=${state.updated}`);
} finally {
  await sql.end();
}
