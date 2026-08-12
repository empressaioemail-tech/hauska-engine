#!/usr/bin/env node
/**
 * apply-tx-fema-nfhl-geom.mjs — idempotent DDL for the tx_fema_nfhl_flood_zone
 * PostGIS geometry column and its GiST index.
 *
 * Runs migrations/0073_tx_fema_nfhl_flood_zone_geom.sql, then ANALYZE, then
 * reports the observed column/index/population state so the caller never has to
 * infer success from an absent error.
 *
 * DDL only. It does not write atoms and does not consume the atoms bulk-writer
 * slot. Backfill lives in populate-tx-fema-nfhl-geom.mjs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0073_tx_fema_nfhl_flood_zone_geom.sql");
const TABLE = "tx_fema_nfhl_flood_zone";
const GIST_INDEX = "tx_fema_nfhl_flood_zone_geom_gist_idx";

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 2, ssl: "require", prepare: false });

try {
  await sql.unsafe(readFileSync(MIGRATION, "utf8"));
  await sql.unsafe(`ANALYZE ${TABLE}`);

  const [{ v: postgisVersion }] = await sql`SELECT PostGIS_Version() AS v`;
  const [geomCol] = await sql`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${TABLE} AND column_name = 'geom'`;
  const [geomType] = await sql`
    SELECT type, srid
    FROM geometry_columns
    WHERE f_table_schema = 'public' AND f_table_name = ${TABLE} AND f_geometry_column = 'geom'`;
  const [gist] = await sql`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${TABLE} AND indexname = ${GIST_INDEX}`;
  const [counts] = await sql`
    SELECT count(*)::int AS rows_total, count(geom)::int AS geom_populated
    FROM ${sql(TABLE)}`;

  console.log(
    JSON.stringify(
      {
        event: "tx-fema-nfhl-geom.migration-applied",
        postgisVersion,
        geomColumnPresent: geomCol != null,
        geomColumnType: geomType?.type ?? null,
        geomColumnSrid: geomType?.srid ?? null,
        gistIndexCreated: gist != null,
        gistIndexDef: gist?.indexdef ?? null,
        rowsTotal: counts.rows_total,
        geomPopulated: counts.geom_populated,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
