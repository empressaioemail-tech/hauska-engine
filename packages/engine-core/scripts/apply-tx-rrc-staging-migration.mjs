#!/usr/bin/env node
/**
 * apply-tx-rrc-staging-migration.mjs — idempotent DDL for tx_rrc_well / tx_rrc_pipeline.
 *
 * Base DDL is jsonb geometry + bbox btree indexes (always safe, no PostGIS
 * required). Additionally attempts a PostGIS geom column + GiST index on
 * tx_rrc_pipeline only, matching what is already live in production —
 * mirrors apply-tx-building-footprint-migration.mjs's gracefully-degrading
 * pattern rather than assuming PostGIS unconditionally. tx_rrc_well stays
 * jsonb-only (no live geom column to reconcile).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0076_tx_rrc_staging.sql");

const poolUrl =
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: DEPLOYMENT_DATABASE_URL or CORTEX_DATABASE_URL required.");
  process.exit(1);
}

// See apply-tx-building-footprint-migration.mjs for why this stays
// unbounded regardless of hauska_mcp's own statement_timeout default.
const sql = postgres(poolUrl, {
  max: 2,
  ssl: "require",
  prepare: false,
  connection: { statement_timeout: "0" },
});
const ddl = readFileSync(MIGRATION, "utf8");

const report = {
  event: "tx-rrc-staging.migration-applied",
  wellTablePresent: false,
  pipelineTablePresent: false,
  postgisAvailable: false,
  pipelineGistIndexCreated: false,
  postgisNote: null,
};

try {
  await sql.unsafe(ddl);
  const reg = await sql`
    SELECT
      to_regclass('public.tx_rrc_well') AS well,
      to_regclass('public.tx_rrc_pipeline') AS pipeline
  `;
  report.wellTablePresent = reg[0]?.well != null;
  report.pipelineTablePresent = reg[0]?.pipeline != null;

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    report.postgisAvailable = true;

    const geomCol = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tx_rrc_pipeline'
        AND column_name = 'geom'
    `;
    if (geomCol.length === 0) {
      await sql`
        ALTER TABLE tx_rrc_pipeline
        ADD COLUMN geom geometry(Geometry, 4326)
      `;
    }

    await sql`
      CREATE INDEX IF NOT EXISTS tx_rrc_pipeline_geom_gist_idx
      ON tx_rrc_pipeline USING GIST (geom)
      WHERE geom IS NOT NULL
    `;
    report.pipelineGistIndexCreated = true;
  } catch (postgisErr) {
    report.postgisNote =
      "PostGIS unavailable — county_fips + bbox composite indexes serve spatial prefilter role. " +
      String(postgisErr?.message ?? postgisErr);
  }

  console.log(JSON.stringify(report));
} finally {
  await sql.end({ timeout: 5 });
}
