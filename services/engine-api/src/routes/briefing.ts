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
import {
  LlmModeRefusalError,
  LlmResolutionRefusalError,
} from "@hauska-engine/engine-core/llm-mode-refusal";
import { resolveBriefingMode, resolveLlmForMode } from "../lib/llmClients.js";
import { envelopeJson } from "../lib/envelopeResponse.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  knownCodeSectionIds: z.array(z.string()).optional(),
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

function dataVintageFromSources(
  sources: ReadonlyArray<{ snapshotDate?: unknown }>,
): string | null {
  const dates = sources
    .map((s) => s.snapshotDate)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  if (dates.length === 0) return null;
  return dates.sort().at(-1) ?? null;
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

    let requestedMode: "grok" | "anthropic";
    try {
      requestedMode = parsed.data.mode ?? resolveBriefingMode();
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
      throw err;
    }

    const rawInput = (parsed.data.input ?? {}) as Record<string, unknown>;
    const input = {
      ...rawInput,
      sources: objectsWithStringKey(rawInput.sources, "id"),
      codeSections: objectsWithStringKey(rawInput.codeSections, "atomId"),
    } as unknown as GenerateBriefingInput;

    try {
      const llm = resolveLlmForMode(requestedMode);
      const result = await generateBriefing(input, {
        mode: llm.mode,
        grokClient: llm.grokClient,
        anthropicClient: llm.anthropicClient,
        knownCodeSectionIds: parsed.data.knownCodeSectionIds,
      });
      const dataVintage = dataVintageFromSources(input.sources ?? []);
      const degradationReasons: string[] = [];
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
        { result, mode: llm.mode, requestedMode },
        {
          confidence: resolveReadPathConfidence({
            codeSections: input.codeSections,
          }),
          dataVintage,
          coverage,
          source: {
            adapter: `briefing-engine:${llm.mode}`,
            citationIds: [
              ...(input.sources ?? []).map((s) => s.id),
              ...(input.codeSections ?? []).map((s) => s.atomId),
            ],
          },
        },
      );
    } catch (err) {
      const refusal = llmRefusalResponse(c, err);
      if (refusal) return refusal;
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
