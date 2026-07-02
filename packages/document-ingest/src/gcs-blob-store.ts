/**
 * GcsDocumentBlobStore — the restart-durable `DocumentBlobStore` impl.
 *
 * Blob BYTES live in a tenant-private GCS bucket; the contentHash → cid
 * dedup index + blob metadata live in Postgres (`PgBlobIndex`). The CID
 * scheme is identical in spirit to the in-memory store: the cid is
 * derived deterministically from the content hash (`bafydoc-<hash>`), so
 * re-pinning the same content resolves to the same cid — and because the
 * dedup index is in Postgres, that idempotency survives process restarts.
 *
 * The source BLOB is ALWAYS tenant-private (the licensed/private document
 * stays gated regardless of the extracted-atom policy).
 *
 * Failure posture (commitment #1 support):
 *   - `pinBlob` lets a GCS upload fault surface as a thrown error. The
 *     orchestrator already guards its pin step and degrades honestly.
 *   - `fetchBlob` returns null on a missing object (404) and NEVER throws
 *     on not-found; other faults still surface.
 */

import { Storage } from "@google-cloud/storage";

import type { BlobPinResult, DocumentBlobStore } from "./port.js";
import type { PgBlobIndex } from "./pg-blob-index.js";

/** The cid prefix — kept identical to the in-memory store for parity. */
const CID_PREFIX = "bafydoc-";

export interface GcsDocumentBlobStoreOptions {
  /** Target bucket name (from env DOC_INGEST_BLOB_BUCKET). */
  bucket: string;
  /** The Postgres content-addressing index (dedup + metadata). */
  index: PgBlobIndex;
  /** GCS client. Defaults to a new Storage() using ADC. */
  storage?: Storage;
}

export class GcsDocumentBlobStore implements DocumentBlobStore {
  private readonly bucket: string;
  private readonly index: PgBlobIndex;
  private readonly storage: Storage;

  constructor(opts: GcsDocumentBlobStoreOptions) {
    if (!opts.bucket) {
      throw new Error("GcsDocumentBlobStore requires a bucket name");
    }
    this.bucket = opts.bucket;
    this.index = opts.index;
    this.storage = opts.storage ?? new Storage();
  }

  async pinBlob(input: {
    contentHash: string;
    body: string;
    contentType: string;
    size: number;
  }): Promise<BlobPinResult> {
    // 1. Restart-durable dedup: an existing (contentHash → cid) row means
    //    the blob is already pinned — return it, created: false.
    const existing = await this.index.lookupCidByContentHash(input.contentHash);
    if (existing) {
      return { cid: existing, created: false };
    }

    // 2. New content. Deterministic cid = the GCS object key.
    const cid = `${CID_PREFIX}${input.contentHash}`;
    const file = this.storage.bucket(this.bucket).file(cid);

    // Upload the body as-is (canonicalized to utf8, matching the in-memory
    // store). A GCS fault throws here → the orchestrator's pin guard degrades.
    await file.save(input.body, {
      contentType: input.contentType,
      resumable: false,
    });

    // 3. Record the content-addressing index row (always tenant-private).
    //    On a concurrent-pin race the ON CONFLICT DO NOTHING keeps the first
    //    row; the cid is deterministic so both callers agree on it anyway.
    await this.index.recordBlob({
      cid,
      contentHash: input.contentHash,
      contentType: input.contentType,
      size: input.size,
      // The pin input carries no tenant; the blob record's meaningful
      // gate is access_policy = 'tenant-private' (set in recordBlob).
      tenant: "",
    });

    return { cid, created: true };
  }

  async fetchBlob(cid: string): Promise<string | null> {
    const file = this.storage.bucket(this.bucket).file(cid);
    try {
      const [contents] = await file.download();
      return contents.toString("utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

/** A GCS not-found error carries `code === 404`. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 404
  );
}
