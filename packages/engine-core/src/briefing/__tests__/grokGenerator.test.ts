/**
 * Grok branch — mocked xAI HTTP via {@link createGrokClient} fetcher stub.
 */

import { describe, expect, it, vi } from "vitest";
import { createGrokClient } from "../../llm/grok.js";
import {
  callGrokGenerator,
  resolveGrokBriefingModel,
} from "../grokGenerator";
import type { GenerateBriefingInput } from "../types";

const minimalInput: GenerateBriefingInput = {
  engagementId: "eng-1",
  sources: [],
  generatedBy: "system:test",
};

const sevenSections = {
  a: "Executive summary.",
  b: "Threshold issues.",
  c: "Regulatory gates.",
  d: "Site infrastructure.",
  e: "Buildable envelope.",
  f: "Neighboring context.",
  g: "Next steps.",
};

describe("resolveGrokBriefingModel", () => {
  it("prefers XAI_BRIEFING_MODEL over XAI_MODEL", () => {
    const briefing = process.env.XAI_BRIEFING_MODEL;
    const model = process.env.XAI_MODEL;
    process.env.XAI_BRIEFING_MODEL = "grok-test-briefing";
    process.env.XAI_MODEL = "grok-test-general";
    try {
      expect(resolveGrokBriefingModel()).toBe("grok-test-briefing");
    } finally {
      if (briefing === undefined) delete process.env.XAI_BRIEFING_MODEL;
      else process.env.XAI_BRIEFING_MODEL = briefing;
      if (model === undefined) delete process.env.XAI_MODEL;
      else process.env.XAI_MODEL = model;
    }
  });
});

describe("callGrokGenerator", () => {
  it("parses a mocked OpenAI-shaped completion into seven sections", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(sevenSections) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = createGrokClient({
      apiKey: "test-key",
      fetcher: fetcher as typeof fetch,
    });
    const sections = await callGrokGenerator(client, minimalInput);
    expect(sections).toEqual(sevenSections);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
