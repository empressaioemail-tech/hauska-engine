/**
 * Unit tests for the anthropic-branch parser. The actual SDK call is
 * exercised via a hand-rolled `Anthropic`-shaped stub so the parser
 * narrowing logic is the unit under test, not the SDK itself.
 *
 * Pinned behavior:
 *   - strict-JSON parse with markdown-fence tolerance
 *   - per-finding shape narrowing (severity / category enum guards,
 *     citation kind discrimination, confidence clamping, optional
 *     fields)
 *   - typed error codes for every failure mode the route's catch
 *     branch reads
 */

import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  callAnthropicGenerator,
  FindingGeneratorError,
  parseAnthropicResponse,
} from "../anthropicGenerator";
import type { GenerateFindingsInput } from "../types";

const minimalInput: GenerateFindingsInput = {
  submission: {
    id: "sub-1",
    jurisdiction: "Bastrop, TX",
    projectName: "Test",
    note: null,
  },
  sources: [],
  codeSections: [
    { atomId: "code-1", label: "Test Rule" },
  ],
  bimElements: [],
};

function stub(json: string | { content: { type: string; text: string }[] }): Anthropic {
  const create = vi.fn(async () => {
    if (typeof json === "string") {
      return { content: [{ type: "text", text: json }] };
    }
    return json;
  });
  return { messages: { create } } as unknown as Anthropic;
}

describe("parseAnthropicResponse: happy path", () => {
  it("parses a clean JSON object into shape-narrowed drafts", () => {
    const drafts = parseAnthropicResponse(
      JSON.stringify({
        findings: [
          {
            severity: "blocker",
            category: "setback",
            text: "Sample text [[CODE:code-1]].",
            citations: [{ kind: "code-section", atomId: "code-1" }],
            confidence: 0.9,
            lowConfidence: false,
            elementRef: "wall:x",
            sourceRef: { id: "src-1", label: "Source 1" },
          },
        ],
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      severity: "blocker",
      category: "setback",
      confidence: 0.9,
      lowConfidence: false,
      elementRef: "wall:x",
      sourceRef: { id: "src-1", label: "Source 1" },
    });
  });

  it("tolerates a ```json fence wrapper", () => {
    const fenced =
      "```json\n" +
      JSON.stringify({
        findings: [
          {
            severity: "concern",
            category: "egress",
            text: "Cited rule [[CODE:code-1]].",
            citations: [{ kind: "code-section", atomId: "code-1" }],
            confidence: 0.5,
            lowConfidence: true,
          },
        ],
      }) +
      "\n```";
    const drafts = parseAnthropicResponse(fenced);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.severity).toBe("concern");
  });

  it("returns an empty array when the model emits no findings", () => {
    const drafts = parseAnthropicResponse(JSON.stringify({ findings: [] }));
    expect(drafts).toEqual([]);
  });

  it("clamps a too-large confidence into [0, 1]", () => {
    const drafts = parseAnthropicResponse(
      JSON.stringify({
        findings: [
          {
            severity: "advisory",
            category: "other",
            text: "Note [[CODE:code-1]].",
            citations: [{ kind: "code-section", atomId: "code-1" }],
            confidence: 5,
            lowConfidence: false,
          },
        ],
      }),
    );
    expect(drafts[0]!.confidence).toBe(1);
  });

  it("treats missing optional fields as null", () => {
    const drafts = parseAnthropicResponse(
      JSON.stringify({
        findings: [
          {
            severity: "advisory",
            category: "use",
            text: "Note [[CODE:code-1]].",
            citations: [{ kind: "code-section", atomId: "code-1" }],
            confidence: 0.7,
            lowConfidence: false,
          },
        ],
      }),
    );
    expect(drafts[0]!.elementRef).toBeNull();
    expect(drafts[0]!.sourceRef).toBeNull();
  });
});

describe("parseAnthropicResponse: error paths", () => {
  it("throws anthropic_invalid_json on unparseable text", () => {
    expect(() => parseAnthropicResponse("not-json")).toThrow(
      FindingGeneratorError,
    );
    try {
      parseAnthropicResponse("not-json");
    } catch (err) {
      expect((err as FindingGeneratorError).code).toBe("anthropic_invalid_json");
    }
  });

  it("throws anthropic_invalid_response_shape when the response is an array", () => {
    expect(() => parseAnthropicResponse(JSON.stringify([1, 2, 3]))).toThrow(
      /not a JSON object/,
    );
  });

  it("throws anthropic_invalid_response_shape when findings is missing", () => {
    expect(() =>
      parseAnthropicResponse(JSON.stringify({ other: "field" })),
    ).toThrow(/findings/);
  });

  it("throws anthropic_invalid_finding_shape on a bad severity", () => {
    expect(() =>
      parseAnthropicResponse(
        JSON.stringify({
          findings: [
            {
              severity: "critical",
              category: "setback",
              text: "Hi [[CODE:code-1]].",
              citations: [{ kind: "code-section", atomId: "code-1" }],
              confidence: 0.5,
              lowConfidence: false,
            },
          ],
        }),
      ),
    ).toThrow(/severity must be one of/);
  });

  it("throws anthropic_invalid_finding_shape on a bad category", () => {
    expect(() =>
      parseAnthropicResponse(
        JSON.stringify({
          findings: [
            {
              severity: "blocker",
              category: "fenestration",
              text: "Hi [[CODE:code-1]].",
              citations: [{ kind: "code-section", atomId: "code-1" }],
              confidence: 0.5,
              lowConfidence: false,
            },
          ],
        }),
      ),
    ).toThrow(/category must be one of/);
  });

  it("throws anthropic_invalid_finding_shape on a citation with unknown kind", () => {
    expect(() =>
      parseAnthropicResponse(
        JSON.stringify({
          findings: [
            {
              severity: "blocker",
              category: "setback",
              text: "Hi.",
              citations: [{ kind: "scribbled-note", atomId: "x" }],
              confidence: 0.5,
              lowConfidence: false,
            },
          ],
        }),
      ),
    ).toThrow(/unknown kind/);
  });
});

describe("callAnthropicGenerator", () => {
  it("forwards the system + user prompts and returns parsed drafts", async () => {
    const json = JSON.stringify({
      findings: [
        {
          severity: "blocker",
          category: "setback",
          text: "Cited [[CODE:code-1]].",
          citations: [{ kind: "code-section", atomId: "code-1" }],
          confidence: 0.9,
          lowConfidence: false,
        },
      ],
    });
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: json }],
    }));
    const client = { messages: { create } } as unknown as Anthropic;

    const drafts = await callAnthropicGenerator(client, minimalInput);
    expect(drafts).toHaveLength(1);
    expect(create).toHaveBeenCalledOnce();
    const firstCall = create.mock.calls[0] as unknown as [Record<string, unknown>];
    const args = firstCall[0];
    expect(args.model).toBe("claude-sonnet-4-5");
    expect(args.max_tokens).toBe(6144);
    // System prompt + user message are both populated.
    expect(typeof args.system).toBe("string");
    expect(Array.isArray(args.messages)).toBe(true);
  });

  it("wraps SDK exceptions as FindingGeneratorError(anthropic_call_failed)", async () => {
    const client = stub("");
    (client.messages.create as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error("network down");
      },
    );
    await expect(
      callAnthropicGenerator(client, minimalInput),
    ).rejects.toMatchObject({
      code: "anthropic_call_failed",
      message: expect.stringContaining("network down"),
    });
  });

  it("throws anthropic_invalid_response_shape when the SDK returns no text blocks", async () => {
    const client = stub({ content: [] });
    await expect(
      callAnthropicGenerator(client, minimalInput),
    ).rejects.toMatchObject({
      code: "anthropic_invalid_response_shape",
    });
  });

  it("concatenates multiple text blocks before parsing", async () => {
    const client = stub({
      content: [
        { type: "text", text: '{"findings":[' },
        {
          type: "text",
          text:
            '{"severity":"advisory","category":"other","text":"Body [[CODE:code-1]] suffix.","citations":[{"kind":"code-section","atomId":"code-1"}],"confidence":0.5,"lowConfidence":false}',
        },
        { type: "text", text: "]}" },
      ],
    });
    const drafts = await callAnthropicGenerator(client, minimalInput);
    expect(drafts).toHaveLength(1);
  });
});
