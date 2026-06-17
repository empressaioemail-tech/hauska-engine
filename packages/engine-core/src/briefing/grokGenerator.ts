/**
 * Grok (xAI) branch of the parcel briefing engine.
 *
 * Uses the OpenAI-compatible xAI chat completions API. JSON parsing
 * shares {@link parseAnthropicResponse} with the Anthropic branch so
 * both producers emit identical {@link BriefingSections} shapes.
 */

import type { GrokClient } from "../llm/grok.js";
import type { BriefingSections, GenerateBriefingInput } from "./types";
import { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import {
  AnthropicGeneratorError,
  parseAnthropicResponse,
} from "./anthropicGenerator";

/** Default model — override with XAI_BRIEFING_MODEL or XAI_MODEL env. */
export const BRIEFING_GROK_DEFAULT_MODEL = "grok-3-mini";

export const BRIEFING_GROK_MAX_TOKENS = 4096;

export function resolveGrokBriefingModel(): string {
  return (
    process.env.XAI_BRIEFING_MODEL?.trim() ||
    process.env.XAI_MODEL?.trim() ||
    BRIEFING_GROK_DEFAULT_MODEL
  );
}

export async function callGrokGenerator(
  client: GrokClient,
  input: GenerateBriefingInput,
): Promise<BriefingSections> {
  let text: string;
  try {
    text = await client.completeChat({
      model: resolveGrokBriefingModel(),
      maxTokens: BRIEFING_GROK_MAX_TOKENS,
      system: BRIEFING_SYSTEM_PROMPT,
      user: buildUserPrompt(input),
    });
  } catch (err) {
    throw new AnthropicGeneratorError(
      "anthropic_call_failed",
      `Grok call failed: ${(err as Error).message}`,
    );
  }
  return parseAnthropicResponse(text);
}
