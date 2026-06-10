/**
 * ADR-019 / ADR-021 deterministic precedence resolver.
 *
 * When multiple standards or code sections apply to the same requirement,
 * resolves which governs with a full reasoning chain and citations to every
 * standard compared — never a silent pick.
 */

import type { FindingCitation } from "../types";
import { allAlign, compareStringency, pickMostStringent } from "./comparability";
import type {
  ApplicableRequirement,
  PrecedenceConflict,
  PrecedenceDomain,
  PrecedenceReconciliationResult,
  PrecedenceRuleApplied,
  ReconcileRequirementsByTopicInput,
  ReconcileRequirementsByTopicResult,
  ReconcileStandardPrecedenceOptions,
  StandardAuthority,
} from "./types";

const AUTHORITY_RANK: Readonly<Record<StandardAuthority, number>> = {
  federal: 0,
  "model-code": 1,
  "local-amendment": 2,
  "private-advisory": 3,
};

function defaultFederalPreempts(domain: PrecedenceDomain): boolean {
  return domain === "accessibility" || domain === "life-safety";
}

function toCitations(requirements: readonly ApplicableRequirement[]): FindingCitation[] {
  return requirements.map((r) => ({
    kind: "code-section" as const,
    atomId: r.atomId,
  }));
}

function minConfidence(requirements: readonly ApplicableRequirement[]): number {
  if (requirements.length === 0) return 0;
  return Math.min(...requirements.map((r) => r.confidence));
}

/**
 * Apply local-amendment overlay on model-code base per ADR-019 Layer 2.
 * Returns effective model-code pool with overlay values replacing base
 * dimensions where an overlay targets the same topic.
 */
function applyLocalOverlay(
  modelCode: ApplicableRequirement[],
  localAmendments: ApplicableRequirement[],
): {
  effective: ApplicableRequirement[];
  overlayApplied: boolean;
  reasoning: string[];
} {
  if (localAmendments.length === 0) {
    return { effective: modelCode, overlayApplied: false, reasoning: [] };
  }
  if (modelCode.length === 0) {
    return {
      effective: localAmendments,
      overlayApplied: true,
      reasoning: [
        "Local amendment applies with no model-code base in the compared set.",
      ],
    };
  }

  const reasoning: string[] = [];
  const effective: ApplicableRequirement[] = [];
  const overlaysByTopic = new Map<string, ApplicableRequirement[]>();
  for (const amend of localAmendments) {
    const key = amend.topic;
    const list = overlaysByTopic.get(key) ?? [];
    list.push(amend);
    overlaysByTopic.set(key, list);
  }

  for (const base of modelCode) {
    const overlays = overlaysByTopic.get(base.topic) ?? [];
    const targeted = overlays.filter(
      (o) => !o.overlaysAtomId || o.overlaysAtomId === base.atomId,
    );
    if (targeted.length === 0) {
      effective.push(base);
      continue;
    }
    const overlayPick = pickMostStringent(targeted);
    if (overlayPick) {
      effective.push(overlayPick.governing);
      reasoning.push(
        `Local amendment ${overlayPick.governing.citationLabel} overlays model-code base ${base.citationLabel} on topic "${base.topic}".`,
      );
    }
  }

  for (const amend of localAmendments) {
    const hasBase = modelCode.some((b) => b.topic === amend.topic);
    if (!hasBase) effective.push(amend);
  }

  return {
    effective,
    overlayApplied: reasoning.length > 0 || localAmendments.length > 0,
    reasoning,
  };
}

function detectConflicts(
  pool: readonly ApplicableRequirement[],
  governing: ApplicableRequirement,
  resolved: boolean,
): PrecedenceConflict[] {
  if (pool.length < 2) return [];

  const competingAtomIds = pool.map((r) => r.atomId);
  if (resolved && allAlign(pool)) {
    return [
      {
        topic: governing.topic,
        competingAtomIds,
        status: "resolved",
        resolutionNote: `Standards align on ${governing.dimension}; ${governing.standardLabel} cited as governing with full comparison chain.`,
      },
    ];
  }

  const incomparable = pool.filter((r) => {
    if (r.atomId === governing.atomId) return false;
    const cmp = compareStringency(r, governing);
    return !cmp.comparable;
  });

  if (incomparable.length > 0 && !resolved) {
    return [
      {
        topic: governing.topic,
        competingAtomIds,
        status: "unresolved",
        resolutionNote: `Incomparable requirements remain across ${incomparable.map((r) => r.standardLabel).join(", ")}; human review required per ADR-021 rule 5.`,
      },
    ];
  }

  return [
    {
      topic: governing.topic,
      competingAtomIds,
      status: "resolved",
      resolutionNote: `Governing requirement selected: ${governing.citationLabel} (${governing.standardLabel}).`,
    },
  ];
}

function buildReasoningChain(
  compared: readonly ApplicableRequirement[],
  governing: ApplicableRequirement,
  ruleApplied: PrecedenceRuleApplied,
  extraSteps: readonly string[],
): string[] {
  const standardsListed = compared
    .map((r) => `${r.standardLabel} [[CODE:${r.atomId}]]`)
    .join("; ");
  const chain = [
    `Compared ${compared.length} applicable standards on topic "${governing.topic}" (${governing.dimension}): ${standardsListed}.`,
    ...extraSteps,
    `Precedence rule applied: ${ruleApplied}.`,
    `Governing requirement: ${governing.citationLabel} (${governing.standardLabel}) — ${governing.dimension}.`,
  ];
  return chain;
}

/**
 * Resolve precedence among two or more requirements on the same topic.
 * Returns null when fewer than two requirements are supplied.
 */
export function reconcileStandardPrecedence(
  requirements: readonly ApplicableRequirement[],
  options: ReconcileStandardPrecedenceOptions = {},
): PrecedenceReconciliationResult | null {
  if (requirements.length === 0) return null;

  const domain: PrecedenceDomain = options.domain ?? "general";
  const federalPreempts =
    options.federalPreempts ?? defaultFederalPreempts(domain);
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const topic = requirements[0]!.topic;
  const dimension = requirements[0]!.dimension;

  if (requirements.length === 1) {
    const sole = requirements[0]!;
    return {
      topic,
      dimension,
      governing: sole,
      compared: requirements,
      ruleApplied: "single-source",
      reasoningChain: [
        `Single applicable standard on topic "${topic}": ${sole.standardLabel} [[CODE:${sole.atomId}]].`,
        "No precedence reconciliation required.",
      ],
      conflicts: [],
      citations: toCitations(requirements),
      confidence: sole.confidence,
      evaluatedAt,
    };
  }

  const federal = requirements.filter((r) => r.authority === "federal");
  const modelCode = requirements.filter((r) => r.authority === "model-code");
  const localAmendments = requirements.filter(
    (r) => r.authority === "local-amendment",
  );
  const privateAdvisory = requirements.filter(
    (r) => r.authority === "private-advisory",
  );

  const reasoningSteps: string[] = [];
  let ruleApplied: PrecedenceRuleApplied = "most-stringent-governs";
  let decisionPool: ApplicableRequirement[] = [];
  let federalPreemptApplied = false;

  const { effective: effectiveModel, overlayApplied, reasoning: overlayReasoning } =
    applyLocalOverlay(modelCode, localAmendments);
  reasoningSteps.push(...overlayReasoning);

  if (overlayApplied && effectiveModel.length > 0) {
    ruleApplied = "local-amendment-overlays-model-code";
    reasoningSteps.push(
      "Effective model-code value computed as base plus local amendment overlay per ADR-019 Layer 2.",
    );
  }

  if (federal.length > 0 && federalPreempts && effectiveModel.length > 0) {
    federalPreemptApplied = true;
    decisionPool = [...federal];
    reasoningSteps.push(
      `Federal standards (${federal.map((r) => r.standardLabel).join(", ")}) preempt model-code (${effectiveModel.map((r) => r.standardLabel).join(", ")}) for ${domain} domain.`,
    );
  } else if (federal.length > 0) {
    decisionPool = [...federal, ...effectiveModel];
    reasoningSteps.push(
      "Federal and model-code requirements both remain in the decision pool (federal preempt not triggered for this domain).",
    );
  } else {
    decisionPool = [...effectiveModel, ...privateAdvisory];
  }

  if (
    domain === "accessibility" ||
    domain === "life-safety" ||
    domain === "dimensional"
  ) {
    if (decisionPool.length >= 2) {
      // Intra-tier stringency contest — including co-applicable federal standards.
      ruleApplied = "most-stringent-governs";
    } else if (federalPreemptApplied) {
      // Cross-tier preemption left a single governing federal standard.
      ruleApplied = "federal-preempts-where-applicable";
    } else if (overlayApplied) {
      ruleApplied = "local-amendment-overlays-model-code";
    } else {
      ruleApplied = "most-stringent-governs";
    }
    reasoningSteps.push(
      "Most-stringent-governs applied within the decision pool for accessibility/life-safety/dimensional limits.",
    );
  }

  const stringentPick = pickMostStringent(decisionPool);
  if (!stringentPick) {
    return {
      topic,
      dimension,
      governing: requirements[0]!,
      compared: requirements,
      ruleApplied: "conflict-unresolved",
      reasoningChain: buildReasoningChain(
        requirements,
        requirements[0]!,
        "conflict-unresolved",
        [
          "Could not deterministically compare requirements — incomparable values or kinds.",
        ],
      ),
      conflicts: detectConflicts(requirements, requirements[0]!, false),
      citations: toCitations(requirements),
      confidence: minConfidence(requirements),
      evaluatedAt,
    };
  }

  let governing = stringentPick.governing;

  if (decisionPool.length > 1) {
    const runnerUp = decisionPool.find((r) => r.atomId !== governing.atomId);
    if (runnerUp) {
      const cmp = compareStringency(governing, runnerUp);
      if (!cmp.comparable) {
        ruleApplied = "conflict-unresolved";
        reasoningSteps.push(cmp.note);
        return {
          topic,
          dimension,
          governing,
          compared: requirements,
          ruleApplied,
          reasoningChain: buildReasoningChain(
            requirements,
            governing,
            ruleApplied,
            reasoningSteps,
          ),
          conflicts: detectConflicts(requirements, governing, false),
          citations: toCitations(requirements),
          confidence: minConfidence(requirements),
          evaluatedAt,
        };
      }
      if (cmp.delta === 0) {
        reasoningSteps.push(
          `Competing standards agree on numeric requirement; ${governing.standardLabel} selected as governing citation (authority rank ${AUTHORITY_RANK[governing.authority]}).`,
        );
        const byRank = [...decisionPool].sort(
          (a, b) => AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority],
        );
        governing = byRank[0] ?? governing;
      } else {
        reasoningSteps.push(stringentPick.note);
      }
    }
  }

  const aligned = allAlign(requirements);
  const conflicts = detectConflicts(requirements, governing, aligned || decisionPool.length > 0);

  return {
    topic,
    dimension,
    governing,
    compared: requirements,
    ruleApplied,
    reasoningChain: buildReasoningChain(
      requirements,
      governing,
      ruleApplied,
      reasoningSteps,
    ),
    conflicts,
    citations: toCitations(requirements),
    confidence: minConfidence(requirements),
    evaluatedAt,
  };
}

/** Group requirements by topic and reconcile each group independently. */
export function reconcileRequirementsByTopic(
  input: ReconcileRequirementsByTopicInput,
): ReconcileRequirementsByTopicResult {
  const byTopic = new Map<string, ApplicableRequirement[]>();
  for (const req of input.requirements) {
    const list = byTopic.get(req.topic) ?? [];
    list.push(req);
    byTopic.set(req.topic, list);
  }

  const reconciliations: PrecedenceReconciliationResult[] = [];
  const uncontested: ApplicableRequirement[] = [];

  for (const [, group] of byTopic) {
    if (group.length < 2) {
      uncontested.push(...group);
      continue;
    }
    const result = reconcileStandardPrecedence(group, input.options);
    if (result) reconciliations.push(result);
  }

  return { reconciliations, uncontested };
}

/**
 * Format a reconciliation as finding-ready text with inline citation tokens
 * and preserved atomId lineage.
 */
export function formatPrecedenceFindingText(
  result: PrecedenceReconciliationResult,
): string {
  const comparedLabels = result.compared
    .map((r) => `${r.citationLabel} [[CODE:${r.atomId}]]`)
    .join(", ");
  const governingValue =
    result.governing.numericValue !== undefined
      ? `${result.governing.numericValue}${result.governing.numericUnit ?? ""} (${result.governing.requirementKind})`
      : result.governing.textValue ?? result.governing.dimension;
  const conflictNote =
    result.conflicts.find((c) => c.status === "unresolved")?.resolutionNote ??
    result.conflicts[0]?.resolutionNote ??
    "";
  return (
    `Precedence reconciliation (${result.ruleApplied}) for ${result.dimension}: ` +
    `governing value ${governingValue} from ${result.governing.citationLabel} [[CODE:${result.governing.atomId}]] ` +
    `after comparing ${comparedLabels}. ` +
    `${result.reasoningChain.join(" ")}` +
    (conflictNote ? ` Conflict note: ${conflictNote}` : "")
  );
}
