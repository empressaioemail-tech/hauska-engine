/**
 * The document-ingest orchestrator — the `document-ingest` stream entry.
 *
 * Given a document (uploaded bytes or a pinned-blob reference) plus
 * context (node/apn/engagement/jurisdiction + tenant + accessPolicy),
 * it:
 *   1. Pins the blob content-addressed (idempotent on content hash).
 *   2. Classifies the document type.
 *   3. Runs the winning adapter to extract typed domain atoms.
 *   4. Every minted atom is stamped with provenance + an ASSERTED-baseline
 *      widthed confidence (never calibrated) + the parameterized
 *      accessPolicy (the marketplace firewall).
 *   5. Persists atoms idempotently (same document re-ingested → same blob
 *      CID, same atom ids → no duplicates).
 *   6. NEVER throws on a malformed/unreadable document — returns an honest
 *      degraded result (blob pinned, extraction degraded with reason).
 *
 * accessPolicy defaults to `tenant-private` and is NEVER auto-published.
 * A caller ingesting a public/licensed document for the marketplace may
 * pass `public-paid` explicitly; a user's private dataroom upload stays
 * `tenant-private`.
 */

import { sha256Hex } from "@hauska-engine/storage";
import {
  buildAtomDid,
  type AccessPolicy,
  type DocumentContextRefs,
  type DocumentDerivedAtomInstance,
  type DocumentVerificationStatus,
} from "@hauska-engine/atoms";

import { classifyDocument } from "./classify.js";
import type { DocumentIngestStore } from "./port.js";
import type {
  DocumentAdapter,
  ExtractionContext,
  PinnedDocument,
} from "./types.js";

/** The document to ingest — either inline bytes or a pinned-blob reference. */
export type DocumentInput =
  | {
      kind: "inline";
      /** Blob body. */
      body: string;
      /** Encoding of `body`. */
      encoding: "base64" | "utf8";
      /** MIME type. */
      contentType: string;
      /** Original filename / URL for provenance + classification. */
      sourceRef?: string;
    }
  | {
      kind: "blob-ref";
      /** CID of an already-pinned blob in the store. */
      cid: string;
      /** MIME type (for classification). */
      contentType: string;
      sourceRef?: string;
    };

export interface IngestRequest {
  document: DocumentInput;
  /** Tenant partition the ingest runs under. */
  tenant: string;
  /**
   * accessPolicy to stamp on EXTRACTED atoms. The marketplace firewall:
   * defaults to `tenant-private`; the caller passes `public-paid` ONLY
   * when WE ingest a public/licensed document for the marketplace. A
   * user's private-doc upload never auto-publishes.
   */
  accessPolicy?: AccessPolicy;
  /** Verification status to stamp (default `extracted-unverified`). */
  verificationStatus?: DocumentVerificationStatus;
  /** Optional node/parcel/engagement/jurisdiction anchor. */
  contextRefs?: DocumentContextRefs;
  /** Override the extraction timestamp (tests). Default now. */
  extractedAt?: string;
}

export interface MintedAtomSummary {
  atomDid: string;
  entityType: string;
  entityId: string;
  accessPolicy: AccessPolicy;
  storageRelation: "point-to" | "embed-with";
  confidence: DocumentDerivedAtomInstance["confidence"];
  verificationStatus: DocumentVerificationStatus;
  sourceDocumentCid: string;
  /** Whether this write created a new atom (`false` = idempotent no-op). */
  created: boolean;
}

export interface IngestResult {
  status: "ok" | "empty" | "degraded";
  /** The pinned source blob (always present — the blob is pinned even on degrade). */
  sourceDocument: {
    cid: string;
    contentHash: string;
    contentType: string;
    /** accessPolicy of the SOURCE BLOB — always `tenant-private` (the licensed doc stays gated). */
    accessPolicy: "tenant-private";
    pinned: boolean;
  };
  /** The classified document type + which adapter handled it. */
  classification: { documentType: string; adapter: string; score: number };
  /** Minted atoms (ids, types, provenance, confidence, accessPolicy). */
  atoms: ReadonlyArray<MintedAtomSummary>;
  /** Reason when degraded / empty. */
  reason?: string;
}

const DEFAULT_ACCESS_POLICY: AccessPolicy = "tenant-private";

export interface DocumentIngestServiceOptions {
  store: DocumentIngestStore;
  /** Registered adapters, typed adapters first, generic fallback last. */
  adapters: ReadonlyArray<DocumentAdapter>;
  embedMaxChars?: number;
}

export class DocumentIngestService {
  private readonly store: DocumentIngestStore;
  private readonly adapters: ReadonlyArray<DocumentAdapter>;
  private readonly embedMaxChars?: number;

  constructor(opts: DocumentIngestServiceOptions) {
    if (opts.adapters.length === 0) {
      throw new Error("DocumentIngestService requires at least one adapter");
    }
    this.store = opts.store;
    this.adapters = opts.adapters;
    this.embedMaxChars = opts.embedMaxChars;
  }

  /**
   * Ingest a document. Commitment #1: this method never throws on a
   * malformed/unreadable document — it returns a degraded result.
   */
  async ingest(req: IngestRequest): Promise<IngestResult> {
    const accessPolicy = req.accessPolicy ?? DEFAULT_ACCESS_POLICY;
    const verificationStatus =
      req.verificationStatus ?? "extracted-unverified";
    const extractedAt = req.extractedAt ?? new Date().toISOString();

    // 1. Pin the blob (content-addressed, idempotent). The SOURCE BLOB is
    //    always tenant-private — the licensed/private document stays gated
    //    regardless of the extracted-atom policy.
    let pinned: PinnedDocument;
    try {
      pinned = await this.resolveAndPin(req.document);
    } catch (err) {
      // Even pin failure must not throw out of ingest. Return degraded with
      // an empty source (nothing was pinned).
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: "degraded",
        sourceDocument: {
          cid: "",
          contentHash: "",
          contentType:
            req.document.kind === "inline"
              ? req.document.contentType
              : req.document.contentType,
          accessPolicy: "tenant-private",
          pinned: false,
        },
        classification: { documentType: "unknown", adapter: "none", score: 0 },
        atoms: [],
        reason: `blob pin failed: ${reason}`,
      };
    }

    // 2. Classify.
    const classification = classifyDocument(pinned, this.adapters);
    if (!classification) {
      return {
        status: "degraded",
        sourceDocument: this.sourceSummary(pinned),
        classification: { documentType: "unknown", adapter: "none", score: 0 },
        atoms: [],
        reason: "no adapter available to classify document",
      };
    }

    const ctx: ExtractionContext = {
      tenant: req.tenant,
      accessPolicy,
      extractedAt,
      verificationStatus,
      ...(req.contextRefs ? { contextRefs: req.contextRefs } : {}),
      ...(this.embedMaxChars != null ? { embedMaxChars: this.embedMaxChars } : {}),
    };

    // 3. Extract. Adapters are contracted not to throw, but we still guard.
    let extraction;
    try {
      extraction = await classification.adapter.extract(pinned, ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: "degraded",
        sourceDocument: this.sourceSummary(pinned),
        classification: {
          documentType: classification.adapter.documentType,
          adapter: classification.adapter.name,
          score: classification.score,
        },
        atoms: [],
        reason: `extraction threw (guarded): ${reason}`,
      };
    }

    // 4 + 5. Persist minted atoms idempotently. Guarded so a store fault
    //        (e.g. a real Postgres write throwing) degrades honestly and
    //        the orchestrator honors its own never-throws contract rather
    //        than propagating out — the blob is already pinned.
    const summaries: MintedAtomSummary[] = [];
    try {
      for (const atom of extraction.atoms) {
        const write = await this.store.writeDocumentAtom(atom);
        summaries.push({
          atomDid: write.atomDid,
          entityType: atom.entityType,
          entityId: atom.entityId,
          accessPolicy: atom.accessPolicy,
          storageRelation: atom.storageRelation,
          confidence: atom.confidence,
          verificationStatus: atom.verificationStatus,
          sourceDocumentCid: atom.sourceDocumentCid,
          created: write.created,
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: "degraded",
        sourceDocument: this.sourceSummary(pinned),
        classification: {
          documentType: extraction.documentType,
          adapter: classification.adapter.name,
          score: classification.score,
        },
        atoms: summaries,
        reason: `atom persistence degraded after ${summaries.length} of ${extraction.atoms.length}: ${reason}`,
      };
    }

    const result: IngestResult = {
      status: extraction.status,
      sourceDocument: this.sourceSummary(pinned),
      classification: {
        documentType: extraction.documentType,
        adapter: classification.adapter.name,
        score: classification.score,
      },
      atoms: summaries,
    };
    if (extraction.reason) result.reason = extraction.reason;
    return result;
  }

  private async resolveAndPin(input: DocumentInput): Promise<PinnedDocument> {
    if (input.kind === "blob-ref") {
      const body = await this.store.fetchBlob(input.cid);
      if (body == null) {
        throw new Error(`blob-ref cid not found: ${input.cid}`);
      }
      // Recompute hash from stored body so provenance stays consistent.
      const contentHash = sha256Hex(body);
      return {
        cid: input.cid,
        contentHash,
        contentType: input.contentType,
        body,
        // Stored blobs are canonicalized to utf8 in this store.
        encoding: "utf8",
        size: body.length,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      };
    }
    const contentHash = sha256Hex(input.body);
    const pin = await this.store.pinBlob({
      contentHash,
      body: input.body,
      contentType: input.contentType,
      size: input.body.length,
    });
    return {
      cid: pin.cid,
      contentHash,
      contentType: input.contentType,
      body: input.body,
      encoding: input.encoding,
      size: input.body.length,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    };
  }

  private sourceSummary(pinned: PinnedDocument): IngestResult["sourceDocument"] {
    return {
      cid: pinned.cid,
      contentHash: pinned.contentHash,
      contentType: pinned.contentType,
      accessPolicy: "tenant-private",
      pinned: true,
    };
  }
}

/** Build a DID for a minted atom summary (helper for consumers). */
export function atomDidFor(atom: {
  entityType: string;
  entityId: string;
}): string {
  return buildAtomDid(atom.entityType, atom.entityId).raw;
}
