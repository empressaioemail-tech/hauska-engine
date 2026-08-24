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
  LlmModeRefusalError,
  LlmResolutionRefusalError,
} from "@hauska-engine/engine-core/llm-mode-refusal";
import {
  resolveFindingMode,
  resolveLlmForMode,
} from "../lib/llmClients.js";
import { envelopeJson } from "../lib/envelopeResponse.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["grok", "anthropic"]).optional(),
});

const orchestratedBodySchema = z.object({
  input: z.record(z.unknown()),
  mode: z.enum(["grok", "anthropic"]).optional(),
});

function llmRefusalResponse(c: { json: (body: unknown, status: number) => Response }, err: unknown) {
  if (err instanceof LlmModeRefusalError || err instanceof LlmResolutionRefusalError) {
    return c.json(
      {
        error: err.code,
        message: err.message,
      },
      503,
    );
  }
  return null;
}

function engineOptions(requested: "grok" | "anthropic") {
  const llm = resolveLlmForMode(requested);
  return {
    options: {
      mode: llm.mode,
      grokClient: llm.grokClient,
      anthropicClient: llm.anthropicClient,
      visionAnthropicClient: llm.anthropicClient,
    },
    mode: llm.mode,
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
      .map((s) => (s as { snapshotDate?: unknown }).snapshotDate)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
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

function objectsWithStringKey(
  value: unknown,
  key: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>)[key] === "string" &&
      ((item as Record<string, unknown>)[key] as string).length > 0,
  );
}

function normalizeFindingsInput(raw: unknown): GenerateFindingsInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...r,
    sources: objectsWithStringKey(r.sources, "id"),
    codeSections: objectsWithStringKey(r.codeSections, "atomId"),
    bimElements: objectsWithStringKey(r.bimElements, "ref"),
  } as unknown as GenerateFindingsInput;
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

    let requestedMode: "grok" | "anthropic";
    try {
      requestedMode = parsed.data.mode ?? resolveFindingMode();
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
      throw err;
    }

    const input = normalizeFindingsInput(parsed.data.input);

    try {
      const llm = engineOptions(requestedMode);
      const result = await generateFindings(input, llm.options);
      return envelopeJson(
        c,
        { result, mode: llm.mode, requestedMode },
        findingsEnvelopeMeta(input, llm.mode, result),
      );
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
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

    let requestedMode: "grok" | "anthropic";
    try {
      requestedMode = parsed.data.mode ?? resolveFindingMode();
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
      throw err;
    }

    const rawOrch = (parsed.data.input ?? {}) as Record<string, unknown>;
    const baseInput = normalizeFindingsInput(rawOrch.baseInput);
    const input = {
      ...rawOrch,
      baseInput,
      pieceCandidates: objectsWithStringKey(rawOrch.pieceCandidates, "pieceId"),
    } as unknown as GenerateOrchestratedFindingsInput;

    try {
      const llm = engineOptions(requestedMode);
      const result = await generateOrchestratedFindings(input, llm.options);
      return envelopeJson(
        c,
        { result, mode: llm.mode, requestedMode },
        findingsEnvelopeMeta(baseInput, llm.mode, result),
      );
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
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
