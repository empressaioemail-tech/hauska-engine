/**
 * DurableDocumentIngestStore — the persistent DocumentIngestStore.
 *
 * Composes a GCS-backed blob store (bytes in GCS, dedup index in Postgres)
 * with a Postgres-backed atom store, delegating each port method. It is the
 * durable impl of the SAME `DocumentIngestStore` port PR #78 shipped
 * in-process — not a parallel store.
 *
 * `resolveDocumentIngestStore(env)` is the honest dev/prod fallback: when
 * both a Postgres URL and a blob bucket are configured it opens ONE shared
 * `postgres` handle and returns the durable store; otherwise it returns the
 * in-memory store so dev/test keeps working with no cloud dependency.
 */

import postgres from "postgres";

import { GcsDocumentBlobStore } from "./gcs-blob-store.js";
import { InMemoryDocumentIngestStore } from "./in-memory-storage.js";
import { PgBlobIndex } from "./pg-blob-index.js";
import { PgDocumentAtomStore } from "./pg-atom-store.js";
import type {
  BlobPinResult,
  DocumentBlobStore,
  DocumentAtomStore,
  DocumentIngestStore,
} from "./port.js";
import type { DocumentDerivedAtomInstance } from "@hauska-engine/atoms";

export interface DurableDocumentIngestStoreOptions {
  blob: DocumentBlobStore;
  atoms: DocumentAtomStore;
}

export class DurableDocumentIngestStore implements DocumentIngestStore {
  private readonly blob: DocumentBlobStore;
  private readonly atoms: DocumentAtomStore;

  constructor(opts: DurableDocumentIngestStoreOptions) {
    this.blob = opts.blob;
    this.atoms = opts.atoms;
  }

  pinBlob(input: {
    contentHash: string;
    body: string;
    contentType: string;
    size: number;
  }): Promise<BlobPinResult> {
    return this.blob.pinBlob(input);
  }

  fetchBlob(cid: string): Promise<string | null> {
    return this.blob.fetchBlob(cid);
  }

  writeDocumentAtom(
    instance: DocumentDerivedAtomInstance,
  ): Promise<{ atomDid: string; created: boolean }> {
    return this.atoms.writeDocumentAtom(instance);
  }

  getDocumentAtomByDid(
    atomDid: string,
  ): Promise<DocumentDerivedAtomInstance | null> {
    return this.atoms.getDocumentAtomByDid(atomDid);
  }

  listAtomsBySourceDocumentCid(
    sourceDocumentCid: string,
  ): Promise<ReadonlyArray<DocumentDerivedAtomInstance>> {
    return this.atoms.listAtomsBySourceDocumentCid(sourceDocumentCid);
  }
}

export interface CreateDurableStoreOptions {
  /** Shared Postgres handle (owns connection lifecycle). */
  sql: postgres.Sql;
  /** GCS bucket name for blob bytes. */
  bucket: string;
  /** Optional GCS client override (tests inject a stub). */
  storage?: ConstructorParameters<typeof GcsDocumentBlobStore>[0]["storage"];
}

/**
 * Build a durable store from a shared Postgres handle + a bucket name. The
 * caller owns the `sql` handle lifecycle.
 */
export function createDurableDocumentIngestStore(
  opts: CreateDurableStoreOptions,
): DurableDocumentIngestStore {
  const index = new PgBlobIndex(opts.sql);
  const blob = new GcsDocumentBlobStore({
    bucket: opts.bucket,
    index,
    ...(opts.storage ? { storage: opts.storage } : {}),
  });
  const atoms = new PgDocumentAtomStore(opts.sql);
  return new DurableDocumentIngestStore({ blob, atoms });
}

/** Env keys the resolver reads. */
export interface DocumentIngestEnv {
  DATABASE_URL?: string;
  SUBSTRATE_DATABASE_URL?: string;
  DOC_INGEST_BLOB_BUCKET?: string;
}

export interface ResolvedDocumentIngestStore {
  store: DocumentIngestStore;
  kind: "durable" | "in-memory";
}

/**
 * Report which store kind the environment would resolve to WITHOUT opening
 * a connection or building a store. For health/introspection: a durable
 * store needs both a Postgres URL and a blob bucket configured.
 */
export function documentIngestStoreKind(
  env: DocumentIngestEnv,
): "durable" | "in-memory" {
  const url = env.DATABASE_URL ?? env.SUBSTRATE_DATABASE_URL;
  const bucket = env.DOC_INGEST_BLOB_BUCKET;
  return url && bucket ? "durable" : "in-memory";
}

/**
 * Pick the durable store when a Postgres URL AND a blob bucket are both
 * configured; otherwise fall back to the in-memory store (dev/test). When
 * durable, opens ONE shared `postgres` handle (ssl inferred from the URL).
 *
 * This is the honest fallback: an engine deployed without a DB/bucket runs
 * in-memory rather than pretending to be durable.
 */
export function resolveDocumentIngestStore(
  env: DocumentIngestEnv,
): ResolvedDocumentIngestStore {
  const url = env.DATABASE_URL ?? env.SUBSTRATE_DATABASE_URL;
  const bucket = env.DOC_INGEST_BLOB_BUCKET;

  if (url && bucket) {
    const ssl =
      url.includes("sslmode=require") || url.includes("neon.tech")
        ? ("require" as const)
        : false;
    const sql = postgres(url, { ssl, max: 5 });
    const store = createDurableDocumentIngestStore({ sql, bucket });
    return { store, kind: "durable" };
  }

  return { store: new InMemoryDocumentIngestStore(), kind: "in-memory" };
}
