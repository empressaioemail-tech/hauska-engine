/**
 * In-memory DocumentIngestStore for tests and engine-api dev mode.
 *
 * Blob CIDs are derived deterministically from the content hash
 * (`bafydoc-${hash}`) so re-pinning the same content resolves to the same
 * CID (idempotency). Atoms are keyed by DID; a repeat write of the same
 * DID is a no-op (`created: false`).
 */

import {
  buildAtomDid,
  type DocumentDerivedAtomInstance,
} from "@hauska-engine/atoms";

import type {
  BlobPinResult,
  DocumentIngestStore,
} from "./port.js";

export class InMemoryDocumentIngestStore implements DocumentIngestStore {
  private readonly blobs = new Map<string, string>(); // cid -> body
  private readonly blobByHash = new Map<string, string>(); // contentHash -> cid
  private readonly atoms = new Map<string, DocumentDerivedAtomInstance>(); // did -> atom

  async pinBlob(input: {
    contentHash: string;
    body: string;
    contentType: string;
    size: number;
  }): Promise<BlobPinResult> {
    const existing = this.blobByHash.get(input.contentHash);
    if (existing) {
      return { cid: existing, created: false };
    }
    const cid = `bafydoc-${input.contentHash}`;
    this.blobs.set(cid, input.body);
    this.blobByHash.set(input.contentHash, cid);
    return { cid, created: true };
  }

  async fetchBlob(cid: string): Promise<string | null> {
    return this.blobs.get(cid) ?? null;
  }

  async writeDocumentAtom(
    instance: DocumentDerivedAtomInstance,
  ): Promise<{ atomDid: string; created: boolean }> {
    const atomDid = buildAtomDid(instance.entityType, instance.entityId).raw;
    if (this.atoms.has(atomDid)) {
      return { atomDid, created: false };
    }
    this.atoms.set(atomDid, instance);
    return { atomDid, created: true };
  }

  async getDocumentAtomByDid(
    atomDid: string,
  ): Promise<DocumentDerivedAtomInstance | null> {
    return this.atoms.get(atomDid) ?? null;
  }

  async listAtomsBySourceDocumentCid(
    sourceDocumentCid: string,
  ): Promise<ReadonlyArray<DocumentDerivedAtomInstance>> {
    const out: DocumentDerivedAtomInstance[] = [];
    for (const atom of this.atoms.values()) {
      if (atom.sourceDocumentCid === sourceDocumentCid) out.push(atom);
    }
    return out;
  }
}
