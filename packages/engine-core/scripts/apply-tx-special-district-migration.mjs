#!/usr/bin/env node
/**
 * apply-tx-special-district-migration.mjs — idempotent DDL for tx_special_district.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0072_tx_special_district.sql");

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

try {
  await sql.unsafe(ddl);
  const reg = await sql`SELECT to_regclass('public.tx_special_district') AS reg`;
  console.log(
    JSON.stringify({
      event: "tx-special-district.migration-applied",
      tablePresent: reg[0]?.reg != null,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
