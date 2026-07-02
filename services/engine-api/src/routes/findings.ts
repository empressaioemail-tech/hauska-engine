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

/**
 * Normalize an unshaped findings input record. The body schema accepts
 * `input` as `z.record`, and the engine dereferences input.sources /
 * input.codeSections / input.bimElements unconditionally (for every
 * mode). Guarantee those are arrays so a minimal or malformed bundle
 * degrades to a real (possibly empty) result instead of a 500
 * (commitment #1).
 */
function normalizeFindingsInput(raw: unknown): GenerateFindingsInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...r,
    sources: Array.isArray(r.sources) ? r.sources : [],
    codeSections: Array.isArray(r.codeSections) ? r.codeSections : [],
    bimElements: Array.isArray(r.bimElements) ? r.bimElements : [],
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

    const requestedMode = parsed.data.mode ?? resolveFindingMode();
    const input = normalizeFindingsInput(parsed.data.input);
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
      // Last-resort guard: a live-LLM call (or its parse path) can still
      // throw. Retry deterministically in mock mode so the findings tile
      // always gets a real result with an honest degraded flag rather
      // than a 500 (commitment #1).
      if (mode !== "mock") {
        try {
          const fallback = await generateFindings(input, { mode: "mock" });
          const meta = findingsEnvelopeMeta(
            input,
            "mock",
            fallback,
            `${mode} generation failed (${err instanceof Error ? err.message : String(err)}); returned deterministic mock findings`,
          );
          return envelopeJson(
            c,
            { result: fallback, mode: "mock", requestedMode, degraded: true },
            meta,
          );
        } catch {
          // fall through to 500 only if even mock fails
        }
      }
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
    const rawOrch = (parsed.data.input ?? {}) as Record<string, unknown>;
    const baseInput = normalizeFindingsInput(rawOrch.baseInput);
    const input = {
      ...rawOrch,
      baseInput,
      pieceCandidates: Array.isArray(rawOrch.pieceCandidates)
        ? rawOrch.pieceCandidates
        : [],
    } as unknown as GenerateOrchestratedFindingsInput;
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
        findingsEnvelopeMeta(baseInput, mode, result, llm.degradationReason),
      );
    } catch (err) {
      if (mode !== "mock") {
        try {
          const fallback = await generateOrchestratedFindings(input, {
            mode: "mock",
          });
          const meta = findingsEnvelopeMeta(
            baseInput,
            "mock",
            fallback,
            `${mode} orchestrated generation failed (${err instanceof Error ? err.message : String(err)}); returned deterministic mock findings`,
          );
          return envelopeJson(
            c,
            { result: fallback, mode: "mock", requestedMode, degraded: true },
            meta,
          );
        } catch {
          // fall through to 500 only if even mock fails
        }
      }
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
