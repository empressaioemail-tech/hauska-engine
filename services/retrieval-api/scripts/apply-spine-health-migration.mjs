#!/usr/bin/env node
/**
 * apply-spine-health-migration.mjs — idempotent runner for
 * 006_spine_health_probe.sql (COMPLETE-BASTROP B1).
 *
 *   DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
 *     pnpm --filter @hauska-engine/retrieval-api run apply-spine-health-migration
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = "006_spine_health_probe.sql";
const migrationPath = join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
  MIGRATION_FILE,
);

const url = process.env.DATABASE_URL ?? process.env.SUBSTRATE_DATABASE_URL;
if (!url) {
  console.error(
    "FATAL: neither DATABASE_URL nor SUBSTRATE_DATABASE_URL is set.",
  );
  process.exit(1);
}

const ssl =
  url.includes("sslmode=require") || url.includes("neon.tech")
    ? "require"
    : false;

const sql = postgres(url, { ssl, max: 1 });

try {
  const migrationSql = await readFile(migrationPath, "utf8");
  console.log(`Applying ${MIGRATION_FILE} ...`);
  await sql.unsafe(migrationSql);
  console.log(`Applied ${MIGRATION_FILE} (idempotent).\n`);

  const migrations = await sql`
    SELECT filename, applied_at
    FROM schema_migrations
    WHERE filename = ${MIGRATION_FILE}
  `;
  console.log("schema_migrations:");
  for (const row of migrations) {
    console.log(
      `  - ${row.filename}  (${row.applied_at?.toISOString?.() ?? row.applied_at})`,
    );
  }

  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spine_health_probe'
    ORDER BY ordinal_position
  `;
  console.log("\nspine_health_probe columns:");
  for (const col of cols) {
    console.log(`  - ${col.column_name} ${col.data_type}`);
  }

  console.log("\nMigration OK.");
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error("Migration FAILED:", err instanceof Error ? err.message : err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
