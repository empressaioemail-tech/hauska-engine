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
  /** The mode that will actually run after degradation, if any. */
  mode: LlmMode;
  grokClient?: GrokClient;
  anthropicClient?: Anthropic;
  /** True when the requested mode was unavailable and we fell back. */
  degraded: boolean;
  /** Human-readable reason, populated only when `degraded`. */
  degradationReason?: string;
}

/**
 * Resolve a runnable LLM for a requested mode WITHOUT throwing on a
 * missing key. Per CLAUDE.md the brief generator is Grok-first with a
 * deterministic rules/mock fallback and no required Anthropic path, so a
 * missing key must degrade gracefully rather than 500.
 *
 * Degradation ladder:
 *   anthropic (no key) -> grok (if XAI key) -> mock
 *   grok      (no key) -> mock
 *   mock               -> mock (never degrades)
 */
export function resolveLlmForMode(requested: LlmMode): ResolvedLlm {
  if (requested === "mock") {
    return { mode: "mock", degraded: false };
  }

  if (requested === "anthropic") {
    if (hasAnthropicKey()) {
      return { mode: "anthropic", anthropicClient: getAnthropicClient(), degraded: false };
    }
    if (hasGrokKey()) {
      return {
        mode: "grok",
        grokClient: getGrokClient(),
        degraded: true,
        degradationReason:
          "ANTHROPIC_API_KEY not configured; fell back to the Grok-first generation path",
      };
    }
    return {
      mode: "mock",
      degraded: true,
      degradationReason:
        "no LLM key configured (ANTHROPIC_API_KEY and XAI_API_KEY both absent); fell back to the deterministic rules/mock brief",
    };
  }

  // requested === "grok"
  if (hasGrokKey()) {
    return { mode: "grok", grokClient: getGrokClient(), degraded: false };
  }
  return {
    mode: "mock",
    degraded: true,
    degradationReason:
      "XAI_API_KEY not configured; fell back to the deterministic rules/mock brief",
  };
}
