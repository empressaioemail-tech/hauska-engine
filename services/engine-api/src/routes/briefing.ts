import { Hono } from "hono";
import { z } from "zod";

import {
  generateBriefing,
  type GenerateBriefingInput,
} from "@hauska-engine/engine-core/briefing";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { resolveBriefingMode, resolveLlmForMode } from "../lib/llmClients.js";
import { envelopeJson } from "../lib/envelopeResponse.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  knownCodeSectionIds: z.array(z.string()).optional(),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

function dataVintageFromSources(
  sources: ReadonlyArray<{ snapshotDate?: string | null }>,
): string | null {
  const dates = sources
    .map((s) => s.snapshotDate)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  if (dates.length === 0) return null;
  return dates.sort().at(-1) ?? null;
}

export function buildBriefingRoutes(): Hono {
  const app = new Hono();

  app.post("/generate", async (c) => {
    const parsed = generateBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const requestedMode = parsed.data.mode ?? resolveBriefingMode();
    // The body schema accepts `input` as an unshaped record. Normalize the
    // array fields the engine dereferences unconditionally (for EVERY
    // mode, not just mock: engine.ts builds resolver sets from
    // input.sources / input.codeSections) so a minimal or malformed
    // bundle degrades to a real brief instead of throwing a 500
    // (commitment #1). Field-level shape beyond "is an array" is left to
    // the engine, which tolerates empty arrays.
    const rawInput = (parsed.data.input ?? {}) as Record<string, unknown>;
    const input = {
      ...rawInput,
      sources: Array.isArray(rawInput.sources) ? rawInput.sources : [],
      codeSections: Array.isArray(rawInput.codeSections)
        ? rawInput.codeSections
        : [],
    } as unknown as GenerateBriefingInput;

    // Resolve a runnable LLM without throwing on a missing key. A brief
    // must always return a real (or honestly-degraded) result, never a
    // 500 — company commitment #1. The Grok-first / rules-mock ladder
    // lives in resolveLlmForMode.
    const llm = resolveLlmForMode(requestedMode);
    const mode = llm.mode;

    try {
      const result = await generateBriefing(input, {
        mode,
        grokClient: llm.grokClient,
        anthropicClient: llm.anthropicClient,
        knownCodeSectionIds: parsed.data.knownCodeSectionIds,
      });
      const dataVintage = dataVintageFromSources(input.sources ?? []);
      const degradationReasons: string[] = [];
      if (llm.degraded && llm.degradationReason) {
        degradationReasons.push(llm.degradationReason);
      }
      if (result.invalidCitations.length > 0) {
        degradationReasons.push(
          `${result.invalidCitations.length} invalid citation(s) stripped`,
        );
      }
      const coverage =
        degradationReasons.length > 0
          ? degradedCoverage(degradationReasons.join("; "), true)
          : okCoverage();
      return envelopeJson(
        c,
        { result, mode, requestedMode, degraded: llm.degraded },
        {
          confidence: resolveReadPathConfidence({
            codeSections: input.codeSections,
            assertedBaseline: mode === "mock" ? 0.7 : undefined,
          }),
          dataVintage,
          coverage,
          source: {
            adapter: `briefing-engine:${mode}`,
            citationIds: [
              ...(input.sources ?? []).map((s) => s.id),
              ...(input.codeSections ?? []).map((s) => s.atomId),
            ],
          },
        },
      );
    } catch (err) {
      // Last-resort guard: a live-LLM call can still fail (network,
      // upstream 5xx, malformed response). Rather than 500, retry the
      // deterministic mock path so the tile always gets a real brief
      // with an honest degraded flag.
      if (mode !== "mock") {
        try {
          const fallback = await generateBriefing(input, {
            mode: "mock",
            knownCodeSectionIds: parsed.data.knownCodeSectionIds,
          });
          const dataVintage = dataVintageFromSources(input.sources ?? []);
          return envelopeJson(
            c,
            {
              result: fallback,
              mode: "mock",
              requestedMode,
              degraded: true,
            },
            {
              confidence: resolveReadPathConfidence({
                codeSections: input.codeSections,
                assertedBaseline: 0.7,
              }),
              dataVintage,
              coverage: degradedCoverage(
                `${mode} generation failed (${err instanceof Error ? err.message : String(err)}); returned deterministic rules/mock brief`,
                true,
              ),
              source: {
                adapter: "briefing-engine:mock",
                citationIds: [
                  ...(input.sources ?? []).map((s) => s.id),
                  ...(input.codeSections ?? []).map((s) => s.atomId),
                ],
              },
            },
          );
        } catch {
          // fall through to the 500 below only if even mock fails
        }
      }
      return c.json(
        {
          error: "briefing_generation_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}
