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
import {
  getAnthropicClient,
  getGrokClient,
  resolveFindingMode,
} from "../lib/llmClients.js";
import { envelopeJson } from "../lib/envelopeResponse.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

const orchestratedBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

function engineOptions(mode: "mock" | "grok" | "anthropic") {
  return {
    mode,
    grokClient: mode === "grok" ? getGrokClient() : undefined,
    anthropicClient: mode === "anthropic" ? getAnthropicClient() : undefined,
    visionAnthropicClient:
      mode === "anthropic" ? getAnthropicClient() : undefined,
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
) {
  const dataVintage =
    input.sources
      .map((s) => s.snapshotDate)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const reasons: string[] = [];
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

    const mode = parsed.data.mode ?? resolveFindingMode();
    const input = parsed.data.input as unknown as GenerateFindingsInput;

    try {
      const result = await generateFindings(input, engineOptions(mode));
      return envelopeJson(
        c,
        { result, mode },
        findingsEnvelopeMeta(input, mode, result),
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

    const mode = parsed.data.mode ?? resolveFindingMode();
    const input = parsed.data.input as unknown as GenerateOrchestratedFindingsInput;

    try {
      const result = await generateOrchestratedFindings(
        input,
        engineOptions(mode),
      );
      return envelopeJson(
        c,
        { result, mode },
        findingsEnvelopeMeta(input.baseInput, mode, result),
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
