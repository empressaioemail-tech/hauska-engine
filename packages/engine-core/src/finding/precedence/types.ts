/**
 * ADR-019 / ADR-021 precedence types for the spine-wide reconciliation
 * primitive. Callable from finding-engine, briefing-engine, or MCP
 * wrappers — not plan-review-only.
 */

import type { FindingCitation } from "../types";

/** Authority tier per ADR-019 layered substrate + ADR-021 v1 rules. */
export type StandardAuthority =
  | "federal"
  | "model-code"
  | "local-amendment"
  | "private-advisory";

/**
 * Deterministic precedence rule applied by the resolver.
 *
 * `federal-preempts-where-applicable` is cross-tier only: federal displacing
 * model-code/state/local and leaving a single governing federal standard.
 * Intra-tier selection among co-applicable standards of the same tier (including
 * two federal standards) reports `most-stringent-governs`; the federal-preempt
 * step remains in `reasoningChain` when model-code was dropped from the pool.
 */
export type PrecedenceRuleApplied =
  | "single-source"
  | "federal-preempts-where-applicable"
  | "local-amendment-overlays-model-code"
  | "most-stringent-governs"
  | "conflict-unresolved";

/** Domain hint — drives default rule selection per ADR-021. */
export type PrecedenceDomain =
  | "accessibility"
  | "life-safety"
  | "dimensional"
  | "general";

/** How a numeric requirement compares for stringency. */
export type RequirementKind = "minimum" | "maximum" | "exact" | "qualitative";

/**
 * One applicable requirement from a standard on a shared topic/dimension.
 * Carries citation + confidence + atomId lineage for arrow-two ledger.
 */
export interface ApplicableRequirement {
  /** code-section atom id — preserved through reconciliation. */
  atomId: string;
  /** Stable standard key, e.g. `ada-2010`, `fha-design-manual`, `a117.1-2021`. */
  standardKey: string;
  /** Human label for reasoning chain output. */
  standardLabel: string;
  authority: StandardAuthority;
  /** Shared topic key grouping competing requirements, e.g. `door-maneuvering-clearance`. */
  topic: string;
  /** Short dimension label surfaced in findings, e.g. `latch-side clearance`. */
  dimension: string;
  requirementKind: RequirementKind;
  /** Numeric value when comparable (inches, percent, etc.). */
  numericValue?: number;
  numericUnit?: string;
  /** Qualitative requirement text when not numeric. */
  textValue?: string;
  /** Citation chip label. */
  citationLabel: string;
  snippet?: string;
  /** Source confidence — min-of-compared propagates to result per arrow-two Phase 1. */
  confidence: number;
  /** When authority is local-amendment, the model-code atomId this overlays. */
  overlaysAtomId?: string;
}

export interface PrecedenceConflict {
  topic: string;
  competingAtomIds: readonly string[];
  status: "resolved" | "unresolved";
  resolutionNote: string;
}

/**
 * Output of {@link reconcileStandardPrecedence}. Every compared standard
 * appears in `compared` + `citations`; conflicts are never silent.
 */
export interface PrecedenceReconciliationResult {
  topic: string;
  dimension: string;
  governing: ApplicableRequirement;
  /** Every requirement considered, including non-governing. */
  compared: readonly ApplicableRequirement[];
  ruleApplied: PrecedenceRuleApplied;
  /** Machine-auditable reasoning chain (one sentence per step). */
  reasoningChain: readonly string[];
  conflicts: readonly PrecedenceConflict[];
  /** Citation union for all standards compared — atomId lineage preserved. */
  citations: readonly FindingCitation[];
  confidence: number;
  evaluatedAt: Date;
}

export interface ReconcileStandardPrecedenceOptions {
  domain?: PrecedenceDomain;
  /** Federal preempts model-code when true; defaults true for accessibility/life-safety. */
  federalPreempts?: boolean;
  evaluatedAt?: Date;
}

export interface ReconcileRequirementsByTopicInput {
  requirements: readonly ApplicableRequirement[];
  options?: ReconcileStandardPrecedenceOptions;
}

export interface ReconcileRequirementsByTopicResult {
  reconciliations: readonly PrecedenceReconciliationResult[];
  /** Topics with fewer than two requirements — passed through unchanged. */
  uncontested: readonly ApplicableRequirement[];
}
