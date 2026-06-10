import { Hono } from "hono";
import { z } from "zod";

import {
  generateBriefing,
  type GenerateBriefingInput,
} from "@hauska-engine/engine-core/briefing";
import {
  getAnthropicClient,
  getGrokClient,
  resolveBriefingMode,
} from "../lib/llmClients.js";

const generateBodySchema = z.object({
  input: z.record(z.unknown()),
  knownCodeSectionIds: z.array(z.string()).optional(),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

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
      return c.json({ result, mode });
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
