#!/usr/bin/env node
/**
 * apply-tx-rrc-staging-migration.mjs — idempotent DDL for tx_rrc_well / tx_rrc_pipeline.
 *
 * Uses jsonb geometry + bbox btree indexes (no PostGIS — Neon deployment lacks extension).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0073_tx_rrc_staging.sql");

const poolUrl =
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: DEPLOYMENT_DATABASE_URL or CORTEX_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 2, ssl: "require", prepare: false });
const ddl = readFileSync(MIGRATION, "utf8");

try {
  await sql.unsafe(ddl);
  const reg = await sql`
    SELECT
      to_regclass('public.tx_rrc_well') AS well,
      to_regclass('public.tx_rrc_pipeline') AS pipeline
  `;
  console.log(
    JSON.stringify({
      event: "tx-rrc-staging.migration-applied",
      wellTablePresent: reg[0]?.well != null,
      pipelineTablePresent: reg[0]?.pipeline != null,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
