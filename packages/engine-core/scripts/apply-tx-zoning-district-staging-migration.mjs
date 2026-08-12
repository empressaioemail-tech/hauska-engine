#!/usr/bin/env node
/**
 * apply-tx-zoning-district-staging-migration.mjs — idempotent DDL for
 * tx_zoning_district_staging (neondb / Factory 1.5).
 *
 *   CORTEX_DATABASE_URL=... (direct host, no -pooler) \
 *     node packages/engine-core/scripts/apply-tx-zoning-district-staging-migration.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "migrations", "0074_tx_zoning_district_staging.sql");

function stripPooler(url) {
  return String(url).replace(/-pooler/g, "");
}

function hostFingerprint(url) {
  try {
    const u = new URL(url);
    return `${u.hostname} (direct, no pooler=${!u.hostname.includes("-pooler")})`;
  } catch {
    return "(unparseable)";
  }
}

const raw =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!raw) {
  console.error("FATAL: CORTEX_DATABASE_URL or DEPLOYMENT_DATABASE_URL required.");
  process.exit(1);
}

const poolUrl = stripPooler(raw);
if (poolUrl.includes("-pooler")) {
  console.error("FATAL: connection string still contains -pooler after strip.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 2, ssl: "require", prepare: false });
const ddl = readFileSync(MIGRATION, "utf8");

try {
  await sql.unsafe(ddl);
  const reg = await sql`SELECT to_regclass('public.tx_zoning_district_staging') AS reg`;
  console.log(
    JSON.stringify({
      event: "tx-zoning-district-staging.migration-applied",
      tablePresent: reg[0]?.reg != null,
      hostFingerprint: hostFingerprint(poolUrl),
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
