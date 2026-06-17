import Anthropic from "@anthropic-ai/sdk";

import {
  createGrokClient,
  type GrokClient,
} from "@hauska-engine/engine-core";
import { resolveBriefingLlmMode } from "@hauska-engine/engine-core/briefing";
import { resolveFindingLlmMode } from "@hauska-engine/engine-core/finding";

export type LlmMode = "mock" | "grok" | "anthropic";

export function resolveBriefingMode(): LlmMode {
  return resolveBriefingLlmMode();
}

export function resolveFindingMode(): LlmMode {
  return resolveFindingLlmMode();
}

export function getGrokClient(): GrokClient {
  return createGrokClient();
}

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic({ apiKey });
}
