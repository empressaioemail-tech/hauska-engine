/**
 * PgBlobIndex — the restart-durable contentHash → cid dedup index over the
 * `document_blobs` table.
 *
 * The blob BYTES live in GCS; this table is the content-addressing index +
 * blob metadata. It is what makes pin dedup survive process restarts: a
 * second ingest of the same content hash resolves to the already-recorded
 * cid rather than re-uploading and minting a new one.
 *
 * The source BLOB record is ALWAYS access_policy = 'tenant-private' (the
 * licensed/private document stays gated regardless of extracted-atom policy).
 *
 * The `postgres.Sql` handle is INJECTED — this helper never opens a
 * connection of its own.
 */

import type postgres from "postgres";

export interface BlobIndexRecord {
  cid: string;
  contentHash: string;
  contentType: string;
  size: number;
  tenant: string;
}

interface CidRow {
  cid: string;
}

export class PgBlobIndex {
  constructor(private readonly sql: postgres.Sql) {}

  /** Look up an existing cid by content hash. Null when not yet pinned. */
  async lookupCidByContentHash(contentHash: string): Promise<string | null> {
    const rows = await this.sql<CidRow[]>`
      SELECT cid
      FROM document_blobs
      WHERE content_hash = ${contentHash}
      LIMIT 1
    `;
    return rows[0]?.cid ?? null;
  }

  /**
   * Record a (contentHash → cid) blob-metadata row. Idempotent: on a
   * content_hash conflict the existing row wins (DO NOTHING) and the caller
   * keeps the already-stored cid. The blob record is always tenant-private.
   */
  async recordBlob(record: BlobIndexRecord): Promise<void> {
    await this.sql`
      INSERT INTO document_blobs (
        cid,
        content_hash,
        content_type,
        size,
        tenant,
        access_policy
      ) VALUES (
        ${record.cid},
        ${record.contentHash},
        ${record.contentType},
        ${record.size},
        ${record.tenant},
        'tenant-private'
      )
      ON CONFLICT (content_hash) DO NOTHING
    `;
  }
}
