import Anthropic from "@anthropic-ai/sdk";

import {
  createGrokClient,
  type GrokClient,
} from "@hauska-engine/engine-core";
import { resolveBriefingLlmMode } from "@hauska-engine/engine-core/briefing";
import { resolveFindingLlmMode } from "@hauska-engine/engine-core/finding";
import {
  LlmModeRefusalError,
  LlmResolutionRefusalError,
} from "@hauska-engine/engine-core/llm-mode-refusal";

export type LlmMode = "grok" | "anthropic";

export function resolveBriefingMode(): LlmMode {
  return resolveBriefingLlmMode() as LlmMode;
}

export function resolveFindingMode(): LlmMode {
  return resolveFindingLlmMode() as LlmMode;
}

export function getGrokClient(): GrokClient {
  return createGrokClient();
}

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmResolutionRefusalError("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic({ apiKey });
}

/** True when an ANTHROPIC_API_KEY is present in the environment. */
export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** True when an XAI/Grok key is present (the Grok-first default rail). */
export function hasGrokKey(): boolean {
  return Boolean(
    process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim(),
  );
}

export interface ResolvedLlm {
  mode: LlmMode;
  grokClient?: GrokClient;
  anthropicClient?: Anthropic;
}

/**
 * Resolve a runnable LLM for a requested live mode. Missing keys refuse;
 * mock is not reachable from API routes.
 */
export function resolveLlmForMode(requested: LlmMode): ResolvedLlm {
  if (requested === "anthropic") {
    if (!hasAnthropicKey()) {
      throw new LlmResolutionRefusalError(
        "ANTHROPIC_API_KEY is not configured",
      );
    }
    return { mode: "anthropic", anthropicClient: getAnthropicClient() };
  }

  // requested === "grok"
  if (!hasGrokKey()) {
    throw new LlmResolutionRefusalError("XAI_API_KEY is not configured");
  }
  return { mode: "grok", grokClient: getGrokClient() };
}

export { LlmModeRefusalError, LlmResolutionRefusalError };
