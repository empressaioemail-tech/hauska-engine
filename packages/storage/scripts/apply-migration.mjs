#!/usr/bin/env node
/**
 * apply-migration.mjs — idempotent runner for 005_atoms_storage_port.sql.
 *
 * Reads DATABASE_URL (fallback SUBSTRATE_DATABASE_URL) from the env, applies
 * the 005 migration against the live DB, and prints the resulting
 * schema_migrations rows plus a table-existence check. Safe to re-run.
 *
 * Operator apply against substrate Neon:
 *   DATABASE_URL='postgres://...neon.tech/...?sslmode=require' \
 *     node packages/storage/scripts/apply-migration.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = "005_atoms_storage_port.sql";
const migrationPath = join(__dirname, "..", "migrations", MIGRATION_FILE);

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
    ORDER BY applied_at ASC, filename ASC
  `;
  console.log("schema_migrations rows:");
  for (const row of migrations) {
    console.log(
      `  - ${row.filename}  (${row.applied_at?.toISOString?.() ?? row.applied_at})`,
    );
  }

  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('atoms', 'atom_links', 'jurisdiction_status')
    ORDER BY table_name
  `;
  console.log("\nStoragePort tables present:");
  if (tables.length === 0) {
    console.log("  (none — migration did not create tables!)");
  } else {
    for (const row of tables) {
      const cols = await sql`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${row.table_name}
        ORDER BY ordinal_position
      `;
      console.log(`  ${row.table_name}:`);
      for (const col of cols) {
        console.log(`    - ${col.column_name} ${col.data_type}`);
      }
    }
  }

  console.log("\nMigration OK.");
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error("Migration FAILED:", err instanceof Error ? err.message : err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
