import { Hono } from "hono";
import { z } from "zod";

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

const chatBodySchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  ),
  mode: z.enum(["mock", "grok", "anthropic"]).optional(),
});

export function buildChatRoutes(): Hono {
  const app = new Hono();

  app.post("/complete", async (c) => {
    const parsed = chatBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const mode = parsed.data.mode ?? resolveBriefingMode();
    const lastUser = [...parsed.data.messages]
      .reverse()
      .find((m) => m.role === "user");

    if (!lastUser) {
      return envelopeJson(
        c,
        { status: "empty", reply: "", mode },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0 }),
          dataVintage: null,
          coverage: degradedCoverage("no user message in chat request"),
          source: { adapter: `chat:${mode}` },
        },
      );
    }

    if (mode === "mock") {
      return envelopeJson(
        c,
        {
          reply: `Mock chat acknowledgement: received ${lastUser.content.length} chars.`,
          mode,
        },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0.6 }),
          dataVintage: null,
          coverage: okCoverage(),
          source: { adapter: "chat:mock" },
        },
      );
    }

    try {
      if (mode === "grok") {
        const client = getGrokClient();
        const system =
          parsed.data.messages.find((m) => m.role === "system")?.content ??
          "You are a helpful planning assistant.";
        const user = lastUser.content;
        const reply = await client.completeChat({
          model: process.env.BRIEFING_GROK_MODEL ?? "grok-3-mini",
          system,
          user,
          maxTokens: 1024,
        });
        return envelopeJson(
          c,
          { reply, mode },
          {
            confidence: resolveReadPathConfidence({ assertedBaseline: 0.72 }),
            dataVintage: null,
            coverage: okCoverage(),
            source: { adapter: "chat:grok" },
          },
        );
      }

      const anthropic = getAnthropicClient();
      const response = await anthropic.messages.create({
        model: process.env.BRIEFING_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: parsed.data.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
      });
      const textBlock = response.content.find((b) => b.type === "text");
      return envelopeJson(
        c,
        {
          reply: textBlock && textBlock.type === "text" ? textBlock.text : "",
          mode,
        },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0.78 }),
          dataVintage: null,
          coverage: okCoverage(),
          source: { adapter: "chat:anthropic" },
        },
      );
    } catch (err) {
      return envelopeJson(
        c,
        {
          status: "error",
          reply: "",
          message: err instanceof Error ? err.message : String(err),
          mode,
        },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0 }),
          dataVintage: null,
          coverage: degradedCoverage("chat completion failed"),
          source: { adapter: `chat:${mode}` },
        },
      );
    }
  });

  return app;
}
