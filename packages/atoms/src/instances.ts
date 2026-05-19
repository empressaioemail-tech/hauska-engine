/**
 * Engine-side atom-instance shapes for Bump 1 code atoms.
 *
 * The shapes here are the concrete payload that gets pinned to IPFS
 * and indexed in Postgres per ADR-010. Each shape extends the same
 * `BaseAtomInstance` carrying jurisdiction tenant, source provenance,
 * and a content hash (the storage layer maps content hash to CID).
 */

import { z } from "zod";

import type { AccessPolicy } from "@hauska-engine/atom-contract-pin";

export type { AccessPolicy };

export interface BaseAtomInstance {
  entityType: string;
  /** Stable local id within entityType. Combined with entityType into a DID per ADR-011. */
  entityId: string;
  jurisdictionTenant: string;
  /** ISO-8601 timestamp at which the source was last fetched. */
  fetchedAt: string;
  /** Adapter name (`municode-html`, `ecode360-html`, `raw-pdf`, ...). */
  sourceAdapter: string;
  /** Source URL for citation. */
  sourceUrl: string;
  /** Content hash (sha256 hex) of the canonical body. Maps to CID at storage time. */
  contentHash: string;
}

export interface CodeSectionAtomInstance extends BaseAtomInstance {
  entityType: "code-section";
  codeEditionId: string;
  sectionNumber: string;
  title: string;
  subsectionPath: string | null;
  bodyText: string;
}

export interface CodeDefinitionAtomInstance extends BaseAtomInstance {
  entityType: "code-definition";
  codeEditionId: string;
  term: string;
  definitionText: string;
  /** Section the definition is published in. Empty if global glossary. */
  definingSectionId: string | null;
  /** Scope of the definition. */
  scope: "section" | "chapter" | "code";
}

export interface CodeAmendmentAtomInstance extends BaseAtomInstance {
  entityType: "code-amendment";
  ordinanceId: string;
  effectiveDate: string;
  authority: string;
  affectedSectionIds: ReadonlyArray<string>;
  amendmentText: string;
  /** Prior CID being superseded per ADR-011 chain semantics. Empty for first ingest. */
  replacesSectionContentHash: string | null;
}

export interface CodeCrossReferenceAtomInstance extends BaseAtomInstance {
  entityType: "code-cross-reference";
  fromSectionId: string;
  toSectionId: string;
  referenceText: string;
  referenceContext: string | null;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
}

export interface CodeEditionAtomInstance extends BaseAtomInstance {
  entityType: "code-edition";
  editionLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sectionIds: ReadonlyArray<string>;
  amendmentIds: ReadonlyArray<string>;
}

export interface JurisdictionCorpusAtomInstance extends BaseAtomInstance {
  entityType: "jurisdiction-corpus";
  jurisdictionName: string;
  adoptedEditionIds: ReadonlyArray<string>;
  currentEditionId: string | null;
  /** Eval-harness pass state per 49 §B.4. */
  coverageQualityBar:
    | "not-evaluated"
    | "failing"
    | "passing"
    | "passing-recalibrated";
  lastRefreshedAt: string;
  /**
   * ADR-017 access tier per `@hauska/atom-contract@^1.1.0`. Surfaces
   * that gate on visibility (MCP `list_jurisdictions`, public catalog)
   * treat an omitted field as `"public-free"`. Partnership-pending
   * jurisdictions ingest as `"platform-internal"` until partnership
   * outreach closes; the field flips to `"public-free"` once cleared.
   *
   * See `_decisions/2026-05-19_sync_4_5_and_cortex_sprint.md` Path A
   * resolution for the Smithville / Elgin / Bastrop County tagging
   * driver.
   */
  accessPolicy?: AccessPolicy;
}

export type CodeAtomInstance =
  | CodeSectionAtomInstance
  | CodeDefinitionAtomInstance
  | CodeAmendmentAtomInstance
  | CodeCrossReferenceAtomInstance
  | CodeEditionAtomInstance
  | JurisdictionCorpusAtomInstance;

export type CodeAtomEntityType = CodeAtomInstance["entityType"];

export const CODE_ATOM_ENTITY_TYPES: ReadonlyArray<CodeAtomEntityType> = [
  "code-section",
  "code-definition",
  "code-amendment",
  "code-cross-reference",
  "code-edition",
  "jurisdiction-corpus",
];

// ---------------------------------------------------------------------------
// Cortex (L-surface) atom instances
// ---------------------------------------------------------------------------
//
// L1 through L6 atoms per `_dispatches/2026-05-19_cc-agent-E_l_surface_atom_shapes.md`.
// Each ships in its own PR; this file accretes shapes as they land so the
// engine atom-registry has a single union view for storage / retrieval.

/**
 * L1 — `response-task` atom.
 *
 * Persistent task state for the client-comment response flow. Architect
 * receives client comments → creates response tasks → tracks state across
 * sessions. Per the 2026-05-19 Lane A.2 dispatch the atom is the
 * single source of truth for current state; the declared eventTypes
 * (`response-task.opened` / `.progressed` / `.completed` / `.cancelled`)
 * supply the audit chain so consumers wanting an event-sourced view can
 * compose it from the storage layer's event log without the atom record
 * carrying the chain inline.
 *
 * Linking (ADR-015 actor model + cross-product references):
 *   - `sourceClientCommentId` — the client comment that motivated the
 *     task. Optional because architects may also self-author tasks.
 *   - `findingId` — finding the task addresses, if scoped to a specific
 *     compliance finding.
 *   - `engagementId` — the engagement the task lives within.
 *   - `actorId` — the architect / staff member assigned execution.
 *   - `principalActorId` — the actor accountable for the engagement
 *     overall; may differ from `actorId` for delegated work.
 */
export type ResponseTaskState =
  | "open"
  | "in-progress"
  | "done"
  | "cancelled";

export const RESPONSE_TASK_STATES: ReadonlyArray<ResponseTaskState> = [
  "open",
  "in-progress",
  "done",
  "cancelled",
];

export interface ResponseTaskAtomInstance extends BaseAtomInstance {
  entityType: "response-task";
  /** Short human title displayed in lists + chips. */
  title: string;
  /** Long-form task description (may be empty for trivial tasks). */
  description: string;
  /** Current state. Audit-chain history lives in the storage event log. */
  state: ResponseTaskState;
  /** ISO-8601 timestamp the task was created. */
  createdAt: string;
  /** ISO-8601 deadline. Null when no deadline is set. */
  dueAt: string | null;
  /** ISO-8601 timestamp the task entered `"done"`. Null otherwise. */
  completedAt: string | null;
  /** Linked client-comment atom entityId. Null for architect-authored. */
  sourceClientCommentId: string | null;
  /** Linked finding entityId. Null when not scoped to a finding. */
  findingId: string | null;
  /** Engagement this task lives within. Null in rare standalone cases. */
  engagementId: string | null;
  /** Actor assigned execution (ADR-015). */
  actorId: string | null;
  /** Actor accountable; may differ from `actorId` for delegation. */
  principalActorId: string | null;
  /**
   * Access tier per ADR-017. Default `"tenant-private"` per the
   * 2026-05-19 dispatch (response-task is workflow data, not public
   * catalog).
   */
  accessPolicy?: AccessPolicy;
}

/**
 * Zod schema mirroring `ResponseTaskAtomInstance`. Lets cross-repo
 * consumers (MCP tools, UI surfaces) validate at the boundary without
 * re-deriving the shape. Runtime parse failures surface clear errors;
 * the schema is the canonical validation surface for L1.
 */
export const RESPONSE_TASK_SCHEMA = z.object({
  entityType: z.literal("response-task"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  state: z.enum(["open", "in-progress", "done", "cancelled"]),
  createdAt: z.string().min(1),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  sourceClientCommentId: z.string().nullable(),
  findingId: z.string().nullable(),
  engagementId: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: z
    .enum(["public-free", "public-paid", "platform-internal", "tenant-private"])
    .optional(),
});

// ---------------------------------------------------------------------------
// L2 — `sheet-content-extraction` + `attached-document` atoms
// ---------------------------------------------------------------------------
//
// Two atoms in one phase per the 2026-05-19 Lane A.2 dispatch: they are
// coupled at the producer (sheet ingest extracts both inline in one pass).
// L2 closes the structured-annotation-extraction gap downstream of the
// existing Claude vision OCR pass.

/**
 * Page-relative bounding box. Coordinates are normalized to `[0, 1]`
 * against the source page so they survive resolution / DPI changes:
 * `x` / `y` are the top-left corner, `width` / `height` the extent.
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Structured-annotation categories extracted from a construction sheet.
 * `revision-cloud` marks a revised region; `dimension` a dimension
 * callout; `schedule-row` a row from a door / window / finish schedule;
 * `callout` a detail / section callout bubble.
 */
export type SheetAnnotationKind =
  | "revision-cloud"
  | "dimension"
  | "schedule-row"
  | "callout";

export const SHEET_ANNOTATION_KINDS: ReadonlyArray<SheetAnnotationKind> = [
  "revision-cloud",
  "dimension",
  "schedule-row",
  "callout",
];

/** One OCR text segment with its page-relative position + confidence. */
export interface SheetTextSegment {
  text: string;
  boundingBox: BoundingBox;
  /** OCR confidence in `[0, 1]`. */
  sourceConfidence: number;
}

/** One structured annotation extracted from the sheet. */
export interface SheetStructuredAnnotation {
  kind: SheetAnnotationKind;
  position: BoundingBox;
  content: string;
  /** Extraction confidence in `[0, 1]`. */
  sourceConfidence: number;
}

/**
 * L2a — `sheet-content-extraction` atom.
 *
 * Classified output of the sheet-ingest pass: OCR text segments plus
 * structured annotations (revision clouds, dimensions, schedule rows,
 * callouts). Produced downstream of the existing Claude vision OCR step;
 * the atom is what the `plan-review` compare workflow consumes instead
 * of raw OCR text.
 */
export interface SheetContentExtractionAtomInstance extends BaseAtomInstance {
  entityType: "sheet-content-extraction";
  /** Source sheet entityId / blob ref this extraction was produced from. */
  sourceSheetId: string;
  /** Engagement the sheet belongs to. Null in rare standalone cases. */
  engagementId: string | null;
  /** Sheet number / label (e.g. "A-101"). Empty when the sheet is unlabeled. */
  pageLabel: string;
  /** OCR text segments with page-relative bounding boxes. */
  extractedTextSegments: ReadonlyArray<SheetTextSegment>;
  /** Structured annotations (revision clouds, dimensions, etc.). */
  structuredAnnotations: ReadonlyArray<SheetStructuredAnnotation>;
  /** Model that produced the OCR pass (provenance, e.g. "claude-sonnet-4-5"). */
  ocrModel: string;
  /** Architect / staff member who uploaded the source sheet (ADR-015). */
  actorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

/** Supporting-document categories attached to an engagement. */
export type AttachedDocumentType =
  | "specification"
  | "calculation"
  | "product-data"
  | "narrative";

export const ATTACHED_DOCUMENT_TYPES: ReadonlyArray<AttachedDocumentType> = [
  "specification",
  "calculation",
  "product-data",
  "narrative",
];

/**
 * L2b — `attached-document` atom.
 *
 * A supporting document attached to an engagement (spec section,
 * structural calculation, product-data sheet, design narrative). Carries
 * the parsed text plus a reference to the stored original blob.
 */
export interface AttachedDocumentAtomInstance extends BaseAtomInstance {
  entityType: "attached-document";
  /** Engagement this document is attached to. */
  engagementId: string;
  /** Human document title. */
  title: string;
  /** Document category. */
  documentType: AttachedDocumentType;
  /** Parsed text content. */
  extractedText: string;
  /** Reference to the stored original blob (CID / storage key). */
  originalBlobRef: string;
  /** Architect / staff member who attached the document (ADR-015). */
  actorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

const BOUNDING_BOX_SCHEMA = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const ACCESS_POLICY_SCHEMA = z
  .enum(["public-free", "public-paid", "platform-internal", "tenant-private"])
  .optional();

/**
 * Zod schema mirroring `SheetContentExtractionAtomInstance`. Canonical
 * boundary-validation surface for L2a cross-repo consumers.
 */
export const SHEET_CONTENT_EXTRACTION_SCHEMA = z.object({
  entityType: z.literal("sheet-content-extraction"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  sourceSheetId: z.string().min(1),
  engagementId: z.string().nullable(),
  pageLabel: z.string(),
  extractedTextSegments: z.array(
    z.object({
      text: z.string(),
      boundingBox: BOUNDING_BOX_SCHEMA,
      sourceConfidence: z.number().min(0).max(1),
    }),
  ),
  structuredAnnotations: z.array(
    z.object({
      kind: z.enum(["revision-cloud", "dimension", "schedule-row", "callout"]),
      position: BOUNDING_BOX_SCHEMA,
      content: z.string(),
      sourceConfidence: z.number().min(0).max(1),
    }),
  ),
  ocrModel: z.string().min(1),
  actorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

/**
 * Zod schema mirroring `AttachedDocumentAtomInstance`. Canonical
 * boundary-validation surface for L2b cross-repo consumers.
 */
export const ATTACHED_DOCUMENT_SCHEMA = z.object({
  entityType: z.literal("attached-document"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  title: z.string().min(1),
  documentType: z.enum([
    "specification",
    "calculation",
    "product-data",
    "narrative",
  ]),
  extractedText: z.string(),
  originalBlobRef: z.string().min(1),
  actorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// ---------------------------------------------------------------------------
// L3 — `deliverable-letter` atom
// ---------------------------------------------------------------------------
//
// The comment-response letter as a classified atom: structured sections
// with per-section provenance back to the L1 / L2 / finding / adjudication
// atoms that fed each section. DOCX/PDF rendering is a downstream consumer
// (L6) of this atom — the render pipeline reads the structured sections;
// the atom itself never carries rendered bytes.

/**
 * Letter section categories. A complete (sendable) letter carries a
 * `cover`, an `intro`, and a `signature`; `per-comment-response`
 * sections are variable (zero or more, one per addressed comment).
 */
export type LetterSectionKind =
  | "cover"
  | "intro"
  | "per-comment-response"
  | "signature";

export const LETTER_SECTION_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "per-comment-response",
  "signature",
];

/** Sections required for a letter to be considered complete / sendable. */
export const REQUIRED_LETTER_SECTION_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "signature",
];

/**
 * Per-section provenance — the L1 / L2 / finding / adjudication atoms
 * that fed this section's content. Empty arrays are valid (a `cover`
 * section typically cites nothing). Provenance is per-section, not
 * per-letter, so a `per-comment-response` section names exactly the
 * finding + response-task + adjudication it answers.
 */
export interface LetterSectionProvenance {
  /** L1 `response-task` atom entityIds. */
  responseTaskIds: ReadonlyArray<string>;
  /** L2 `sheet-content-extraction` atom entityIds. */
  sheetContentExtractionIds: ReadonlyArray<string>;
  /** Finding atom entityIds (finding atoms are produced product-side). */
  findingIds: ReadonlyArray<string>;
  /** Adjudication-state atom entityIds. */
  adjudicationStateIds: ReadonlyArray<string>;
}

/** One structured section of a deliverable letter. */
export interface LetterSection {
  kind: LetterSectionKind;
  /** Section heading (e.g. "Response to Comment 7"). May be empty. */
  heading: string;
  /** Section body text. */
  content: string;
  /** Atoms that fed this section. */
  provenance: LetterSectionProvenance;
}

/** Lifecycle status of a deliverable letter. */
export type DeliverableLetterStatus = "draft" | "sent";

export const DELIVERABLE_LETTER_STATUSES: ReadonlyArray<DeliverableLetterStatus> = [
  "draft",
  "sent",
];

/**
 * L3 — `deliverable-letter` atom.
 *
 * The comment-response letter as a classified atom. Structured sections
 * carry per-section provenance; the L6 render pipeline turns this into
 * a DOCX/PDF. Per the 2026-05-19 Lane A.2 dispatch the atom is the
 * single source of truth for letter content + status; declared
 * eventTypes (`deliverable-letter.drafted` / `.section-revised` /
 * `.sent`) supply the audit chain.
 */
export interface DeliverableLetterAtomInstance extends BaseAtomInstance {
  entityType: "deliverable-letter";
  /** Engagement this letter belongs to. */
  engagementId: string;
  /** Human letter title. */
  title: string;
  /** Lifecycle status. */
  status: DeliverableLetterStatus;
  /** Client actor receiving the letter (ADR-015). Null while drafting. */
  recipientActorId: string | null;
  /** Ordered structured sections. Array order is the letter order. */
  sections: ReadonlyArray<LetterSection>;
  /** ISO-8601 timestamp the letter was created. */
  createdAt: string;
  /** ISO-8601 timestamp the letter entered `"sent"`. Null otherwise. */
  sentAt: string | null;
  /** Architect / staff member who authored the letter (ADR-015). */
  actorId: string | null;
  /** Actor accountable for the engagement; may differ from `actorId`. */
  principalActorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

/**
 * Section-completeness check for a deliverable letter. A letter is
 * complete (sendable) when every kind in `REQUIRED_LETTER_SECTION_KINDS`
 * is present at least once. The L6 render pipeline + UI gate the "send"
 * action on this; a `draft` letter may legitimately be incomplete.
 */
export function deliverableLetterCompleteness(
  sections: ReadonlyArray<LetterSection>,
): { complete: boolean; missing: ReadonlyArray<LetterSectionKind> } {
  const present = new Set(sections.map((s) => s.kind));
  const missing = REQUIRED_LETTER_SECTION_KINDS.filter(
    (kind) => !present.has(kind),
  );
  return { complete: missing.length === 0, missing };
}

const LETTER_SECTION_PROVENANCE_SCHEMA = z.object({
  responseTaskIds: z.array(z.string()),
  sheetContentExtractionIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  adjudicationStateIds: z.array(z.string()),
});

/**
 * Zod schema mirroring `DeliverableLetterAtomInstance`. Canonical
 * boundary-validation surface for L3 cross-repo consumers (the L6
 * render pipeline + the MCP tool + the UI).
 */
export const DELIVERABLE_LETTER_SCHEMA = z.object({
  entityType: z.literal("deliverable-letter"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["draft", "sent"]),
  recipientActorId: z.string().nullable(),
  sections: z.array(
    z.object({
      kind: z.enum(["cover", "intro", "per-comment-response", "signature"]),
      heading: z.string(),
      content: z.string(),
      provenance: LETTER_SECTION_PROVENANCE_SCHEMA,
    }),
  ),
  createdAt: z.string().min(1),
  sentAt: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

/**
 * Union of Cortex (L-surface) atom instances. Grows as L4-L6 land.
 */
export type CortexAtomInstance =
  | ResponseTaskAtomInstance
  | SheetContentExtractionAtomInstance
  | AttachedDocumentAtomInstance
  | DeliverableLetterAtomInstance;

export type CortexAtomEntityType = CortexAtomInstance["entityType"];

export const CORTEX_ATOM_ENTITY_TYPES: ReadonlyArray<CortexAtomEntityType> = [
  "response-task",
  "sheet-content-extraction",
  "attached-document",
  "deliverable-letter",
];

/**
 * Every atom instance the engine atom-registry knows — code-corpus
 * (Bump 1) plus Cortex L-surface atoms. Storage / retrieval / registry
 * consumers key off this union.
 */
export type AtomInstance = CodeAtomInstance | CortexAtomInstance;

export type AtomEntityType = AtomInstance["entityType"];
