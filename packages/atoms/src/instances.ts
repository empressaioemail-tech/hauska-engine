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

/**
 * Distinguishes the two roles a `code-amendment` atom plays.
 *
 *  - `"temporal"` — an ordinance modifying a section over time within
 *    its own jurisdiction (the original Bump 1 semantics; the doc 49
 *    §B.5 version-tracking case).
 *  - `"jurisdictional-overlay"` — Layer 2 of the ADR-019 layered code
 *    substrate: a jurisdiction's local modification of a shared Layer 1
 *    model-code base section. The jurisdiction's effective rule is the
 *    base section composed with this overlay.
 *
 * Per the ADR-019 §Open decisions resolution, the layered substrate
 * extends the existing `code-amendment` type with this discriminant
 * rather than introducing a distinct atom type: the entity-type-enum
 * surface (storage schema, retrieval-api zod enum, registry, search
 * filters) is unchanged, and a city adoption ordinance already carries
 * an `ordinanceId` / `effectiveDate` / `authority` exactly as a
 * temporal amendment does.
 */
export type AmendmentScope = "temporal" | "jurisdictional-overlay";

export const AMENDMENT_SCOPES: ReadonlyArray<AmendmentScope> = [
  "temporal",
  "jurisdictional-overlay",
];

/**
 * How a jurisdictional overlay relates to the Layer 1 base section it
 * targets. The operation drives effective-rule composition:
 *
 *  - `"modify"`  — the base section's requirements change in part; the
 *    effective rule is the base section composed with the overlay.
 *  - `"replace"` — the base section is wholly superseded; the effective
 *    rule is the overlay text alone.
 *  - `"add"`     — a local section with no model-code parent is added;
 *    the effective rule is the overlay alone (no base).
 *  - `"delete"`  — the base section is struck (not adopted); the
 *    effective rule is nothing.
 */
export type OverlayOperation = "modify" | "replace" | "add" | "delete";

export const OVERLAY_OPERATIONS: ReadonlyArray<OverlayOperation> = [
  "modify",
  "replace",
  "add",
  "delete",
];

/** Fields shared by both `code-amendment` scopes. */
export interface CodeAmendmentBaseFields extends BaseAtomInstance {
  entityType: "code-amendment";
  /** Enacting / adopting ordinance identifier. */
  ordinanceId: string;
  /** ISO-8601 effective date. */
  effectiveDate: string;
  /** Enacting authority (e.g. the city council). */
  authority: string;
  /**
   * Section atoms this amendment affects. A temporal amendment names
   * same-jurisdiction section atoms; a jurisdictional overlay names the
   * shared Layer 1 base `code-section` atoms it modifies.
   */
  affectedSectionIds: ReadonlyArray<string>;
  amendmentText: string;
}

/**
 * Temporal `code-amendment` — original Bump 1 semantics. An ordinance
 * modifying a section within its own jurisdiction over time.
 */
export interface TemporalCodeAmendmentInstance extends CodeAmendmentBaseFields {
  amendmentScope: "temporal";
  /** Prior CID being superseded per ADR-011 chain semantics. Null for first ingest. */
  replacesSectionContentHash: string | null;
}

/**
 * Jurisdictional-overlay `code-amendment` — Layer 2 of the ADR-019
 * layered code substrate. A jurisdiction's local modification of a
 * shared Layer 1 model-code base section.
 */
export interface JurisdictionalOverlayAmendmentInstance
  extends CodeAmendmentBaseFields {
  amendmentScope: "jurisdictional-overlay";
  /** The shared Layer 1 `code-edition` entityId this overlay amends. */
  baseEditionId: string;
  /** How the overlay relates to the base section (drives composition). */
  overlayOperation: OverlayOperation;
}

/**
 * A `code-amendment` atom, discriminated on `amendmentScope`. Temporal
 * amendments and jurisdictional overlays share one `entityType` and one
 * registry registration; the discriminant carries the difference.
 */
export type CodeAmendmentAtomInstance =
  | TemporalCodeAmendmentInstance
  | JurisdictionalOverlayAmendmentInstance;

/** True when the amendment is a Layer 2 jurisdictional overlay. */
export function isJurisdictionalOverlay(
  amendment: CodeAmendmentAtomInstance,
): amendment is JurisdictionalOverlayAmendmentInstance {
  return amendment.amendmentScope === "jurisdictional-overlay";
}

/** True when the amendment is a temporal (same-jurisdiction) amendment. */
export function isTemporalAmendment(
  amendment: CodeAmendmentAtomInstance,
): amendment is TemporalCodeAmendmentInstance {
  return amendment.amendmentScope === "temporal";
}

/** Base-atom fields common to every Bump 1 code-atom Zod schema. */
const CODE_ATOM_BASE_SHAPE = {
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
} as const;

const CODE_AMENDMENT_BASE_SHAPE = {
  ...CODE_ATOM_BASE_SHAPE,
  entityType: z.literal("code-amendment"),
  ordinanceId: z.string().min(1),
  effectiveDate: z.string().min(1),
  authority: z.string().min(1),
  affectedSectionIds: z.array(z.string()),
  amendmentText: z.string(),
} as const;

/**
 * Zod schema mirroring `CodeAmendmentAtomInstance`. The first
 * boundary-validation schema for a Bump 1 code atom, added with the
 * ADR-019 discriminated-union extension so the temporal / overlay split
 * is conformance-checkable. `discriminatedUnion` keys on
 * `amendmentScope` and rejects a payload whose field set does not match
 * its scope (a temporal amendment carrying `baseEditionId`, an overlay
 * missing `overlayOperation`, etc.).
 */
export const CODE_AMENDMENT_SCHEMA = z.discriminatedUnion("amendmentScope", [
  z.object({
    ...CODE_AMENDMENT_BASE_SHAPE,
    amendmentScope: z.literal("temporal"),
    replacesSectionContentHash: z.string().nullable(),
  }),
  z.object({
    ...CODE_AMENDMENT_BASE_SHAPE,
    amendmentScope: z.literal("jurisdictional-overlay"),
    baseEditionId: z.string().min(1),
    overlayOperation: z.enum(["modify", "replace", "add", "delete"]),
  }),
]);

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

// ---------------------------------------------------------------------------
// L4 — `detail-callout-spec` atom
// ---------------------------------------------------------------------------
//
// Spec for a Revit detail callout that the Revit Connector add-in
// consumes via APS Design Automation. Closes the Revit content-push gap.
//
// The `spec` payload is a discriminated union keyed on `detailType`:
// each detail type carries its own structured spec shape. The
// `DetailCalloutType` enum IS the discriminant — there is no redundant
// top-level `detailType` field on the atom, so the atom and its spec
// can never drift. Consumers (the Revit Connector add-in) switch on
// `atom.spec.detailType`.
//
// Extensibility: the v1 set is door-schedule / wall-section / wall-type
// / room-finish. A new detail type adds (1) a member to
// `DetailCalloutType`, (2) a spec interface, (3) an arm to the
// `DetailCalloutSpec` union, and (4) an arm to the Zod
// `discriminatedUnion`. No atom-shape migration — older atoms keep
// their existing discriminant.

export type DetailCalloutType =
  | "door-schedule"
  | "wall-section"
  | "wall-type"
  | "room-finish";

export const DETAIL_CALLOUT_TYPES: ReadonlyArray<DetailCalloutType> = [
  "door-schedule",
  "wall-section",
  "wall-type",
  "room-finish",
];

/** One layer of a wall assembly (shared by wall-section + wall-type). */
export interface WallAssemblyLayer {
  material: string;
  /** As-drawn thickness, architect notation (e.g. `5/8"`). */
  thickness: string;
  /** Layer function (e.g. `structure`, `finish`, `membrane`). */
  function: string;
}

/** L4 spec — door schedule. One row per scheduled door. */
export interface DoorScheduleSpec {
  detailType: "door-schedule";
  rows: ReadonlyArray<{
    doorMark: string;
    doorType: string;
    /** Architect feet-inches notation kept verbatim (e.g. `3'-0"`). */
    width: string;
    height: string;
    material: string;
    /** Fire rating, empty when not rated (e.g. `20 min`). */
    fireRating: string;
    hardwareSet: string;
  }>;
}

/** L4 spec — wall section cut. */
export interface WallSectionSpec {
  detailType: "wall-section";
  /** Section mark (e.g. `A/A-501`). */
  sectionMark: string;
  /** Free description of where the section is cut. */
  cutLocation: string;
  assemblyLayers: ReadonlyArray<WallAssemblyLayer>;
  /** Bottom datum (e.g. `T.O. Slab`). */
  baseDatum: string;
  /** Top datum (e.g. `T.O. Parapet`). */
  topDatum: string;
}

/** L4 spec — wall type definition. */
export interface WallTypeSpec {
  detailType: "wall-type";
  /** Type mark (e.g. `W1`). */
  typeMark: string;
  assemblyLayers: ReadonlyArray<WallAssemblyLayer>;
  fireRating: string;
  /** Sound transmission class, empty when not specified. */
  stcRating: string;
}

/** L4 spec — room finish schedule entry. */
export interface RoomFinishSpec {
  detailType: "room-finish";
  roomName: string;
  roomNumber: string;
  floorFinish: string;
  baseFinish: string;
  wallFinish: string;
  ceilingFinish: string;
  ceilingHeight: string;
}

/** Discriminated union of detail-callout spec payloads, keyed on `detailType`. */
export type DetailCalloutSpec =
  | DoorScheduleSpec
  | WallSectionSpec
  | WallTypeSpec
  | RoomFinishSpec;

/**
 * Push lifecycle of a detail-callout spec through the Revit Connector:
 *   - `pending`          — created, not yet pushed.
 *   - `pushed`           — submitted to APS Design Automation.
 *   - `applied`          — the add-in applied the detail in the model.
 *   - `rejected-by-user` — the architect declined the pushed detail.
 */
export type DetailCalloutPushState =
  | "pending"
  | "pushed"
  | "applied"
  | "rejected-by-user";

export const DETAIL_CALLOUT_PUSH_STATES: ReadonlyArray<DetailCalloutPushState> = [
  "pending",
  "pushed",
  "applied",
  "rejected-by-user",
];

/**
 * Legal push-state transitions. `applied` is terminal; a
 * `rejected-by-user` spec can be revised and returned to `pending` for
 * another push attempt. This is advisory — the atom-registry performs
 * no runtime enforcement (consistent with L1-L3 state fields); the
 * Revit Connector + UI consult it to gate transitions.
 */
export const LEGAL_PUSH_TRANSITIONS: Record<
  DetailCalloutPushState,
  ReadonlyArray<DetailCalloutPushState>
> = {
  pending: ["pushed"],
  pushed: ["applied", "rejected-by-user"],
  applied: [],
  "rejected-by-user": ["pending"],
};

/** True when `to` is a legal next push-state from `from`. */
export function isLegalPushTransition(
  from: DetailCalloutPushState,
  to: DetailCalloutPushState,
): boolean {
  return LEGAL_PUSH_TRANSITIONS[from].includes(to);
}

/**
 * L4 — `detail-callout-spec` atom.
 *
 * A structured spec for a Revit detail callout. The Revit Connector
 * add-in consumes it and pushes the detail into the model via APS
 * Design Automation. The atom is the single source of truth for spec
 * content + push state; declared eventTypes
 * (`detail-callout-spec.created` / `.pushed` / `.applied` /
 * `.rejected`) supply the audit chain.
 */
export interface DetailCalloutSpecAtomInstance extends BaseAtomInstance {
  entityType: "detail-callout-spec";
  /** Engagement this callout spec belongs to. */
  engagementId: string;
  /** Detail-type-specific spec payload (discriminated on `detailType`). */
  spec: DetailCalloutSpec;
  /** Push lifecycle state. */
  pushState: DetailCalloutPushState;
  /**
   * APS Design Automation work-item ref. Opaque to the engine — the
   * Revit Connector populates it once `pushState` reaches `"pushed"`.
   * Null while `pending`.
   */
  apsTaskRef: string | null;
  /** Source finding entityId that drove this callout. Null if not finding-driven. */
  findingId: string | null;
  /** Source response-task entityId. Null if not task-driven. */
  responseTaskId: string | null;
  /** ISO-8601 timestamp the spec was created. */
  createdAt: string;
  /** ISO-8601 timestamp the spec entered `"pushed"`. Null otherwise. */
  pushedAt: string | null;
  /** Architect / staff member who authored the callout spec (ADR-015). */
  actorId: string | null;
  /** Actor accountable for the engagement; may differ from `actorId`. */
  principalActorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

const WALL_ASSEMBLY_LAYER_SCHEMA = z.object({
  material: z.string(),
  thickness: z.string(),
  function: z.string(),
});

/**
 * Zod discriminated union mirroring `DetailCalloutSpec`. The
 * `detailType` discriminant selects the arm; an unknown detailType or
 * a payload that doesn't match its arm fails validation.
 */
export const DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA = z.discriminatedUnion(
  "detailType",
  [
    z.object({
      detailType: z.literal("door-schedule"),
      rows: z.array(
        z.object({
          doorMark: z.string(),
          doorType: z.string(),
          width: z.string(),
          height: z.string(),
          material: z.string(),
          fireRating: z.string(),
          hardwareSet: z.string(),
        }),
      ),
    }),
    z.object({
      detailType: z.literal("wall-section"),
      sectionMark: z.string(),
      cutLocation: z.string(),
      assemblyLayers: z.array(WALL_ASSEMBLY_LAYER_SCHEMA),
      baseDatum: z.string(),
      topDatum: z.string(),
    }),
    z.object({
      detailType: z.literal("wall-type"),
      typeMark: z.string(),
      assemblyLayers: z.array(WALL_ASSEMBLY_LAYER_SCHEMA),
      fireRating: z.string(),
      stcRating: z.string(),
    }),
    z.object({
      detailType: z.literal("room-finish"),
      roomName: z.string(),
      roomNumber: z.string(),
      floorFinish: z.string(),
      baseFinish: z.string(),
      wallFinish: z.string(),
      ceilingFinish: z.string(),
      ceilingHeight: z.string(),
    }),
  ],
);

/**
 * Zod schema mirroring `DetailCalloutSpecAtomInstance`. Canonical
 * boundary-validation surface for L4 cross-repo consumers (the Revit
 * Connector add-in + the MCP tool + the UI).
 */
export const DETAIL_CALLOUT_SPEC_SCHEMA = z.object({
  entityType: z.literal("detail-callout-spec"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  engagementId: z.string().min(1),
  spec: DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA,
  pushState: z.enum(["pending", "pushed", "applied", "rejected-by-user"]),
  apsTaskRef: z.string().nullable(),
  findingId: z.string().nullable(),
  responseTaskId: z.string().nullable(),
  createdAt: z.string().min(1),
  pushedAt: z.string().nullable(),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// ---------------------------------------------------------------------------
// L5 — `product-spec-reference` atom
// ---------------------------------------------------------------------------
//
// A reference to a specific ICC-ES-evaluated product spec (e.g. ESR-1234
// for a rated connector or assembly), carrying the live ICC-ES status.
//
// Live verification per the 2026-05-19 Lane A.2 dispatch: v1 is a
// periodic re-poll against the ICC-ES site (not a real-time webhook).
// The poller is runtime-layer work (legacy-design-tools per Sprint
// Amendment 6), NOT atom-shape scope — the atom just carries the
// current `status` + `lastVerifiedAt`, and the poller writes status
// changes as new atom versions per ADR-011 (same DID, new CID).
//
// The atom also carries an inline `statusHistory` — an append-only
// ESR-status-change chain — so a consumer holding a single atom
// version can see the transition history without walking the version
// chain. The array is always present; an empty array means "no
// history recorded yet".

/**
 * ICC-ES evaluation status. Mirrors the ICC-ES public surface:
 *   - `active`    — the ESR is current and in good standing.
 *   - `withdrawn` — the report has been withdrawn by ICC-ES.
 *   - `expired`   — the report's evaluation period has lapsed.
 */
export type ProductSpecStatus = "active" | "withdrawn" | "expired";

export const PRODUCT_SPEC_STATUSES: ReadonlyArray<ProductSpecStatus> = [
  "active",
  "withdrawn",
  "expired",
];

/**
 * ESR-number format guard. ICC-ES Evaluation Service Reports are
 * numbered `ESR-` followed by digits (e.g. `ESR-1234`, `ESR-2929`).
 */
export const ESR_NUMBER_RE = /^ESR-\d+$/;

/** Structured product identity — never free-text. */
export interface ProductIdentifier {
  /** Product name (e.g. "Strong-Drive SDWS Timber Screw"). */
  name: string;
  /** Manufacturer (e.g. "Simpson Strong-Tie"). */
  manufacturer: string;
}

/**
 * One entry in the ESR-status-change chain — a status observed by the
 * poller at a point in time, with the ICC-ES URL it was verified
 * against. Append-only; the newest entry's `status` equals the atom's
 * current `status`.
 */
export interface ProductSpecStatusChange {
  status: ProductSpecStatus;
  /** ISO-8601 timestamp the status was observed. */
  changedAt: string;
  /** ICC-ES URL this status was verified against at this transition. */
  sourceUrl: string;
}

/**
 * L5 — `product-spec-reference` atom.
 *
 * Reference to an ICC-ES-evaluated product spec with live status. When
 * the poller detects a status change upstream it writes a new atom
 * version (ADR-011) and appends to `statusHistory`; downstream findings
 * that cite the product flag on a non-`active` status.
 *
 * The inherited `BaseAtomInstance.sourceUrl` carries the ICC-ES listing
 * URL the current `status` was verified against (the dispatch's
 * `source_url`); per-transition URLs live in `statusHistory[].sourceUrl`.
 */
export interface ProductSpecReferenceAtomInstance extends BaseAtomInstance {
  entityType: "product-spec-reference";
  /** Structured product identity. */
  product: ProductIdentifier;
  /** ICC-ES ESR number (format `ESR-<digits>`). */
  esrNumber: string;
  /** Current ICC-ES evaluation status. */
  status: ProductSpecStatus;
  /** ISO-8601 timestamp the status was last verified by the poller. */
  lastVerifiedAt: string;
  /**
   * Append-only ESR-status-change chain. Always present; empty until
   * the first verification is recorded. The newest entry's `status`
   * mirrors the atom's current `status`.
   */
  statusHistory: ReadonlyArray<ProductSpecStatusChange>;
  /** Engagement this product reference belongs to. Null if catalog-wide. */
  engagementId: string | null;
  /** Source finding entityId that referenced this product. Null otherwise. */
  findingId: string | null;
  /** Source response-task entityId. Null otherwise. */
  responseTaskId: string | null;
  /** ISO-8601 timestamp the reference was created. */
  createdAt: string;
  /** Architect / staff member who added the product reference (ADR-015). */
  actorId: string | null;
  /** Actor accountable for the engagement; may differ from `actorId`. */
  principalActorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

/**
 * Zod schema mirroring `ProductSpecReferenceAtomInstance`. Canonical
 * boundary-validation surface for L5 cross-repo consumers (the ICC-ES
 * poller, the MCP tool, the UI). The `esrNumber` is format-validated.
 */
export const PRODUCT_SPEC_REFERENCE_SCHEMA = z.object({
  entityType: z.literal("product-spec-reference"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  product: z.object({
    name: z.string().min(1),
    manufacturer: z.string().min(1),
  }),
  esrNumber: z.string().regex(ESR_NUMBER_RE, {
    message: "esrNumber must match ESR-<digits> (e.g. ESR-1234)",
  }),
  status: z.enum(["active", "withdrawn", "expired"]),
  lastVerifiedAt: z.string().min(1),
  statusHistory: z.array(
    z.object({
      status: z.enum(["active", "withdrawn", "expired"]),
      changedAt: z.string().min(1),
      sourceUrl: z.string(),
    }),
  ),
  engagementId: z.string().nullable(),
  findingId: z.string().nullable(),
  responseTaskId: z.string().nullable(),
  createdAt: z.string().min(1),
  actorId: z.string().nullable(),
  principalActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

// ---------------------------------------------------------------------------
// L6 — `deliverable-letter-render` atom
// ---------------------------------------------------------------------------
//
// The rendered output (DOCX / PDF) of an L3 `deliverable-letter`, as a
// first-class atom rather than an ephemeral byte side-effect. Planner
// architectural call per Sprint Amendment 6: render output IS an atom.
// Rationale — the Hauska atom-first thesis ("sell reasoning, not data;
// every output queryable with reasoning chain + source citation +
// timestamp"). A render is an output, so it is first-class queryable,
// enabling "show all renders of this letter" audit queries.
//
// Renders are 1-to-many off L3: a sent letter can be re-rendered
// (format change, recipient lost the original, source-letter version
// update). `sourceLetterVersion` pins exactly which version of the
// source letter a given render was produced against.

/**
 * Render output format. Lowercase to match the kebab-case enum
 * convention used across this package's atom shapes. Extensible v1
 * set — a new format adds a union member + a Zod-enum arm.
 */
export type RenderFormat = "docx" | "pdf";

export const RENDER_FORMATS: ReadonlyArray<RenderFormat> = ["docx", "pdf"];

/**
 * DID-prefix guard for `sourceLetterRef` — the ref must point at a
 * `deliverable-letter` atom (`did:hauska:deliverable-letter:<localId>`).
 */
export const DELIVERABLE_LETTER_DID_RE = /^did:hauska:deliverable-letter:.+/;

/**
 * L6 — `deliverable-letter-render` atom.
 *
 * The rendered DOCX/PDF artifact of an L3 `deliverable-letter`. The
 * atom carries a reference to the stored bytes (`blobRef`), never the
 * bytes themselves — storage details (GCS object key, signed-URL
 * pattern, retention) are runtime-layer concerns per Sprint
 * Amendment 6.
 */
export interface DeliverableLetterRenderAtomInstance extends BaseAtomInstance {
  entityType: "deliverable-letter-render";
  /**
   * `did:hauska:deliverable-letter:<localId>` ref to the L3
   * `deliverable-letter` atom this render is derived from.
   */
  sourceLetterRef: string;
  /**
   * The source letter atom's `contentHash` at render time. Pins which
   * version was rendered — distinguishes re-renders of an updated
   * letter and preserves rendered-against-which-version provenance
   * explicitly (ADR-011: contentHash maps to the per-version CID).
   */
  sourceLetterVersion: string;
  /** Output format. */
  format: RenderFormat;
  /**
   * Opaque pointer to the stored render bytes. Storage details are
   * runtime-layer; the atom carries the reference, not the bytes.
   */
  blobRef: string;
  /** ISO-8601 timestamp the render was produced. */
  renderedAt: string;
  /** Actor who triggered the render (ADR-015). Null for system renders. */
  renderedByActorId: string | null;
  /** Access tier per ADR-017. Default `"tenant-private"`. */
  accessPolicy?: AccessPolicy;
}

/**
 * Zod schema mirroring `DeliverableLetterRenderAtomInstance`. Canonical
 * boundary-validation surface for L6 cross-repo consumers. The
 * `sourceLetterRef` is prefix-validated against the deliverable-letter
 * DID shape.
 */
export const DELIVERABLE_LETTER_RENDER_SCHEMA = z.object({
  entityType: z.literal("deliverable-letter-render"),
  entityId: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  sourceLetterRef: z.string().regex(DELIVERABLE_LETTER_DID_RE, {
    message:
      "sourceLetterRef must be a did:hauska:deliverable-letter:<localId> ref",
  }),
  sourceLetterVersion: z.string().min(1),
  format: z.enum(["docx", "pdf"]),
  blobRef: z.string().min(1),
  renderedAt: z.string().min(1),
  renderedByActorId: z.string().nullable(),
  accessPolicy: ACCESS_POLICY_SCHEMA,
});

/**
 * Union of Cortex (L-surface) atom instances — complete L1-L6 set.
 */
export type CortexAtomInstance =
  | ResponseTaskAtomInstance
  | SheetContentExtractionAtomInstance
  | AttachedDocumentAtomInstance
  | DeliverableLetterAtomInstance
  | DetailCalloutSpecAtomInstance
  | ProductSpecReferenceAtomInstance
  | DeliverableLetterRenderAtomInstance;

export type CortexAtomEntityType = CortexAtomInstance["entityType"];

export const CORTEX_ATOM_ENTITY_TYPES: ReadonlyArray<CortexAtomEntityType> = [
  "response-task",
  "sheet-content-extraction",
  "attached-document",
  "deliverable-letter",
  "detail-callout-spec",
  "product-spec-reference",
  "deliverable-letter-render",
];

/**
 * Every atom instance the engine atom-registry knows — code-corpus
 * (Bump 1) plus Cortex L-surface atoms. Storage / retrieval / registry
 * consumers key off this union.
 */
export type AtomInstance = CodeAtomInstance | CortexAtomInstance;

export type AtomEntityType = AtomInstance["entityType"];
