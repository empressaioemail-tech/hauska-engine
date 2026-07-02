/**
 * Document-derived atom instances — the unstructured-to-atom substrate.
 *
 * These are the atoms minted by the `document-ingest` stream when an
 * arbitrary real-world document (survey, plat, utility bill, title
 * commitment, geotech report, spreadsheet, scan) is ingested. They are
 * the foundation for datarooms and the data marketplace.
 *
 * Design (per `_research/2026-07-02_ai_native_and_twin_review.md` §2 and
 * `_inbox/2026-07-02_deepreview_ai_native_DR1.md` §3):
 *
 *   POINT-TO (default). A minted atom is a CLAIM extracted FROM a
 *   document that remains the source of truth. The raw document is
 *   pinned once as a content-addressed blob; the atom holds
 *   `sourceDocumentCid` + extraction provenance (`sourceAdapter`,
 *   `extractedAt`, page/region). The atom never inlines the whole
 *   document. This is the shape encumbrance atoms already ship
 *   (`sourceDocumentCid` + `verificationStatus`).
 *
 *   EMBED-WITH. A small born-digital text fragment that IS the unit of
 *   meaning (a short clause, a definition) carries its text inline in
 *   `extractedText`. There is still a `sourceDocumentCid` receipt when
 *   the fragment came from a document.
 *
 * Decision rule (`storageRelationForExtraction`, below): embed-with when
 * the atom's content is small text that IS the meaning; point-to when
 * the atom is a claim extracted FROM a document that remains source of
 * truth.
 *
 * Confidence. Every minted atom carries an ASSERTED-baseline widthed
 * confidence (`kind: "asserted"`, never `"calibrated"`). The live
 * calibration overlay (`packages/engine-core/src/calibration/`) earns
 * the calibrated axis over time from adjudication + outcome signal. We
 * never fabricate a calibrated number at mint time (structural
 * commitment #2).
 *
 * accessPolicy is a PARAMETER, not hardcoded (the marketplace firewall).
 * A user's private dataroom upload mints `tenant-private` atoms; a
 * public/licensed document WE ingest for the marketplace can mint
 * `public-paid` reasoning atoms while the underlying blob stays gated.
 */

import { z } from "zod";

import type { AccessPolicy } from "@hauska-engine/atom-contract-pin";
import type { BaseAtomInstance } from "./instances.js";

export type { AccessPolicy };

// ---------------------------------------------------------------------------
// Verification status (generalized from the encumbrance VerificationStatus)
// ---------------------------------------------------------------------------

/**
 * How much trust the extraction carries. Mirrors and generalizes the
 * encumbrance `VerificationStatus` enum so a document-derived atom and a
 * recorded-instrument atom speak the same verification language.
 *
 *   - `extracted-unverified` — freshly OCR'd / LLM-parsed, no human pass.
 *   - `unverified-web-source` — parsed from a web-scraped document.
 *   - `human-verified` — a human confirmed the extracted claim.
 */
export type DocumentVerificationStatus =
  | "extracted-unverified"
  | "unverified-web-source"
  | "human-verified";

export const DOCUMENT_VERIFICATION_STATUSES: ReadonlyArray<DocumentVerificationStatus> =
  ["extracted-unverified", "unverified-web-source", "human-verified"];

// ---------------------------------------------------------------------------
// Asserted-baseline widthed confidence
// ---------------------------------------------------------------------------

/**
 * The confidence a freshly extracted atom carries: an asserted baseline
 * with an interval width and `n: 0`. Deliberately shaped like the
 * contract's three-axis `WidthedConfidence` (a scalar is inseparable
 * from `n` + `intervalWidth` + provenance) so it flows cleanly into the
 * live calibration overlay, which earns the calibrated axis over time.
 *
 * `kind` is always `"asserted"` at mint. It is NEVER `"calibrated"` —
 * calibration is earned by the overlay from outcome signal, not asserted
 * at extraction (structural commitment #2).
 */
export interface AssertedWidthedConfidence {
  /** Always `"asserted"` for a freshly minted document-derived atom. */
  kind: "asserted";
  /** Point estimate in [0, 1], seeded from source-type + extraction quality. */
  value: number;
  /**
   * Half-width of the asserted interval in [0, 1]. Wide at mint because
   * a single extraction pass with no outcome signal is uncertain; the
   * overlay narrows the *calibrated* axis as signal lands.
   */
  intervalWidth: number;
  /** Observation count backing the estimate. Always 0 at mint. */
  n: number;
}

export const ASSERTED_WIDTHED_CONFIDENCE_SCHEMA = z.object({
  kind: z.literal("asserted"),
  value: z.number().min(0).max(1),
  intervalWidth: z.number().min(0).max(1),
  n: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Storage relation (embed-with vs point-to) decision rule
// ---------------------------------------------------------------------------

/** The two storage relations between a document blob and an atom. */
export type StorageRelation = "point-to" | "embed-with";

export interface StorageRelationDecisionInput {
  /**
   * The extracted content, when the atom body is textual. Undefined for
   * non-textual claims (a parcel record, a bill amount).
   */
  text?: string;
  /**
   * True when the fragment is the atom's whole unit of meaning (a clause,
   * a definition) rather than a claim extracted from a larger document.
   */
  isUnitOfMeaning?: boolean;
  /**
   * Character threshold above which even a unit-of-meaning fragment is
   * treated as point-to (too large to inline into every atom copy /
   * atompack). Default 2000.
   */
  embedMaxChars?: number;
}

/**
 * The decision rule, in code:
 *   embed-with when the atom's content is small text that IS the meaning;
 *   point-to  when the atom is a claim extracted FROM a document that
 *             remains the source of truth.
 *
 * Point-to is the default for every real-world document. Embed-with is
 * reserved for small born-digital text fragments that are themselves the
 * unit of meaning.
 */
export function storageRelationForExtraction(
  input: StorageRelationDecisionInput,
): StorageRelation {
  const embedMaxChars = input.embedMaxChars ?? 2000;
  const text = input.text ?? "";
  const smallEnough = text.length > 0 && text.length <= embedMaxChars;
  if (input.isUnitOfMeaning && smallEnough) {
    return "embed-with";
  }
  return "point-to";
}

// ---------------------------------------------------------------------------
// Extraction provenance
// ---------------------------------------------------------------------------

/**
 * Where in the source document a claim was extracted from. All fields
 * optional because not every document type is paginated / positioned.
 */
export interface DocumentExtractionRegion {
  /** 1-based page number the claim was read from. */
  page?: number;
  /**
   * Page-relative bounding box, normalized to [0, 1], when the extractor
   * (OCR / vision) reports position. Survives DPI / resolution changes.
   */
  boundingBox?: { x: number; y: number; width: number; height: number };
  /** Free-text locator (e.g. a table name, a cell ref, a section label). */
  locator?: string;
}

const EXTRACTION_REGION_SCHEMA = z.object({
  page: z.number().int().min(1).optional(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  locator: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Document-derived atom base
// ---------------------------------------------------------------------------

/**
 * Fields every document-derived atom carries on top of `BaseAtomInstance`.
 *
 * `sourceDocumentCid` is the content-addressed CID of the pinned source
 * blob — the point-to reference to the document that remains the source
 * of truth. `contentHash` (inherited) is the hash of the atom's OWN
 * canonical body, used for atom-level idempotency; `sourceDocumentCid`
 * is the blob the atom points at (many atoms can share one).
 */
export interface DocumentDerivedFields {
  /**
   * Content-addressed CID of the pinned source document blob. The point-to
   * reference. Present for every document-derived atom (the whole point of
   * the ingestion path is that a document was pinned).
   */
  sourceDocumentCid: string;
  /** Storage relation this atom uses (point-to default; embed-with for inline meaning). */
  storageRelation: StorageRelation;
  /** ISO-8601 timestamp the extraction pass produced this atom. */
  extractedAt: string;
  /** Where in the document the claim was extracted from. */
  extractionRegion?: DocumentExtractionRegion;
  /** How much trust the extraction carries. */
  verificationStatus: DocumentVerificationStatus;
  /** Asserted-baseline widthed confidence. Never calibrated at mint. */
  confidence: AssertedWidthedConfidence;
  /**
   * Access tier per ADR-017. PARAMETERIZED — set from the caller/source
   * policy at ingest, defaulting to `tenant-private`. This is the
   * marketplace firewall: a user's private-doc-derived atoms are never
   * auto-published.
   */
  accessPolicy: AccessPolicy;
  /**
   * Inline extracted text — populated ONLY when `storageRelation` is
   * `embed-with` (a small born-digital fragment that IS the meaning).
   * Point-to atoms leave this undefined; their meaning lives in the
   * typed fields + the pointed-to document.
   */
  extractedText?: string;
}

const ACCESS_POLICY_SCHEMA = z.enum([
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
]);

const DOCUMENT_DERIVED_BASE_SHAPE = {
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  sourceDocumentCid: z.string().min(1),
  storageRelation: z.enum(["point-to", "embed-with"]),
  extractedAt: z.string().min(1),
  extractionRegion: EXTRACTION_REGION_SCHEMA.optional(),
  verificationStatus: z.enum([
    "extracted-unverified",
    "unverified-web-source",
    "human-verified",
  ]),
  confidence: ASSERTED_WIDTHED_CONFIDENCE_SCHEMA,
  accessPolicy: ACCESS_POLICY_SCHEMA,
  extractedText: z.string().optional(),
} as const;

/**
 * Context that anchors a minted atom to a node / parcel / engagement /
 * jurisdiction. All optional — the ingest path accepts whatever the
 * caller has.
 */
export interface DocumentContextRefs {
  nodeId?: string;
  apn?: string;
  engagementId?: string;
  jurisdiction?: string;
}

// ---------------------------------------------------------------------------
// Generic document-derived claim atom
// ---------------------------------------------------------------------------

/**
 * `document-derived-claim` — the GENERIC atom the framework + generic PDF
 * adapter mint. One claim (a fact, a statement, a line) extracted from a
 * document, with a short human title, an optional inline snippet
 * (embed-with) or a point-to reference, and full provenance.
 *
 * Typed adapters (survey, utility bill) mint their own typed shapes; the
 * generic claim is the fallback for a document type without a dedicated
 * adapter, so ingestion never hard-fails on an unknown document.
 */
export interface DocumentDerivedClaimAtomInstance
  extends BaseAtomInstance,
    DocumentDerivedFields {
  entityType: "document-derived-claim";
  /** Short human title for the claim (chip / list display). */
  title: string;
  /**
   * Classified document type this claim came from (e.g. `survey`,
   * `utility-bill`, `generic-pdf`). Free-text so new types don't require
   * a schema bump.
   */
  documentType: string;
  /** Optional node/parcel/engagement anchor. */
  contextRefs?: DocumentContextRefs;
}

const DOCUMENT_CONTEXT_REFS_SCHEMA = z.object({
  nodeId: z.string().optional(),
  apn: z.string().optional(),
  engagementId: z.string().optional(),
  jurisdiction: z.string().optional(),
});

export const DOCUMENT_DERIVED_CLAIM_SCHEMA = z.object({
  ...DOCUMENT_DERIVED_BASE_SHAPE,
  entityType: z.literal("document-derived-claim"),
  title: z.string().min(1),
  documentType: z.string().min(1),
  contextRefs: DOCUMENT_CONTEXT_REFS_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// Typed adapter example 1 — survey / plat record
// ---------------------------------------------------------------------------

/**
 * `survey-record` — a typed claim extracted from a land survey or plat:
 * the boundary / bearing / acreage facts a survey asserts about a parcel.
 * Point-to: the survey PDF remains the source of truth.
 */
export interface SurveyRecordAtomInstance
  extends BaseAtomInstance,
    DocumentDerivedFields {
  entityType: "survey-record";
  /** Parcel / lot / tract identifier the survey describes. */
  parcelDescriptor: string;
  /** Recorded acreage, when stated. Null when not extractable. */
  acreage: number | null;
  /** Bearing / distance calls, verbatim where extracted. */
  boundaryCalls: ReadonlyArray<string>;
  /** Surveyor / firm named on the plat. Empty when not extractable. */
  surveyor: string;
  /** Recording reference (volume/page, instrument no.). Empty when absent. */
  recordingReference: string;
  /** Optional node/parcel/engagement anchor. */
  contextRefs?: DocumentContextRefs;
}

export const SURVEY_RECORD_SCHEMA = z.object({
  ...DOCUMENT_DERIVED_BASE_SHAPE,
  entityType: z.literal("survey-record"),
  parcelDescriptor: z.string().min(1),
  acreage: z.number().nullable(),
  boundaryCalls: z.array(z.string()),
  surveyor: z.string(),
  recordingReference: z.string(),
  contextRefs: DOCUMENT_CONTEXT_REFS_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// Typed adapter example 2 — utility bill record
// ---------------------------------------------------------------------------

/**
 * `utility-bill-record` — a typed claim extracted from a utility bill:
 * the operational-overlay data a digital twin consumes (utility type,
 * usage, cost, period). Point-to: the bill PDF remains source of truth.
 */
export interface UtilityBillRecordAtomInstance
  extends BaseAtomInstance,
    DocumentDerivedFields {
  entityType: "utility-bill-record";
  /** Utility kind (e.g. `electric`, `water`, `gas`, `sewer`, `trash`). */
  utilityType: string;
  /** Service account / meter identifier. Empty when not extractable. */
  accountIdentifier: string;
  /** Billed usage quantity. Null when not extractable. */
  usageQuantity: number | null;
  /** Usage unit (e.g. `kWh`, `gal`, `ccf`, `therms`). Empty when absent. */
  usageUnit: string;
  /** Billed amount in USD. Null when not extractable. */
  amountUsd: number | null;
  /** ISO-8601 service-period start. Null when not extractable. */
  periodStart: string | null;
  /** ISO-8601 service-period end. Null when not extractable. */
  periodEnd: string | null;
  /** Optional node/parcel/engagement anchor. */
  contextRefs?: DocumentContextRefs;
}

export const UTILITY_BILL_RECORD_SCHEMA = z.object({
  ...DOCUMENT_DERIVED_BASE_SHAPE,
  entityType: z.literal("utility-bill-record"),
  utilityType: z.string().min(1),
  accountIdentifier: z.string(),
  usageQuantity: z.number().nullable(),
  usageUnit: z.string(),
  amountUsd: z.number().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  contextRefs: DOCUMENT_CONTEXT_REFS_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type DocumentDerivedAtomInstance =
  | DocumentDerivedClaimAtomInstance
  | SurveyRecordAtomInstance
  | UtilityBillRecordAtomInstance;

export type DocumentDerivedAtomEntityType =
  DocumentDerivedAtomInstance["entityType"];

export const DOCUMENT_DERIVED_ATOM_ENTITY_TYPES: ReadonlyArray<DocumentDerivedAtomEntityType> =
  ["document-derived-claim", "survey-record", "utility-bill-record"];

/** True when an entityType is a document-derived atom type. */
export function isDocumentDerivedEntityType(
  entityType: string,
): entityType is DocumentDerivedAtomEntityType {
  return (DOCUMENT_DERIVED_ATOM_ENTITY_TYPES as ReadonlyArray<string>).includes(
    entityType,
  );
}
