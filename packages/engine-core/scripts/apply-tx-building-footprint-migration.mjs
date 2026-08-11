#!/usr/bin/env node
/**
 * apply-tx-building-footprint-migration.mjs — idempotent DDL for tx_building_footprint.
 *
 * Applies base jsonb+bbox DDL, then attempts PostGIS extension + geom GiST index when available.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0073_tx_building_footprint.sql");

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 2, ssl: "require", prepare: false });
const ddl = readFileSync(MIGRATION, "utf8");

const report = {
  event: "tx-building-footprint.migration-applied",
  tablePresent: false,
  postgisAvailable: false,
  gistIndexCreated: false,
  postgisNote: null,
};

try {
  await sql.unsafe(ddl);
  const reg = await sql`SELECT to_regclass('public.tx_building_footprint') AS reg`;
  report.tablePresent = reg[0]?.reg != null;

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    report.postgisAvailable = true;

    const geomCol = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tx_building_footprint'
        AND column_name = 'geom'
    `;
    if (geomCol.length === 0) {
      await sql`
        ALTER TABLE tx_building_footprint
        ADD COLUMN geom geometry(Polygon, 4326)
      `;
    }

    await sql`
      CREATE INDEX IF NOT EXISTS tx_building_footprint_geom_gist_idx
      ON tx_building_footprint USING GIST (geom)
    `;
    report.gistIndexCreated = true;
  } catch (postgisErr) {
    report.postgisNote =
      "PostGIS unavailable — county_fips + bbox composite indexes serve spatial prefilter role. " +
      String(postgisErr?.message ?? postgisErr);
  }

  console.log(JSON.stringify(report));
} finally {
  await sql.end({ timeout: 5 });
}
