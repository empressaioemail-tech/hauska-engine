/**
 * Top-level engine entry point. The route layer calls
 * {@link generateBriefing} with the input bundle + a resolved
 * Anthropic client (or no client when running in mock mode); the
 * function returns the cleaned seven-section narrative + any invalid
 * citations the validator stripped.
 *
 * Mode is selected from env (`BRIEFING_LLM_MODE`) when not passed
 * explicitly. Default is `mock` — same convention as the DXF
 * converter (`DXF_CONVERTER_MODE`) so dev / CI work out-of-the-box
 * without an API key.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { GrokClient } from "../llm/grok.js";
import {
  callAnthropicGenerator,
  AnthropicGeneratorError,
} from "./anthropicGenerator";
import { callGrokGenerator } from "./grokGenerator";
import {
  validateSectionCitations,
  type CitationResolvers,
} from "./citationValidator";
import { generateMockBriefing } from "./mockGenerator";
import { extractMaterializableElements } from "./materializableElements";
import {
  HEAVY_SECTIONS,
  type BriefingLlmMode,
  type BriefingSections,
  type GenerateBriefingInput,
  type GenerateBriefingResult,
} from "./types";
import { SECTIONS_WITH_NO_CITATIONS } from "./sourceCategories";

export interface GenerateBriefingOptions {
  /** Force a mode; defaults to {@link resolveBriefingLlmMode}. */
  mode?: BriefingLlmMode;
  /**
   * Anthropic SDK client to use when `mode === "anthropic"`. Required
   * for the anthropic branch (the engine deliberately does not import
   * the singleton — keeps tests in control of what client is wired in
   * and avoids forcing the package to depend on a live API key at
   * import time).
   */
  anthropicClient?: Anthropic;
  /**
   * xAI Grok client to use when `mode === "grok"`. Required for the
   * grok branch (same injection pattern as findings).
   */
  grokClient?: GrokClient;
  /**
   * When supplied, validation also accepts these code-section atom
   * ids. Anything else is treated as invalid and stripped.
   */
  knownCodeSectionIds?: ReadonlyArray<string>;
  /** Override the engine's clock — test-only. */
  now?: () => Date;
}

/**
 * Resolve the engine mode from env. The route layer can override at
 * call time; this helper exists so a single source of truth backs both
 * the route's startup log and the engine's runtime branch.
 */
export function resolveBriefingLlmMode(): BriefingLlmMode {
  const raw = (process.env.BRIEFING_LLM_MODE ?? "mock").toLowerCase();
  if (raw === "grok") return "grok";
  if (raw === "anthropic") return "anthropic";
  return "mock";
}

const HEAVY_SECTION_SET: ReadonlySet<string> = new Set(HEAVY_SECTIONS);
const NO_CITATION_SECTION_SET: ReadonlySet<string> = new Set(
  SECTIONS_WITH_NO_CITATIONS,
);
const SECTION_KEYS: ReadonlyArray<keyof BriefingSections> = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
];

/**
 * The engine's main entry point. Returns the cleaned narrative + any
 * invalid citation tokens the validator stripped (so the route can
 * log them for observability).
 */
export async function generateBriefing(
  input: GenerateBriefingInput,
  options: GenerateBriefingOptions = {},
): Promise<GenerateBriefingResult> {
  const mode = options.mode ?? resolveBriefingLlmMode();
  const now = options.now ?? (() => new Date());

  let raw: BriefingSections;
  if (mode === "grok") {
    if (!options.grokClient) {
      throw new AnthropicGeneratorError(
        "anthropic_call_failed",
        "BRIEFING_LLM_MODE=grok requires a Grok client to be passed",
      );
    }
    raw = await callGrokGenerator(options.grokClient, input);
  } else if (mode === "anthropic") {
    if (!options.anthropicClient) {
      throw new AnthropicGeneratorError(
        "anthropic_call_failed",
        "BRIEFING_LLM_MODE=anthropic requires an Anthropic client to be passed",
      );
    }
    raw = await callAnthropicGenerator(options.anthropicClient, input);
  } else {
    raw = generateMockBriefing(input);
  }

  // Build citation resolver lookups from the input bundle + the
  // optional code-section ids.
  const knownSourceIds = new Set(input.sources.map((s) => s.id));
  const knownCodeIds = new Set([
    ...(input.codeSections ?? []).map((c) => c.atomId),
    ...(options.knownCodeSectionIds ?? []),
  ]);
  const resolvers: CitationResolvers = {
    isKnownBriefingSourceId: (id) => knownSourceIds.has(id),
    isKnownCodeSectionId: (id) => knownCodeIds.has(id),
  };

  const cleaned: Partial<BriefingSections> = {};
  const invalid: string[] = [];
  for (const key of SECTION_KEYS) {
    const allowCitations = !NO_CITATION_SECTION_SET.has(key);
    const result = validateSectionCitations(raw[key], resolvers, {
      allowCitations,
    });
    cleaned[key] = result.cleaned;
    invalid.push(...result.invalidTokens);
  }

  // Empty heavy section after stripping is a soft failure — we keep
  // it so the route can backfill a gap note rather than surface "".
  for (const key of SECTION_KEYS) {
    const value = cleaned[key]!.trim();
    if (value.length === 0) {
      cleaned[key] =
        HEAVY_SECTION_SET.has(key) || key === "a" || key === "g"
          ? `${SECTION_LABEL[key]} unavailable — engine could not synthesize this section.`
          : `${SECTION_LABEL[key]} unavailable.`;
    }
  }

  const finalSections = cleaned as BriefingSections;
  return {
    sections: finalSections,
    invalidCitations: invalid,
    materializableElements: extractMaterializableElements(finalSections),
    generatedAt: now(),
    generatedBy: input.generatedBy,
    producer: mode,
  };
}

const SECTION_LABEL: Record<keyof BriefingSections, string> = {
  a: "Section A (Executive Summary)",
  b: "Section B (Threshold Issues)",
  c: "Section C (Regulatory Gates)",
  d: "Section D (Site Infrastructure)",
  e: "Section E (Buildable Envelope)",
  f: "Section F (Neighboring Context)",
  g: "Section G (Next-Step Checklist)",
};
