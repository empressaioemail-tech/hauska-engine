/**
 * Anthropic branch of the briefing engine.
 *
 * Calls Claude Sonnet 4.5 via the workspace's `createAnthropicClient`
 * factory (passed in by the caller — keeping the SDK constructor out
 * of this module means tests can hand a stub fetcher in without
 * importing the real SDK).
 *
 * Contract:
 *   - System + user prompts come from `prompt.ts`.
 *   - Claude responds with a strict JSON object  { "a": "...", ..., "g": "..." } .
 *   - We tolerate (and strip) accidental markdown fencing — Claude
 *     occasionally wraps JSON in a  ```json ... ```  fence even when
 *     told not to. Anything else (truncated JSON, missing keys) is a
 *     hard failure that bubbles up as an `AnthropicGeneratorError`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { BriefingSections, GenerateBriefingInput } from "./types";
import { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

/** Model id pinned by Spec 51 / DA-PI-3 task ledger (locked decision #2). */
export const BRIEFING_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Token budget per generation. Tuned for ~7×500-token sections plus headroom. */
export const BRIEFING_ANTHROPIC_MAX_TOKENS = 4096;

export class AnthropicGeneratorError extends Error {
  constructor(
    public readonly code:
      | "anthropic_call_failed"
      | "anthropic_invalid_response_shape"
      | "anthropic_invalid_json"
      | "anthropic_missing_section",
    message: string,
  ) {
    super(message);
    this.name = "AnthropicGeneratorError";
    Object.setPrototypeOf(this, AnthropicGeneratorError.prototype);
  }
}

/**
 * Strip a leading ```json fence + trailing ``` if Claude wrapped its
 * JSON despite the prompt's "no markdown fencing" instruction.
 * Idempotent — the unfenced path is a no-op.
 */
function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  // Match ```json\n...\n``` (with optional language tag).
  const fenceRe = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;
  const m = trimmed.match(fenceRe);
  return m?.[1] ? m[1].trim() : trimmed;
}

const SECTION_KEYS = ["a", "b", "c", "d", "e", "f", "g"] as const;

/** Parse Claude's JSON response into the seven-section shape. */
export function parseAnthropicResponse(raw: string): BriefingSections {
  const cleaned = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new AnthropicGeneratorError(
      "anthropic_invalid_json",
      `Claude response is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AnthropicGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response is not a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const out: Partial<BriefingSections> = {};
  for (const key of SECTION_KEYS) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new AnthropicGeneratorError(
        "anthropic_missing_section",
        `Claude response missing or non-string section "${key}"`,
      );
    }
    out[key] = v;
  }
  return out as BriefingSections;
}

/**
 * Run one Claude call against the input bundle and return the parsed
 * sections. The caller is responsible for citation validation; this
 * module is concerned with the network call + JSON parse only.
 */
export async function callAnthropicGenerator(
  client: Anthropic,
  input: GenerateBriefingInput,
): Promise<BriefingSections> {
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: BRIEFING_ANTHROPIC_MODEL,
      max_tokens: BRIEFING_ANTHROPIC_MAX_TOKENS,
      system: BRIEFING_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input),
        },
      ],
    });
  } catch (err) {
    throw new AnthropicGeneratorError(
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
    throw new AnthropicGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response had no text content blocks`,
    );
  }
  return parseAnthropicResponse(textParts.join(""));
}
