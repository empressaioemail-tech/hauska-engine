/**
 * Grok (xAI) branch of the AIR-1 finding engine.
 *
 * Uses the OpenAI-compatible xAI chat completions API. JSON parsing
 * shares {@link parseAnthropicResponse} with the Anthropic branch so
 * both producers emit identical {@link RawFindingDraft} shapes.
 */

import type { GrokClient } from "../llm/grok.js";
import type { GenerateFindingsInput } from "./types";
import { FINDING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import {
  FindingGeneratorError,
  parseAnthropicResponse,
  type RawFindingDraft,
} from "./anthropicGenerator";

/** Default model — override with XAI_MODEL or XAI_FINDING_MODEL env. */
export const FINDING_GROK_DEFAULT_MODEL = "grok-3-mini";

export const FINDING_GROK_MAX_TOKENS = 6144;

export function resolveGrokFindingModel(): string {
  return (
    process.env.XAI_FINDING_MODEL?.trim() ||
    process.env.XAI_MODEL?.trim() ||
    FINDING_GROK_DEFAULT_MODEL
  );
}

export async function callGrokGenerator(
  client: GrokClient,
  input: GenerateFindingsInput,
): Promise<RawFindingDraft[]> {
  let text: string;
  try {
    text = await client.completeChat({
      model: resolveGrokFindingModel(),
      maxTokens: FINDING_GROK_MAX_TOKENS,
      system: FINDING_SYSTEM_PROMPT,
      user: buildUserPrompt(input),
    });
  } catch (err) {
    throw new FindingGeneratorError(
      "anthropic_call_failed",
      `Grok call failed: ${(err as Error).message}`,
    );
  }
  return parseAnthropicResponse(text);
}
