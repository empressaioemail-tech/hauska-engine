/**
 * Document-ingest framework types.
 *
 * A `DocumentAdapter` is the document-side analogue of the corpus
 * `CodeSourceAdapter`: it classifies a document and extracts typed
 * domain atoms from it. Adapters NEVER throw on a malformed document —
 * they return a degraded result carrying a reason (commitment #1: never
 * hard-fail).
 */

import type {
  AccessPolicy,
  DocumentContextRefs,
  DocumentDerivedAtomInstance,
  DocumentVerificationStatus,
} from "@hauska-engine/atoms";

/** A pinned source document ready for extraction. */
export interface PinnedDocument {
  /** Content-addressed CID of the pinned blob (the point-to reference). */
  cid: string;
  /** sha256 hex of the blob content (idempotency key for the document). */
  contentHash: string;
  /** MIME type as declared / sniffed. */
  contentType: string;
  /** Raw blob body (base64 for binary, utf8 for text). */
  body: string;
  /** How `body` is encoded. */
  encoding: "base64" | "utf8";
  /** Byte length of the blob. */
  size: number;
  /** Original filename / URL, when known (for provenance + classification). */
  sourceRef?: string;
}

/**
 * Everything an adapter needs to stamp provenance + confidence +
 * accessPolicy consistently. The orchestrator builds this and passes it
 * to the adapter so every minted atom is stamped identically regardless
 * of which adapter produced it.
 */
export interface ExtractionContext {
  /** Tenant partition the ingest runs under. */
  tenant: string;
  /**
   * accessPolicy to stamp on every minted atom. PARAMETERIZED — resolved
   * by the orchestrator from the caller/source policy (default
   * `tenant-private`). The marketplace firewall.
   */
  accessPolicy: AccessPolicy;
  /** ISO-8601 timestamp of this extraction pass. */
  extractedAt: string;
  /** Verification status to stamp (default `extracted-unverified`). */
  verificationStatus: DocumentVerificationStatus;
  /** Optional node/parcel/engagement/jurisdiction anchor. */
  contextRefs?: DocumentContextRefs;
  /**
   * Max characters for an embed-with fragment. Fragments larger than this
   * fall back to point-to even when they are a unit of meaning.
   */
  embedMaxChars?: number;
}

/** Result of a single adapter extraction pass. */
export interface ExtractionResult {
  /** Atoms extracted. Empty is legal (degraded, or genuinely empty document). */
  atoms: ReadonlyArray<DocumentDerivedAtomInstance>;
  /**
   * Extraction outcome:
   *   - `ok`       — extraction ran and produced atoms.
   *   - `empty`    — extraction ran cleanly but found nothing to mint.
   *   - `degraded` — extraction could not fully read the document; blob is
   *                  pinned, `reason` explains. NEVER an exception.
   */
  status: "ok" | "empty" | "degraded";
  /** Human-readable reason when `status` is `degraded` or `empty`. */
  reason?: string;
  /** The classified document type this adapter handled. */
  documentType: string;
}

/**
 * A document adapter. Each adapter declares which document types it
 * classifies and implements a non-throwing `extract`.
 */
export interface DocumentAdapter {
  /** Stable adapter name, stamped as `sourceAdapter` on minted atoms. */
  readonly name: string;
  /** Human display name. */
  readonly displayName: string;
  /**
   * The document type this adapter mints (e.g. `survey`, `utility-bill`,
   * `generic-pdf`). Stamped on `document-derived-claim.documentType`.
   */
  readonly documentType: string;
  /**
   * Classification score in [0, 1] for a candidate document: how confident
   * this adapter is that it should handle it. The classifier routes to the
   * highest scorer. The generic adapter returns a low non-zero floor so it
   * is always a fallback but never beats a confident typed adapter.
   */
  classify(doc: PinnedDocument): number;
  /**
   * Extract typed atoms from a pinned document. MUST NOT throw — on a
   * malformed / unreadable document, return `status: "degraded"` with a
   * reason and an empty (or partial) atom array.
   */
  extract(
    doc: PinnedDocument,
    ctx: ExtractionContext,
  ): Promise<ExtractionResult>;
}
