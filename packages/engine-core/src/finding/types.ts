/**
 * Public types for the AIR-1 finding engine. Defined here (rather than
 * at the call site) so the api-server route, tests, and downstream
 * renderers share a single contract surface.
 *
 * These types deliberately mirror the FE wire shape locked at
 * `artifacts/plan-review/src/lib/findingsMock.ts:39-103` so the V1-6
 * frontend swap collapses to a single re-export change. A typecheck-
 * only equivalence test pins them to the FE mock.
 *
 * The engine returns ZERO OR MORE findings on every successful call:
 * a submission with no compliance issues yields an empty array. The
 * route distinguishes "engine ran cleanly, found nothing" from
 * "engine errored" by reading the run row's `state` (`completed` vs
 * `failed`); the empty-findings list itself is never an error.
 */

import type { PlanReviewDiscipline } from "../types/planReviewDiscipline.js";
import type { PlanSetPieceInput } from "./planSet/types";

/**
 * Severity rubric (`findingsMock.ts:41`):
 *   - blocker  — code violation requiring resolution before approval
 *   - concern  — ambiguity or risk
 *   - advisory — preference / coordination note
 */
export const FINDING_SEVERITY_VALUES = [
  "blocker",
  "concern",
  "advisory",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY_VALUES)[number];

/**
 * FIXED v1 category enum (`findingsMock.ts:48-56`). Adding a category
 * is an event-modeled schema change, not a silent extension — keep
 * this tuple in lock-step with the schema-side enum at
 * `lib/db/src/schema/findings.ts`.
 */
export const FINDING_CATEGORY_VALUES = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORY_VALUES)[number];

export const FINDING_STATUS_VALUES = [
  "ai-produced",
  "accepted",
  "rejected",
  "overridden",
  "promoted-to-architect",
] as const;
export type FindingStatus = (typeof FINDING_STATUS_VALUES)[number];

/** LLM provider modes selected by `AIR_FINDING_LLM_MODE`. */
export type FindingLlmMode = "mock" | "grok" | "anthropic";

/**
 * Discriminated citation union mirroring `findingsMock.ts:65-74`. The
 * engine emits these inline in the finding's `text` as `[[CODE:atomId]]`
 * (code-section) or `{{atom|briefing-source|<id>|<label>}}`
 * (briefing-source) tokens, AND echoes the parsed list verbatim on the
 * Finding row's `citations` jsonb column so consumers can render
 * citation chips without re-parsing the body.
 */
export interface FindingCodeCitation {
  kind: "code-section";
  atomId: string;
}

export interface FindingSourceCitation {
  kind: "briefing-source";
  id: string;
  label: string;
}

export type FindingCitation = FindingCodeCitation | FindingSourceCitation;

/**
 * One code-section atom the engine may cite. The engine does NOT
 * fetch atoms itself — the caller (the api-server route) retrieves a
 * jurisdiction-scoped top-K via `lib/codes/retrieval` and hands them
 * in. Mirrors `briefing-engine`'s CodeSectionInput contract.
 */
/** One deeplink source on a reasoning/citation atom (multi-link UPSERT). */
export interface ReasoningSourceLink {
  url: string;
  sourceName: string;
  edition: string;
  retrievedAt: string;
  verified: boolean;
}

/** Reasoning-atom provenance — deeplink citation UX; not corpus UUID atoms. */
export interface CodeSectionWebProvenance {
  sourceUrl: string;
  /** All persisted source deeplinks (read-inline citation chips). */
  sources?: ReasoningSourceLink[];
  retrievedAt: string;
  edition: string;
  verified: boolean;
  confidence: number;
  sourceName: string;
  verificationState?: "verified" | "unverified-web-source";
  /** Seam for future ICC Code Connect / NFPA licensed display — default deeplink. */
  displayMode?: "deeplink" | "licensed";
  unverifiedWebSource?: boolean;
}

export interface CodeSectionInput {
  /** The atom id used in `[[CODE:<atomId>]]` tokens. */
  atomId: string;
  /** Short human label rendered in citation chips. */
  label: string;
  /** Optional snippet the prompt may quote. */
  snippet?: string;
  /** Present on `reasoning:` / legacy `websearch:` ids — deeplink citation provenance. */
  webProvenance?: CodeSectionWebProvenance;
}

/**
 * One briefing-source row the engine may cite. Mirrors
 * `briefing-engine`'s BriefingSourceInput shape — keeping the field
 * names identical means a single shared resolver lookup populates both
 * engines without per-engine adapters.
 */
export interface BriefingSourceInput {
  /** Stable id used in `{{atom|briefing-source|<id>|<label>}}` tokens. */
  id: string;
  /** Layer slug — e.g. `qgis-zoning`, `fema-flood`. */
  layerKind: string;
  /** Producer flavor (`manual-upload` or `federal-adapter`). */
  sourceKind: string;
  /** Human-readable provider, used as the citation displayLabel fallback. */
  provider: string | null;
  /** Effective date of the data, ISO-8601 string. */
  snapshotDate: string;
  /** Optional free-text producer note. */
  note: string | null;
}

/**
 * Submission envelope the engine reads. Carries the project metadata
 * the prompt surfaces in the `<submission>` block + the engagement-
 * resolved jurisdiction key the prompt uses to scope expectations.
 *
 * Stays a flat record (not the full submissions row) so the engine is
 * not coupled to lib/db's schema shape — the caller projects the
 * relevant columns at call time.
 */
export interface SubmissionInput {
  id: string;
  jurisdiction: string | null;
  projectName: string | null;
  /** Optional submission note authored at submit time. */
  note: string | null;
}

/**
 * One BIM-model element the engine may anchor a finding on via
 * `elementRef`. Carries enough to render in the prompt's
 * `<bim_elements>` block and let the model pick the right one.
 */
export interface BimElementInput {
  /** Opaque pointer the FE drill-in resolves to a viewport selection. */
  ref: string;
  /** Short human label (e.g. `"North wall, L2"`). */
  label: string;
  /** Optional one-line description. */
  description?: string;
}

/** Engine input bundle. */
export interface GenerateFindingsInput {
  submission: SubmissionInput;
  /** Optional brief narrative the engine may quote in its findings. */
  briefingNarrative?: string;
  sources: ReadonlyArray<BriefingSourceInput>;
  codeSections: ReadonlyArray<CodeSectionInput>;
  bimElements: ReadonlyArray<BimElementInput>;
  /**
   * WS1 — classified plan-set pieces scoped to this specialist pass.
   * Populated by the orchestrated conductor; omitted on legacy single-pass.
   */
  planSetPieces?: ReadonlyArray<PlanSetPieceInput>;
  /**
   * WS1 — when set, this pass is a per-discipline specialist run.
   * Surfaces in the prompt so the model stays within discipline scope.
   */
  disciplineScope?: PlanReviewDiscipline;
  /**
   * P2 — optional per-sheet PNG images for Claude Opus vision read.
   * Threaded through the orchestrator; consumed by visionSheetRead before Grok synthesis.
   */
  attachedSheetImages?: ReadonlyArray<{
    pieceId: string;
    pngBase64: string;
    label?: string;
  }>;
}

/**
 * One finding the engine produced. Wire-equivalent to the FE mock's
 * Finding shape, minus the review-state fields the engine never
 * authors (status / reviewerStatusBy / reviewerStatusChangedAt /
 * reviewerComment / revisionOf — these are reviewer mutations applied
 * after the engine settles). The route's persistence layer fills
 * those in at insert time.
 */
export interface EngineFinding {
  /** Atom id `finding:{submissionId}:{ulid}` — see findings.ts schema. */
  atomId: string;
  submissionId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /**
   * Free-text body containing inline citation tokens. The validator
   * has already run by this point — every token in `text` resolves
   * against `citations`, and stripped tokens are reflected in
   * {@link GenerateFindingsResult.invalidCitations}.
   */
  text: string;
  citations: FindingCitation[];
  confidence: number;
  lowConfidence: boolean;
  /** Optional BIM-element pointer (e.g. `"wall:north-side-l2"`). */
  elementRef: string | null;
  /** Optional pointer at the backing briefing source. */
  sourceRef: { id: string; label: string } | null;
  /**
   * When the finding was generated. Stamped at engine-call time so
   * the value survives a delayed persist.
   */
  aiGeneratedAt: Date;
  /**
   * WS1 — discipline tag when produced by the orchestrated specialist pass.
   * Null/omitted on legacy single-pass rows.
   */
  discipline?: PlanReviewDiscipline | null;
}

/** Successful engine output. */
export interface GenerateFindingsResult {
  findings: EngineFinding[];
  /**
   * Verbatim citation tokens the engine emitted that did NOT resolve
   * to a known source/code-section — mirrors briefing-engine's
   * `invalidCitations`. Length equals the engine's
   * invalid-citation count. Stripped tokens stay out of the
   * persisted `text`.
   */
  invalidCitations: ReadonlyArray<string>;
  /**
   * Findings the engine produced that the post-validation discard
   * rule dropped entirely (every citation invalid AND no surviving
   * elementRef AND text length < {@link FINDING_MIN_TEXT_LENGTH}).
   * Distinct dimension from invalidCitations — see `findingRuns.ts`
   * column docstring. Carried as the trimmed text the model emitted
   * so the auditor can see what was dropped.
   */
  discardedFindings: ReadonlyArray<{
    severity: FindingSeverity;
    category: FindingCategory;
    text: string;
    reason: "no_valid_citations_or_anchor" | "text_too_short";
  }>;
  /** Pass-through of the engine clock at call time. */
  generatedAt: Date;
  /** `mock` or `anthropic` — useful for tests + observability. */
  producer: FindingLlmMode;
}

/**
 * Minimum length (in chars) a finding's `text` must retain after
 * citation stripping for the finding to survive the discard rule.
 *
 * The discard policy (per Phase 1A approval) is:
 *   "A finding must retain ≥1 valid citation OR an `elementRef` AND
 *    text length >= FINDING_MIN_TEXT_LENGTH to survive."
 *
 * 50 chars is the crossover between "this is still a meaningful
 * sentence with one or two punchy claims" and "the model emitted a
 * scrap that does not stand on its own". Tuned against the mock
 * fixture's shortest finding (the advisory at findingsMock.ts:204-208,
 * ~143 chars) — we want short-but-substantive findings to survive,
 * not raw fragments.
 *
 * Exported as a named constant so the threshold is reviewable and
 * the discard rule's "≥1 valid anchor AND >= threshold" contract is
 * documented next to the value.
 */
export const FINDING_MIN_TEXT_LENGTH = 50;
