/**
 * Atom minting helpers shared by every document adapter.
 *
 * `mintDocumentDerivedFields` stamps the point-to reference
 * (`sourceDocumentCid`), extraction provenance, the storage relation
 * (point-to vs embed-with), the asserted widthed confidence, and the
 * parameterized accessPolicy — identically for every adapter, so a
 * survey-record atom and a generic claim atom carry the same firewall +
 * provenance guarantees.
 */

import {
  storageRelationForExtraction,
  type DocumentDerivedFields,
  type BaseAtomInstance,
} from "@hauska-engine/atoms";
import { sha256Hex } from "@hauska-engine/storage";

import { seedAssertedConfidence } from "./confidence.js";
import type { ExtractionContext, PinnedDocument } from "./types.js";

export interface MintInput {
  /** The classified/derived atom body used to compute the atom contentHash. */
  canonicalBody: Record<string, unknown>;
  /** Source-quality tag for confidence seeding (`born-digital-pdf`, `scan`, ...). */
  sourceQuality: string;
  /** Per-claim extraction confidence in [0, 1] (OCR / parse confidence). */
  extractionConfidence?: number;
  /**
   * Extracted text, when this atom's content is a text fragment. Drives
   * the embed-with vs point-to decision.
   */
  text?: string;
  /** True when `text` IS the atom's unit of meaning (clause / definition). */
  isUnitOfMeaning?: boolean;
  /** Where in the document this was extracted from. */
  extractionRegion?: DocumentDerivedFields["extractionRegion"];
}

/**
 * Build the `BaseAtomInstance` + `DocumentDerivedFields` an adapter
 * spreads onto its typed atom. The adapter supplies `entityId`,
 * `entityType`, and its typed fields; this fills everything shared.
 */
export function mintDocumentDerivedFields(
  doc: PinnedDocument,
  ctx: ExtractionContext,
  sourceAdapter: string,
  input: MintInput,
): BaseAtomInstance & DocumentDerivedFields {
  const storageRelation = storageRelationForExtraction({
    text: input.text,
    isUnitOfMeaning: input.isUnitOfMeaning,
    embedMaxChars: ctx.embedMaxChars,
  });

  const base: Omit<BaseAtomInstance, "entityType"> = {
    entityId: "", // adapter overrides with its stable id
    jurisdictionTenant: ctx.tenant,
    fetchedAt: ctx.extractedAt,
    sourceAdapter,
    sourceUrl: doc.sourceRef ?? "",
    // Atom-level content hash: identifies THIS atom's body (dedup within a
    // document). Distinct from sourceDocumentCid (the pointed-to blob).
    contentHash: sha256Hex(canonicalize(input.canonicalBody)),
  };

  const derived: DocumentDerivedFields = {
    sourceDocumentCid: doc.cid,
    storageRelation,
    extractedAt: ctx.extractedAt,
    verificationStatus: ctx.verificationStatus,
    confidence: seedAssertedConfidence({
      sourceQuality: input.sourceQuality,
      extractionConfidence: input.extractionConfidence,
    }),
    accessPolicy: ctx.accessPolicy,
    ...(input.extractionRegion ? { extractionRegion: input.extractionRegion } : {}),
    // Only embed-with atoms carry inline text; point-to atoms do not.
    ...(storageRelation === "embed-with" && input.text
      ? { extractedText: input.text }
      : {}),
  };

  return { entityType: "", ...base, ...derived } as BaseAtomInstance &
    DocumentDerivedFields;
}

/** Deterministic canonical JSON for content hashing (stable key order). */
export function canonicalize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Build a stable, deterministic entityId for a minted atom so that
 * re-ingesting the same document mints the same atom ids (idempotency).
 * Keyed on the source blob CID + the atom's own content hash + an index.
 */
export function stableEntityId(
  sourceDocumentCid: string,
  atomContentHash: string,
): string {
  return sha256Hex(`${sourceDocumentCid}:${atomContentHash}`).slice(0, 32);
}
