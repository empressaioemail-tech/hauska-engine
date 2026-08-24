/**
 * Fail-closed LLM mode resolution. Missing configuration refuses rather
 * than silently selecting mock fixtures that fabricate high-confidence findings.
 */

export class LlmModeRefusalError extends Error {
  readonly code = "llm_mode_refusal" as const;

  constructor(message: string) {
    super(message);
    this.name = "LlmModeRefusalError";
  }
}

export class LlmResolutionRefusalError extends Error {
  readonly code = "llm_resolution_refusal" as const;

  constructor(message: string) {
    super(message);
    this.name = "LlmResolutionRefusalError";
  }
}

export type ResolvedLlmMode = "grok" | "anthropic";

/** Resolve AIR_FINDING_LLM_MODE with no silent mock default. */
export function resolveFindingLlmModeFromEnv(): ResolvedLlmMode {
  const raw = process.env.AIR_FINDING_LLM_MODE?.trim();
  if (!raw) {
    throw new LlmModeRefusalError(
      "AIR_FINDING_LLM_MODE is not set — refusing rather than defaulting to mock",
    );
  }
  const mode = raw.toLowerCase();
  if (mode === "grok") return "grok";
  if (mode === "anthropic") return "anthropic";
  if (mode === "mock") {
    throw new LlmModeRefusalError(
      "AIR_FINDING_LLM_MODE=mock is not permitted in production paths",
    );
  }
  throw new LlmModeRefusalError(
    `AIR_FINDING_LLM_MODE=${raw} is not a supported live mode (grok | anthropic)`,
  );
}

/** Resolve BRIEFING_LLM_MODE with no silent mock default. */
export function resolveBriefingLlmModeFromEnv(): ResolvedLlmMode {
  const raw = process.env.BRIEFING_LLM_MODE?.trim();
  if (!raw) {
    throw new LlmModeRefusalError(
      "BRIEFING_LLM_MODE is not set — refusing rather than defaulting to mock",
    );
  }
  const mode = raw.toLowerCase();
  if (mode === "grok") return "grok";
  if (mode === "anthropic") return "anthropic";
  if (mode === "mock") {
    throw new LlmModeRefusalError(
      "BRIEFING_LLM_MODE=mock is not permitted in production paths",
    );
  }
  throw new LlmModeRefusalError(
    `BRIEFING_LLM_MODE=${raw} is not a supported live mode (grok | anthropic)`,
  );
}
