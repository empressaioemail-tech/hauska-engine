/**
 * Document-ingest storage port — the persistence surface for the source
 * blob and the minted document-derived atoms.
 *
 * Separate from the code-corpus `StoragePort` (which is typed to
 * `CodeAtomInstance`) and the `WorkspaceStoragePort`, exactly as those
 * two are separate from each other. Production wires a Postgres + blob
 * (GCS/IPFS) implementation; the in-memory implementation supports tests
 * and the engine-api dev mode.
 *
 * Idempotency is a port contract: `pinBlob` dedups on content hash, and
 * `writeDocumentAtom` dedups on atom DID (same document re-ingested →
 * same blob CID, same atom ids → no duplicates).
 */

import type { DocumentDerivedAtomInstance } from "@hauska-engine/atoms";

export interface BlobPinResult {
  /** Content-addressed CID of the pinned blob. */
  cid: string;
  /** Whether this pin created a new blob (`false` = already pinned). */
  created: boolean;
}

export interface DocumentBlobStore {
  /**
   * Pin a blob content-addressed. Idempotent: pinning the same content
   * hash twice returns the same CID with `created: false`.
   */
  pinBlob(input: {
    contentHash: string;
    body: string;
    contentType: string;
    size: number;
  }): Promise<BlobPinResult>;

  /** Fetch a pinned blob body by CID. */
  fetchBlob(cid: string): Promise<string | null>;
}

export interface DocumentAtomStore {
  /**
   * Write a minted atom. Idempotent on DID: writing the same DID twice
   * (same document re-ingested) does not duplicate. Returns whether the
   * write created a new atom.
   */
  writeDocumentAtom(
    instance: DocumentDerivedAtomInstance,
  ): Promise<{ atomDid: string; created: boolean }>;

  /** Read a minted atom by DID. */
  getDocumentAtomByDid(
    atomDid: string,
  ): Promise<DocumentDerivedAtomInstance | null>;

  /** List every atom minted from a given source document blob CID. */
  listAtomsBySourceDocumentCid(
    sourceDocumentCid: string,
  ): Promise<ReadonlyArray<DocumentDerivedAtomInstance>>;
}

/** Combined store the orchestrator writes through. */
export interface DocumentIngestStore
  extends DocumentBlobStore,
    DocumentAtomStore {}
