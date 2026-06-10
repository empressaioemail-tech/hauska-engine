/**
 * Grok branch — mocked xAI HTTP via {@link createGrokClient} fetcher stub.
 */

import { describe, expect, it, vi } from "vitest";
import { createGrokClient } from "../../llm/grok.js";
import { callGrokGenerator, resolveGrokFindingModel } from "../grokGenerator";
import type { GenerateFindingsInput } from "../types";

const minimalInput: GenerateFindingsInput = {
  submission: {
    id: "sub-1",
    jurisdiction: "Cedar Hill, TX",
    projectName: "QA-58",
    note: null,
  },
  sources: [],
  codeSections: [{ atomId: "code-1", label: "Setback rule" }],
  bimElements: [],
};

describe("resolveGrokFindingModel", () => {
  it("prefers XAI_FINDING_MODEL over XAI_MODEL", () => {
    const finding = process.env.XAI_FINDING_MODEL;
    const model = process.env.XAI_MODEL;
    process.env.XAI_FINDING_MODEL = "grok-test-finding";
    process.env.XAI_MODEL = "grok-test-general";
    try {
      expect(resolveGrokFindingModel()).toBe("grok-test-finding");
    } finally {
      if (finding === undefined) delete process.env.XAI_FINDING_MODEL;
      else process.env.XAI_FINDING_MODEL = finding;
      if (model === undefined) delete process.env.XAI_MODEL;
      else process.env.XAI_MODEL = model;
    }
  });
});

describe("callGrokGenerator", () => {
  it("parses a mocked OpenAI-shaped completion into drafts", async () => {
    const payload = {
      findings: [
        {
          severity: "concern",
          category: "setback",
          text: "Setback may conflict [[CODE:code-1]].",
          citations: [{ kind: "code-section", atomId: "code-1" }],
          confidence: 0.8,
        },
      ],
    };
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = createGrokClient({
      apiKey: "test-key",
      fetcher: fetcher as typeof fetch,
    });
    const drafts = await callGrokGenerator(client, minimalInput);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.severity).toBe("concern");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
