/**
 * @hauska-engine/document-ingest
 *
 * Unstructured-to-atom document ingestion: pin a real-world document as a
 * content-addressed blob, classify it, and extract provenanced,
 * confidence-carrying point-to atoms. The foundation for datarooms and
 * the data marketplace.
 *
 * Design (point-to default; embed-with for small born-digital fragments;
 * asserted-baseline widthed confidence; parameterized accessPolicy
 * firewall) per `_research/2026-07-02_ai_native_and_twin_review.md` §2.
 */

import { GenericPdfAdapter, type GenericPdfAdapterOptions } from "./adapters/generic-pdf.js";
import { SurveyAdapter, type SurveyAdapterOptions } from "./adapters/survey.js";
import {
  UtilityBillAdapter,
  type UtilityBillAdapterOptions,
} from "./adapters/utility-bill.js";
import type { DocumentAdapter } from "./types.js";

// Re-export the storage-relation decision rule from the atoms package so
// consumers of document-ingest get it without a second import.
export {
  storageRelationForExtraction,
  type StorageRelation,
  type StorageRelationDecisionInput,
  type AccessPolicy,
  type DocumentDerivedAtomInstance,
  type DocumentDerivedAtomEntityType,
  isDocumentDerivedEntityType,
  DOCUMENT_DERIVED_ATOM_ENTITY_TYPES,
} from "@hauska-engine/atoms";

export * from "./types.js";
export * from "./port.js";
export * from "./in-memory-storage.js";
export * from "./pg-atom-store.js";
export * from "./pg-blob-index.js";
export * from "./gcs-blob-store.js";
export * from "./durable-store.js";
export * from "./confidence.js";
export * from "./classify.js";
export * from "./mint.js";
export * from "./ingest.js";
export * from "./adapters/generic-pdf.js";
export * from "./adapters/survey.js";
export * from "./adapters/utility-bill.js";

export interface DefaultAdapterSetOptions {
  generic?: GenericPdfAdapterOptions;
  survey?: SurveyAdapterOptions;
  utilityBill?: UtilityBillAdapterOptions;
}

/**
 * The standard adapter set: typed adapters first (survey, utility-bill),
 * generic PDF/text fallback last. Classification routes to the highest
 * scorer, so the generic adapter (low floor score) only wins when no
 * typed adapter recognizes the document — ingestion never hard-fails.
 */
export function defaultDocumentAdapters(
  opts: DefaultAdapterSetOptions = {},
): ReadonlyArray<DocumentAdapter> {
  return [
    new SurveyAdapter(opts.survey ?? {}),
    new UtilityBillAdapter(opts.utilityBill ?? {}),
    new GenericPdfAdapter(opts.generic ?? {}),
  ];
}
