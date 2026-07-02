import { Hono } from "hono";
import { z } from "zod";

import {
  generateFindings,
  generateOrchestratedFindings,
  type GenerateFindingsInput,
  type GenerateOrchestratedFindingsInput,
} from "@hauska-engine/engine-core/finding";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { resolveFindingMode, resolveLlmForMode } from "../lib/llmClients.js";
import { envelopeJson } from "../lib/envelopeResponse.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

const orchestratedBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

/**
 * Resolve engine LLM options for a requested mode without throwing on a
 * missing key. Mirrors the briefing route: a missing ANTHROPIC_API_KEY
 * degrades to Grok, then to the deterministic mock path, rather than
 * 500ing (commitment #1). Returns the effective mode + a degraded flag.
 */
function engineOptions(requested: "mock" | "grok" | "anthropic") {
  const llm = resolveLlmForMode(requested);
  return {
    options: {
      mode: llm.mode,
      grokClient: llm.grokClient,
      anthropicClient: llm.anthropicClient,
      visionAnthropicClient: llm.anthropicClient,
    },
    mode: llm.mode,
    degraded: llm.degraded,
    degradationReason: llm.degradationReason,
  };
}

function findingsEnvelopeMeta(
  input: GenerateFindingsInput,
  mode: string,
  result: {
    invalidCitations: readonly string[];
    discardedFindings: readonly unknown[];
    precedence: unknown;
  },
  llmDegradationReason?: string,
) {
  const dataVintage =
    input.sources
      .map((s) => s.snapshotDate)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const reasons: string[] = [];
  if (llmDegradationReason) {
    reasons.push(llmDegradationReason);
  }
  if (result.invalidCitations.length > 0) {
    reasons.push(`${result.invalidCitations.length} invalid citation(s)`);
  }
  if (result.discardedFindings.length > 0) {
    reasons.push(`${result.discardedFindings.length} finding(s) discarded`);
  }
  if (result.precedence == null && input.codeSections.length >= 2) {
    reasons.push("precedence not reconciled (no multi-standard topic overlap)");
  }
  const coverage =
    reasons.length > 0
      ? degradedCoverage(reasons.join("; "), true)
      : okCoverage();
  return {
    confidence: resolveReadPathConfidence({
      codeSections: input.codeSections,
      assertedBaseline: mode === "mock" ? 0.68 : undefined,
    }),
    dataVintage,
    coverage,
    source: {
      adapter: `finding-engine:${mode}`,
      citationIds: [
        ...input.sources.map((s) => s.id),
        ...input.codeSections.map((s) => s.atomId),
      ],
    },
  };
}

export function buildFindingsRoutes(): Hono {
  const app = new Hono();

  app.post("/generate", async (c) => {
    const parsed = generateBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const requestedMode = parsed.data.mode ?? resolveFindingMode();
    const input = parsed.data.input as unknown as GenerateFindingsInput;
    const llm = engineOptions(requestedMode);
    const mode = llm.mode;

    try {
      const result = await generateFindings(input, llm.options);
      return envelopeJson(
        c,
        { result, mode, requestedMode, degraded: llm.degraded },
        findingsEnvelopeMeta(input, mode, result, llm.degradationReason),
      );
    } catch (err) {
      return c.json(
        {
          error: "finding_generation_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post("/generate-orchestrated", async (c) => {
    const parsed = orchestratedBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const requestedMode = parsed.data.mode ?? resolveFindingMode();
    const input = parsed.data.input as unknown as GenerateOrchestratedFindingsInput;
    const llm = engineOptions(requestedMode);
    const mode = llm.mode;

    try {
      const result = await generateOrchestratedFindings(
        input,
        llm.options,
      );
      return envelopeJson(
        c,
        { result, mode, requestedMode, degraded: llm.degraded },
        findingsEnvelopeMeta(input.baseInput, mode, result, llm.degradationReason),
      );
    } catch (err) {
      return c.json(
        {
          error: "orchestrated_finding_generation_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}
