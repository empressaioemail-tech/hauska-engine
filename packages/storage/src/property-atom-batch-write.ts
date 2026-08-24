/**
 * Property-atom batch upsert helpers.
 *
 * `writePropertyAtomsBatchLegacy` preserves the pre-W1 32-concurrent single-row
 * path as an oracle for differential identity tests. Production uses
 * `upsertPropertyAtomRowsMulti`.
 */

import { buildAtomDid, type PropertyAtomInstance } from "@hauska-engine/atoms";
import type postgres from "postgres";

import type { IpfsPort } from "./ipfs-port.js";
import { resolveAccessPolicyOrRefuse } from "./access-policy-write.js";

/** Postgres bind-parameter ceiling ÷ 13 columns per row. */
export const PROPERTY_ATOM_ROW_PARAM_COUNT = 13;
export const PROPERTY_ATOM_UPSERT_PARAM_CEILING = 65_535;
export const PROPERTY_ATOM_UPSERT_MAX_ROWS = Math.floor(
  PROPERTY_ATOM_UPSERT_PARAM_CEILING / PROPERTY_ATOM_ROW_PARAM_COUNT,
);

/** Default multi-row INSERT chunk size (override via env for benchmarks). */
export function resolvePropertyAtomUpsertBatchSize(): number {
  const raw = process.env.PROPERTY_ATOM_UPSERT_BATCH_SIZE;
  if (raw == null || raw === "") return 5_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 5_000;
  return Math.min(n, PROPERTY_ATOM_UPSERT_MAX_ROWS);
}

export interface PreparedPropertyAtomRow {
  atom_did: string;
  cid: string;
  content_hash: string;
  entity_type: string;
  entity_id: string;
  jurisdiction_tenant: string;
  section_number: null;
  subsection_path: null;
  source_adapter: string;
  source_url: string;
  fetched_at: string;
  body: PropertyAtomInstance;
  access_policy: string;
}

export function resolvePropertyAtomDid(instance: PropertyAtomInstance): string {
  return typeof instance.atomDid === "string" &&
    instance.atomDid.startsWith("did:hauska:")
    ? instance.atomDid
    : buildAtomDid(instance.entityType, instance.entityId).raw;
}

/** Last occurrence wins — matches concurrent single-row upsert race semantics. */
export function dedupePreparedRowsLastWins(
  rows: PreparedPropertyAtomRow[],
): PreparedPropertyAtomRow[] {
  const byDid = new Map<string, PreparedPropertyAtomRow>();
  for (const row of rows) {
    byDid.set(row.atom_did, row);
  }
  return [...byDid.values()];
}

export async function preparePropertyAtomRows(
  instances: ReadonlyArray<PropertyAtomInstance>,
  ipfs: IpfsPort,
  options?: { dedupe?: boolean },
): Promise<{
  rows: PreparedPropertyAtomRow[];
  out: Array<{ atomDid: string; cid: string }>;
}> {
  const rows: PreparedPropertyAtomRow[] = [];
  const out: Array<{ atomDid: string; cid: string }> = [];

  for (const instance of instances) {
    const atomDid = resolvePropertyAtomDid(instance);
    const pin = await ipfs.pin(instance.contentHash, "");
    rows.push({
      atom_did: atomDid,
      cid: pin.cid,
      content_hash: instance.contentHash,
      entity_type: instance.entityType,
      entity_id: instance.entityId,
      jurisdiction_tenant: instance.jurisdictionTenant,
      section_number: null,
      subsection_path: null,
      source_adapter: instance.sourceAdapter,
      source_url: instance.sourceUrl,
      fetched_at: instance.fetchedAt,
      body: instance,
      access_policy: resolveAccessPolicyOrRefuse(instance),
    });
    out.push({ atomDid, cid: pin.cid });
  }

  const dedupe = options?.dedupe ?? true;
  return {
    rows: dedupe ? dedupePreparedRowsLastWins(rows) : rows,
    out,
  };
}

/**
 * ON CONFLICT clause for property-atom batch upserts.
 * Column list MUST match legacy `writePropertyAtomsBatch` exactly.
 */
export const PROPERTY_ATOM_BATCH_ON_CONFLICT = `
ON CONFLICT (atom_did) DO UPDATE SET
  cid = EXCLUDED.cid,
  content_hash = EXCLUDED.content_hash,
  entity_type = EXCLUDED.entity_type,
  entity_id = EXCLUDED.entity_id,
  jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
  source_adapter = EXCLUDED.source_adapter,
  source_url = EXCLUDED.source_url,
  fetched_at = EXCLUDED.fetched_at,
  body = EXCLUDED.body,
  access_policy = EXCLUDED.access_policy,
  updated_at = now()` as const;

const INSERT_COLUMNS = [
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
  "body",
  "access_policy",
] as const;

/** Production path: one multi-row INSERT per chunk. */
export async function upsertPropertyAtomRowsMulti(
  sql: postgres.Sql,
  rows: ReadonlyArray<PreparedPropertyAtomRow>,
  batchSize = resolvePropertyAtomUpsertBatchSize(),
): Promise<void> {
  if (rows.length === 0) return;
  const chunk = Math.min(batchSize, PROPERTY_ATOM_UPSERT_MAX_ROWS);
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const insertRows = slice.map((row) => ({
      atom_did: row.atom_did,
      cid: row.cid,
      content_hash: row.content_hash,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      jurisdiction_tenant: row.jurisdiction_tenant,
      section_number: row.section_number,
      subsection_path: row.subsection_path,
      source_adapter: row.source_adapter,
      source_url: row.source_url,
      fetched_at: row.fetched_at,
      body: sql.json(row.body as unknown as Parameters<typeof sql.json>[0]),
      access_policy: row.access_policy,
    }));
    await sql`
      INSERT INTO atoms ${sql(insertRows, ...INSERT_COLUMNS)}
      ON CONFLICT (atom_did) DO UPDATE SET
        cid = EXCLUDED.cid,
        content_hash = EXCLUDED.content_hash,
        entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
        source_adapter = EXCLUDED.source_adapter,
        source_url = EXCLUDED.source_url,
        fetched_at = EXCLUDED.fetched_at,
        body = EXCLUDED.body,
        access_policy = EXCLUDED.access_policy,
        updated_at = now()
    `;
  }
}

/** Oracle: 32 concurrent single-row INSERTs (pre-W1 throughput baseline). */
export async function writePropertyAtomsBatchLegacy(
  sql: postgres.Sql,
  ipfs: IpfsPort,
  instances: ReadonlyArray<PropertyAtomInstance>,
): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
  if (instances.length === 0) return [];
  const { rows: prepared, out } = await preparePropertyAtomRows(instances, ipfs, {
    dedupe: false,
  });

  const CONCURRENCY = 32;
  for (let i = 0; i < prepared.length; i += CONCURRENCY) {
    const slice = prepared.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(
        (row) => sql`
          INSERT INTO atoms (
            atom_did,
            cid,
            content_hash,
            entity_type,
            entity_id,
            jurisdiction_tenant,
            section_number,
            subsection_path,
            source_adapter,
            source_url,
            fetched_at,
            body,
            access_policy
          ) VALUES (
            ${row.atom_did},
            ${row.cid},
            ${row.content_hash},
            ${row.entity_type},
            ${row.entity_id},
            ${row.jurisdiction_tenant},
            ${null},
            ${null},
            ${row.source_adapter},
            ${row.source_url},
            ${row.fetched_at},
            ${sql.json(row.body as unknown as Parameters<typeof sql.json>[0])},
            ${row.access_policy}
          )
          ON CONFLICT (atom_did) DO UPDATE SET
            cid = EXCLUDED.cid,
            content_hash = EXCLUDED.content_hash,
            entity_type = EXCLUDED.entity_type,
            entity_id = EXCLUDED.entity_id,
            jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
            source_adapter = EXCLUDED.source_adapter,
            source_url = EXCLUDED.source_url,
            fetched_at = EXCLUDED.fetched_at,
            body = EXCLUDED.body,
            access_policy = EXCLUDED.access_policy,
            updated_at = now()
        `,
      ),
    );
  }
  return out;
}
