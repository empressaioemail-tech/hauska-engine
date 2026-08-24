/**
 * Top-level engine entry point. The route layer calls
 * {@link generateFindings} with the input bundle + a resolved
 * Anthropic client (or no client when running in mock mode); the
 * function returns the surviving findings + invalid citation tokens
 * + discarded findings the validator dropped.
 *
 * Mode is selected from env (`AIR_FINDING_LLM_MODE`) when not passed
 * explicitly. Default is `mock` — same convention as briefing-engine
 * (`BRIEFING_LLM_MODE`) so dev / CI / pre-Empressa-approval workflows
 * boot without an API key.
 *
 * Validation + discard policy (Phase 1A approval):
 *   - Every emitted finding has its `text` run through the shared
 *     citation validator (`validateInlineCitations`). Tokens whose
 *     ids are not in the input's reference blocks are STRIPPED from
 *     `text` and reported on the result's `invalidCitations` list.
 *   - A finding is DISCARDED (dropped from output, recorded on
 *     `discardedFindings`) when after stripping it has:
 *       (no surviving citation tokens AND no elementRef) OR
 *       (text length < FINDING_MIN_TEXT_LENGTH)
 *     This prevents the FE from rendering an unanchored fragment;
 *     the run row's `discardedFindingCount` mirrors the count.
 *
 * Atom-id stamping (`finding:{submissionId}:{ulid}`) happens here at
 * the engine boundary, AFTER validation, so the route's persistence
 * layer can use the engine output verbatim.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  callAnthropicGenerator,
  FindingGeneratorError,
  type RawFindingDraft,
} from "./anthropicGenerator";
import { callGrokGenerator } from "./grokGenerator";
import type { GrokClient } from "../llm/grok.js";
import {
  validateInlineCitations,
  type CitationResolvers,
} from "./citationAdapter";
import { generateMockFindings } from "./mockGenerator";
import { runFindingsPrecedencePass } from "./precedence/findingsPass.js";
import {
  FINDING_MIN_TEXT_LENGTH,
  type EngineFinding,
  type FindingCitation,
  type FindingLlmMode,
  type GenerateFindingsInput,
  type GenerateFindingsResult,
} from "./types";
import {
  LlmModeRefusalError,
  resolveFindingLlmModeFromEnv,
} from "../llm-mode-refusal.js";

export interface GenerateFindingsOptions {
  /** Force a mode; defaults to {@link resolveFindingLlmMode}. */
  mode?: FindingLlmMode;
  /**
   * Anthropic SDK client when `mode === "anthropic"` (legacy — prefer
   * `grok`).
   */
  anthropicClient?: Anthropic;
  /**
   * Anthropic client for P2 Opus vision read (HR-12 escalation).
   * Used by the orchestrator before Grok synthesis when sheet images are present.
   */
  visionAnthropicClient?: Anthropic;
  /** xAI Grok client when `mode === "grok"`. */
  grokClient?: GrokClient;
  /** Structured log hook for vision-read observability. */
  visionLog?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Override the engine's clock — test-only. */
  now?: () => Date;
  /**
   * Override the atom-id ulid generator — test-only. Lets the route
   * integration tests assert deterministic atom-id formats without
   * touching the production ulid path.
   */
  ulid?: () => string;
}

/**
 * Resolve the engine mode from env. Refuses when unset or mock — mock is
 * test-only via explicit `options.mode`.
 */
export function resolveFindingLlmMode(): FindingLlmMode {
  return resolveFindingLlmModeFromEnv();
}

/** Default ulid-shaped id generator (collision-resistant for tests). */
function defaultUlid(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`.toUpperCase().slice(0, 26);
}

/**
 * Decide whether a post-validation finding should be discarded. Per
 * Phase 1A approval the rule is:
 *
 *   "A finding must retain ≥1 valid citation OR an elementRef AND
 *    text length >= FINDING_MIN_TEXT_LENGTH to survive."
 *
 * Returns the discard reason (`"no_valid_citations_or_anchor"` |
 * `"text_too_short"`) when the rule trips, else `null`.
 *
 * Order matters: text-length is checked first because a too-short
 * body is the more pointed signal (the model emitted a fragment).
 * `no_valid_citations_or_anchor` covers the "model fabricated all
 * citations" case where every token in `text` was stripped AND no
 * elementRef was supplied.
 */
function discardReason(
  cleanedText: string,
  retainedCitations: FindingCitation[],
  elementRef: string | null,
): "no_valid_citations_or_anchor" | "text_too_short" | null {
  if (cleanedText.trim().length < FINDING_MIN_TEXT_LENGTH) {
    return "text_too_short";
  }
  if (retainedCitations.length === 0 && (elementRef === null || elementRef.length === 0)) {
    return "no_valid_citations_or_anchor";
  }
  return null;
}

/**
 * Project the engine's output into the engine's
 * {@link GenerateFindingsResult} shape. Centralized here so the mock
 * branch and the anthropic branch share one validation + discard
 * pipeline — the only difference between the two is where the raw
 * draft list comes from.
 */
function finalizeDrafts(
  drafts: ReadonlyArray<RawFindingDraft>,
  input: GenerateFindingsInput,
  resolvers: CitationResolvers,
  generatedAt: Date,
  producer: FindingLlmMode,
  ulid: () => string,
): GenerateFindingsResult {
  const findings: EngineFinding[] = [];
  const invalidCitations: string[] = [];
  const discardedFindings: GenerateFindingsResult["discardedFindings"][number][] = [];

  for (const draft of drafts) {
    const scan = validateInlineCitations(draft.text, resolvers);
    invalidCitations.push(...scan.invalidTokens);

    // Project the model-emitted citations down to those whose ids
    // resolve. The validator already stripped the inline tokens; the
    // citations array on the engine output mirrors what's left in
    // `text` so the FE renders citation chips that match the body.
    const retained = draft.citations.filter((c) => {
      if (c.kind === "code-section") return resolvers.isKnownCodeSectionId(c.atomId);
      return resolvers.isKnownBriefingSourceId(c.id);
    });

    const reason = discardReason(scan.cleaned, retained, draft.elementRef);
    if (reason) {
      discardedFindings.push({
        severity: draft.severity,
        category: draft.category,
        text: scan.cleaned,
        reason,
      });
      continue;
    }

    findings.push({
      atomId: `finding:${input.submission.id}:${ulid()}`,
      submissionId: input.submission.id,
      severity: draft.severity,
      category: draft.category,
      text: scan.cleaned,
      citations: retained,
      confidence: draft.confidence,
      lowConfidence: draft.lowConfidence,
      elementRef: draft.elementRef,
      sourceRef: draft.sourceRef,
      aiGeneratedAt: generatedAt,
      discipline: input.disciplineScope ?? null,
    });
  }

  return {
    findings,
    invalidCitations,
    discardedFindings,
    generatedAt,
    producer,
    precedence: null,
  };
}

/**
 * The engine's main entry point. Returns the surviving findings (with
 * atom ids stamped) + any invalid citation tokens stripped + any
 * findings dropped by the discard rule. Callers persist the surviving
 * findings; the run row mirrors the counts.
 */
export async function generateFindings(
  input: GenerateFindingsInput,
  options: GenerateFindingsOptions = {},
): Promise<GenerateFindingsResult> {
  const mode = options.mode ?? resolveFindingLlmMode();
  const now = options.now ?? (() => new Date());
  const ulid = options.ulid ?? defaultUlid;
  const generatedAt = now();

  // Build the resolver lookups from the input bundle. The same lookup
  // table backs both the validator's strip-unknown logic and the
  // citations-array projection.
  const knownSourceIds = new Set(input.sources.map((s) => s.id));
  const knownCodeIds = new Set(input.codeSections.map((c) => c.atomId));
  const resolvers: CitationResolvers = {
    isKnownBriefingSourceId: (id) => knownSourceIds.has(id),
    isKnownCodeSectionId: (id) => knownCodeIds.has(id),
  };

  let drafts: RawFindingDraft[];
  if (mode === "grok") {
    if (!options.grokClient) {
      throw new FindingGeneratorError(
        "anthropic_call_failed",
        "AIR_FINDING_LLM_MODE=grok requires a Grok client to be passed",
      );
    }
    drafts = await callGrokGenerator(options.grokClient, input);
  } else if (mode === "anthropic") {
    if (!options.anthropicClient) {
      throw new FindingGeneratorError(
        "anthropic_call_failed",
        "AIR_FINDING_LLM_MODE=anthropic requires an Anthropic client to be passed",
      );
    }
    drafts = await callAnthropicGenerator(options.anthropicClient, input);
  } else {
    // Mock branch: the deterministic generator emits engine-finding
    // shapes directly; we strip the engine-stamped fields back out so
    // the same finalize() pipeline runs over both branches. This
    // ensures the validator + discard rule are exercised in mock mode
    // exactly the same way they would be against Claude.
    const mockFindings = generateMockFindings(input, () => generatedAt);
    drafts = mockFindings.map((f) => ({
      severity: f.severity,
      category: f.category,
      text: f.text,
      citations: f.citations,
      confidence: f.confidence,
      lowConfidence: f.lowConfidence,
      elementRef: f.elementRef,
      sourceRef: f.sourceRef,
    }));
  }

  return attachPrecedence(
    finalizeDrafts(drafts, input, resolvers, generatedAt, mode, ulid),
    input,
  );
}

function attachPrecedence(
  result: GenerateFindingsResult,
  input: GenerateFindingsInput,
): GenerateFindingsResult {
  const precedence = runFindingsPrecedencePass(input);
  return { ...result, precedence };
}
