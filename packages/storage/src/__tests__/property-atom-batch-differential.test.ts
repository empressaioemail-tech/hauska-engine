/**
 * Differential identity test: legacy 32-row concurrent path vs multi-row INSERT.
 *
 * Requires DATABASE_URL (direct host, not pooler). Creates throwaway schemas and
 * drops them on exit. Skips when unset.
 */

import { describe, expect, it } from "vitest";
import postgres from "postgres";

import { InProcessIpfsPin } from "../in-process-cache.js";
import {
  upsertPropertyAtomRowsMulti,
  writePropertyAtomsBatchLegacy,
  preparePropertyAtomRows,
} from "../property-atom-batch-write.js";
import { resolveSubstrateDatabaseUrl } from "../pg-storage.js";

const COMPARE_COLUMNS = [
  "atom_did",
  "cid",
  "content_hash",
  "entity_type",
  "entity_id",
  "jurisdiction_tenant",
  "section_number",
  "subsection_path",
  "source_adapter",
  "source_url",
  "fetched_at",
  "access_policy",
] as const;

interface AtomRow {
  atom_did: string;
  cid: string;
  content_hash: string;
  entity_type: string;
  entity_id: string;
  jurisdiction_tenant: string;
  section_number: string | null;
  subsection_path: string | null;
  source_adapter: string;
  source_url: string;
  fetched_at: Date | string;
  body: unknown;
  access_policy: string;
}

function directDatabaseUrl(raw: string): string {
  return raw.replace("-pooler.", ".");
}

function resolveHost(url: string): string {
  const m = url.match(/@([^/]+)\//);
  return m?.[1] ?? "unknown";
}

async function ensureSchema(sql: postgres.Sql, schema: string): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${schema}.atoms`);
  await sql.unsafe(`
    CREATE TABLE ${schema}.atoms (LIKE public.atoms INCLUDING ALL)
  `);
}

async function fetchRows(sql: postgres.Sql, schema: string): Promise<AtomRow[]> {
  return sql.unsafe(`
    SELECT
      atom_did, cid, content_hash, entity_type, entity_id, jurisdiction_tenant,
      section_number, subsection_path, source_adapter, source_url, fetched_at,
      body, access_policy
    FROM ${schema}.atoms
    ORDER BY atom_did ASC
  `) as Promise<AtomRow[]>;
}

function rowFingerprint(row: AtomRow): string {
  const cols = COMPARE_COLUMNS.map((c) => {
    const v = row[c];
    return v instanceof Date ? v.toISOString() : String(v ?? "");
  });
  const bodyText = JSON.stringify(row.body);
  return `${cols.join("|")}|${bodyText}`;
}

async function loadLiveFixtures(sql: postgres.Sql, limit: number) {
  const rows = await sql`
    SELECT body
    FROM public.atoms
    WHERE entity_type = 'parcel-node'
      AND body->>'countyFips' = '48021'
    ORDER BY atom_did ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.body);
}

describe("property-atom batch write differential (live Postgres)", () => {
  const url = resolveSubstrateDatabaseUrl();

  it.skipIf(!url)("legacy vs multi-row produce identical stored rows", async () => {
    const directUrl = directDatabaseUrl(url as string);
    const host = resolveHost(directUrl);
    expect(host.includes("-pooler")).toBe(false);

    const legacySchema = "w1_diff_legacy";
    const newSchema = "w1_diff_new";
    const sql = postgres(directUrl, { ssl: "require", max: 1 });
    const ipfs = new InProcessIpfsPin();
    const fixtures = await loadLiveFixtures(sql, 120);
    expect(fixtures.length).toBeGreaterThan(10);

    try {
      await ensureSchema(sql, legacySchema);
      await ensureSchema(sql, newSchema);

      await sql.unsafe(`SET search_path TO ${legacySchema}, public`);
      await writePropertyAtomsBatchLegacy(sql, ipfs, fixtures);

      await sql.unsafe(`SET search_path TO ${newSchema}, public`);
      const { rows } = await preparePropertyAtomRows(fixtures, ipfs);
      await upsertPropertyAtomRowsMulti(sql, rows, 500);

      const legacyRows = await fetchRows(sql, legacySchema);
      const newRows = await fetchRows(sql, newSchema);

      expect(newRows.length).toBe(legacyRows.length);
      expect(newRows.length).toBe(fixtures.length);

      for (let i = 0; i < legacyRows.length; i++) {
        expect(rowFingerprint(newRows[i]!)).toBe(rowFingerprint(legacyRows[i]!));
      }

      const countBefore = newRows.length;
      await upsertPropertyAtomRowsMulti(sql, rows, 500);
      const afterRerun = await fetchRows(sql, newSchema);
      expect(afterRerun.length).toBe(countBefore);
      for (let i = 0; i < countBefore; i++) {
        expect(rowFingerprint(afterRerun[i]!)).toBe(rowFingerprint(newRows[i]!));
      }
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${newSchema} CASCADE`);
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
