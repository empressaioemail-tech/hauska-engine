/**
 * Anthropic branch of the AIR-1 finding engine.
 *
 * Calls Claude Sonnet 4.5 via an Anthropic SDK client passed in by the
 * caller — keeping the SDK constructor out of this module means tests
 * can hand a stub fetcher in without importing the real SDK, and the
 * engine package never directly trips the integrations module's env-
 * var requirement at import time.
 *
 * Contract:
 *   - System + user prompts come from `prompt.ts`.
 *   - Claude responds with a strict JSON object  { "findings": [...] }.
 *   - We tolerate (and strip) accidental markdown fencing — Claude
 *     occasionally wraps JSON in a  ```json … ```  fence even when
 *     told not to. Anything else (truncated JSON, missing keys,
 *     wrong-shape elements) is a hard failure that bubbles up as a
 *     {@link FindingGeneratorError}.
 *
 * Mirrors `lib/briefing-engine/src/anthropicGenerator.ts` so the two
 * engines share their LLM-call ergonomics.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  EngineFinding,
  FindingCategory,
  FindingCitation,
  FindingSeverity,
  GenerateFindingsInput,
} from "./types";
import {
  FINDING_CATEGORY_VALUES,
  FINDING_SEVERITY_VALUES,
} from "./types";
import { FINDING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

/** Model id pinned by Phase 1A approval (decision: same as briefing-engine). */
export const FINDING_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Token budget per generation. 6 KB headroom for ~6 findings × 800 tokens. */
export const FINDING_ANTHROPIC_MAX_TOKENS = 6144;

export class FindingGeneratorError extends Error {
  constructor(
    public readonly code:
      | "anthropic_call_failed"
      | "anthropic_invalid_response_shape"
      | "anthropic_invalid_json"
      | "anthropic_invalid_finding_shape",
    message: string,
  ) {
    super(message);
    this.name = "FindingGeneratorError";
    Object.setPrototypeOf(this, FindingGeneratorError.prototype);
  }
}

/**
 * Strip a leading ```json fence + trailing ``` if Claude wrapped its
 * JSON despite the prompt's "no markdown fencing" instruction.
 * Idempotent — the unfenced path is a no-op. Mirrors briefing-engine's
 * helper so a regression in one engine surfaces in the other.
 */
function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  const fenceRe = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;
  const m = trimmed.match(fenceRe);
  return m?.[1] ? m[1].trim() : trimmed;
}

const SEVERITY_SET: ReadonlySet<string> = new Set(FINDING_SEVERITY_VALUES);
const CATEGORY_SET: ReadonlySet<string> = new Set(FINDING_CATEGORY_VALUES);

/** Narrow `unknown` into a {@link FindingCitation} or throw. */
function parseCitation(value: unknown, idx: number, findingIdx: number): FindingCitation {
  if (!value || typeof value !== "object") {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].citations[${idx}] is not an object`,
    );
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "code-section") {
    const atomId = obj.atomId;
    if (typeof atomId !== "string" || atomId.length === 0) {
      throw new FindingGeneratorError(
        "anthropic_invalid_finding_shape",
        `findings[${findingIdx}].citations[${idx}] code-section missing atomId`,
      );
    }
    return { kind: "code-section", atomId };
  }
  if (kind === "briefing-source") {
    const id = obj.id;
    const label = obj.label;
    if (typeof id !== "string" || id.length === 0) {
      throw new FindingGeneratorError(
        "anthropic_invalid_finding_shape",
        `findings[${findingIdx}].citations[${idx}] briefing-source missing id`,
      );
    }
    if (typeof label !== "string" || label.length === 0) {
      throw new FindingGeneratorError(
        "anthropic_invalid_finding_shape",
        `findings[${findingIdx}].citations[${idx}] briefing-source missing label`,
      );
    }
    return { kind: "briefing-source", id, label };
  }
  throw new FindingGeneratorError(
    "anthropic_invalid_finding_shape",
    `findings[${findingIdx}].citations[${idx}] has unknown kind ${JSON.stringify(kind)}`,
  );
}

/** Narrow one finding object emitted by Claude. */
function parseOneFinding(
  raw: unknown,
  findingIdx: number,
): {
  severity: FindingSeverity;
  category: FindingCategory;
  text: string;
  citations: FindingCitation[];
  confidence: number;
  lowConfidence: boolean;
  elementRef: string | null;
  sourceRef: { id: string; label: string } | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}] is not an object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const severity = obj.severity;
  if (typeof severity !== "string" || !SEVERITY_SET.has(severity)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].severity must be one of ${[...SEVERITY_SET].join("|")}; got ${JSON.stringify(severity)}`,
    );
  }
  const category = obj.category;
  if (typeof category !== "string" || !CATEGORY_SET.has(category)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].category must be one of ${[...CATEGORY_SET].join("|")}; got ${JSON.stringify(category)}`,
    );
  }
  const text = obj.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].text must be a non-empty string`,
    );
  }
  const citationsRaw = obj.citations;
  if (!Array.isArray(citationsRaw)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].citations must be an array`,
    );
  }
  const citations = citationsRaw.map((c, i) => parseCitation(c, i, findingIdx));

  const confidenceRaw = obj.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_finding_shape",
      `findings[${findingIdx}].confidence must be a finite number`,
    );
  }
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const lowConfidence = obj.lowConfidence === true;

  let elementRef: string | null = null;
  if (typeof obj.elementRef === "string" && obj.elementRef.length > 0) {
    elementRef = obj.elementRef;
  }

  let sourceRef: { id: string; label: string } | null = null;
  if (obj.sourceRef && typeof obj.sourceRef === "object") {
    const sr = obj.sourceRef as Record<string, unknown>;
    if (
      typeof sr.id === "string" &&
      sr.id.length > 0 &&
      typeof sr.label === "string" &&
      sr.label.length > 0
    ) {
      sourceRef = { id: sr.id, label: sr.label };
    }
  }

  return {
    severity: severity as FindingSeverity,
    category: category as FindingCategory,
    text,
    citations,
    confidence,
    lowConfidence,
    elementRef,
    sourceRef,
  };
}

/**
 * Parse Claude's JSON response into the partial-finding shape (sans
 * the route-stamped fields like `atomId` and `submissionId` — those
 * belong to the engine wrapper, not the LLM contract).
 */
export function parseAnthropicResponse(
  raw: string,
): ReturnType<typeof parseOneFinding>[] {
  const cleaned = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new FindingGeneratorError(
      "anthropic_invalid_json",
      `Claude response is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response is not a JSON object`,
    );
  }
  const findingsRaw = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(findingsRaw)) {
    throw new FindingGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response missing or non-array "findings" key`,
    );
  }
  return findingsRaw.map((f, i) => parseOneFinding(f, i));
}

/** What `callAnthropicGenerator` returns to the engine wrapper. */
export interface RawFindingDraft
  extends ReturnType<typeof parseOneFinding> {}

/**
 * Run one Claude call against the input bundle and return the parsed
 * finding drafts. The caller is responsible for citation validation
 * and atom-id stamping; this module is concerned with the network
 * call + JSON parse + per-finding shape narrowing only.
 */
export async function callAnthropicGenerator(
  client: Anthropic,
  input: GenerateFindingsInput,
): Promise<RawFindingDraft[]> {
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: FINDING_ANTHROPIC_MODEL,
      max_tokens: FINDING_ANTHROPIC_MAX_TOKENS,
      system: FINDING_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input),
        },
      ],
    });
  } catch (err) {
    throw new FindingGeneratorError(
      "anthropic_call_failed",
      `Anthropic call failed: ${(err as Error).message}`,
    );
  }

  // Concatenate every text block — defensive in case the model emits
  // multiple blocks (rare for a JSON response, but the SDK's union
  // type allows it).
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  if (textParts.length === 0) {
    throw new FindingGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response had no text content blocks`,
    );
  }
  return parseAnthropicResponse(textParts.join(""));
}

// Re-export so consumers can construct EngineFinding values without
// re-importing types.
export type { EngineFinding } from "./types";
