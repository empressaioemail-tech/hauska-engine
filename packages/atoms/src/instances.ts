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

/**
 * Union of Cortex (L-surface) atom instances. Grows as L2-L6 land.
 */
export type CortexAtomInstance = ResponseTaskAtomInstance;

export type CortexAtomEntityType = CortexAtomInstance["entityType"];

export const CORTEX_ATOM_ENTITY_TYPES: ReadonlyArray<CortexAtomEntityType> = [
  "response-task",
];

/**
 * Every atom instance the engine atom-registry knows — code-corpus
 * (Bump 1) plus Cortex L-surface atoms. Storage / retrieval / registry
 * consumers key off this union.
 */
export type AtomInstance = CodeAtomInstance | CortexAtomInstance;

export type AtomEntityType = AtomInstance["entityType"];
