import { Hono } from "hono";
import { z } from "zod";

import {
  generateFindings,
  generateOrchestratedFindings,
  type GenerateFindingsInput,
  type GenerateOrchestratedFindingsInput,
} from "@hauska-engine/engine-core/finding";
import {
  getAnthropicClient,
  getGrokClient,
  resolveFindingMode,
} from "../lib/llmClients.js";

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
      return c.json({ result, mode });
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
      return c.json({ result, mode });
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
