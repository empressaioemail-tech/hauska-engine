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
  // snapshotDate may be any JSON value on an unshaped bundle; the
  // envelope schema requires a string-or-null dataVintage. Keep only
  // non-empty strings so a garbage vintage cannot fail envelope
  // validation (which would 500 after a successful generation).
  const dataVintage =
    input.sources
      .map((s) => (s as { snapshotDate?: unknown }).snapshotDate)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
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

/** Keep only non-null objects that carry a usable string on `key`. */
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

/**
 * Normalize an unshaped findings input record. The body schema accepts
 * `input` as `z.record`, so array items can be null / non-objects /
 * missing their id field. The engine and the envelope both dereference
 * item fields (input.sources.map(s => s.id), s.snapshotDate, s.atomId)
 * unconditionally, so an item-level garbage bundle 500s. Filter to
 * well-shaped items (dropping the rest) so a malformed bundle degrades
 * to a real (possibly thinner) result instead of a 500 (commitment #1).
 * Filtering, not coercing: a source with no id / a code section with no
 * atomId cannot be cited, so it is dropped rather than fabricated.
 */
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
      pieceCandidates: objectsWithStringKey(rawOrch.pieceCandidates, "pieceId"),
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
