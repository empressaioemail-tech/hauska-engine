import { describe, expect, it } from "vitest";
import {
  AnthropicGeneratorError,
  parseAnthropicResponse,
} from "../anthropicGenerator";

describe("parseAnthropicResponse", () => {
  it("parses a strict-JSON 7-key response", () => {
    const raw = JSON.stringify({
      a: "summary",
      b: "threshold",
      c: "regulatory",
      d: "infra",
      e: "envelope",
      f: "neighbors",
      g: "checklist",
    });
    const sections = parseAnthropicResponse(raw);
    expect(sections.a).toBe("summary");
    expect(sections.g).toBe("checklist");
  });

  it("tolerates ```json fenced output", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        a: "1",
        b: "2",
        c: "3",
        d: "4",
        e: "5",
        f: "6",
        g: "7",
      }) +
      "\n```";
    const sections = parseAnthropicResponse(raw);
    expect(sections.f).toBe("6");
  });

  it("throws anthropic_invalid_json on bad JSON", () => {
    expect(() => parseAnthropicResponse("not json")).toThrowError(
      AnthropicGeneratorError,
    );
  });

  it("throws anthropic_missing_section when a key is missing", () => {
    const raw = JSON.stringify({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" });
    expect(() => parseAnthropicResponse(raw)).toThrowError(/missing or non-string section "g"/);
  });

  it("throws anthropic_invalid_response_shape on a top-level array", () => {
    expect(() => parseAnthropicResponse("[]")).toThrowError(
      /not a JSON object/,
    );
  });
});
