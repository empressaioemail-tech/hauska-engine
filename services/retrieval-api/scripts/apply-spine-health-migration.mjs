#!/usr/bin/env node
/**
 * apply-spine-health-migration.mjs — idempotent runner for
 * 006_spine_health_probe.sql (COMPLETE-BASTROP B1) +
 * 007_spine_health_degraded_covered.sql (QA4).
 *
 *   DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
 *     pnpm --filter @hauska-engine/retrieval-api run apply-spine-health-migration
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "006_spine_health_probe.sql",
  "007_spine_health_degraded_covered.sql",
];

function migrationPath(filename) {
  return join(
    __dirname,
    "..",
    "..",
    "..",
    "packages",
    "storage",
    "migrations",
    filename,
  );
}

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
  for (const MIGRATION_FILE of MIGRATION_FILES) {
    const sqlText = await readFile(migrationPath(MIGRATION_FILE), "utf8");
    console.log(`Applying ${MIGRATION_FILE} ...`);
    await sql.unsafe(sqlText);
    console.log(`Applied ${MIGRATION_FILE} (idempotent).`);
  }

  const migrations = await sql`
    SELECT filename, applied_at
    FROM schema_migrations
    WHERE filename = ANY(${MIGRATION_FILES})
    ORDER BY filename
  `;
  console.log("\nschema_migrations:");
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
