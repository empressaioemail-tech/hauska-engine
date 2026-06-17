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
  getAnthropicClient,
  getGrokClient,
  resolveBriefingMode,
} from "../lib/llmClients.js";
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

    const mode = parsed.data.mode ?? resolveBriefingMode();
    const input = parsed.data.input as unknown as GenerateBriefingInput;

    try {
      const result = await generateBriefing(input, {
        mode,
        grokClient: mode === "grok" ? getGrokClient() : undefined,
        anthropicClient: mode === "anthropic" ? getAnthropicClient() : undefined,
        knownCodeSectionIds: parsed.data.knownCodeSectionIds,
      });
      const dataVintage = dataVintageFromSources(input.sources ?? []);
      const coverage =
        result.invalidCitations.length > 0
          ? degradedCoverage(
              `${result.invalidCitations.length} invalid citation(s) stripped`,
              true,
            )
          : okCoverage();
      return envelopeJson(
        c,
        { result, mode },
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
