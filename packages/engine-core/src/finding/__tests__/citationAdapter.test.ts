/**
 * Unit tests for the citation-adapter shim.
 *
 * The actual validator (`validateSectionCitations`) is owned and
 * tested by `../briefing/index.js`; we only re-cover the
 * AIR-1-specific contract:
 *   - `validateInlineCitations` always allows citations (no Section
 *     A/G stripping)
 *   - the function name is the only API surface AIR-1 callers should
 *     touch (decision Ask #1 — reuse, not factor-out)
 */

import { describe, expect, it } from "vitest";
import { validateInlineCitations } from "../citationAdapter";

const resolvers = {
  isKnownCodeSectionId: (id: string) => id.startsWith("code-"),
  isKnownBriefingSourceId: (id: string) => id.startsWith("src-"),
};

describe("validateInlineCitations", () => {
  it("preserves tokens whose ids resolve", () => {
    const text = `Cited rule [[CODE:code-real]] and source {{atom|briefing-source|src-real|Bastrop UDC}}.`;
    const { cleaned, invalidTokens } = validateInlineCitations(text, resolvers);
    expect(invalidTokens).toEqual([]);
    expect(cleaned).toBe(text);
  });

  it("strips tokens whose code-section atom id does not resolve", () => {
    const text = `Real [[CODE:code-real]] and fake [[CODE:bogus]] together.`;
    const { cleaned, invalidTokens } = validateInlineCitations(text, resolvers);
    expect(invalidTokens).toEqual(["[[CODE:bogus]]"]);
    expect(cleaned).not.toContain("bogus");
    expect(cleaned).toContain("code-real");
  });

  it("strips tokens whose briefing-source id does not resolve", () => {
    const text = `Real {{atom|briefing-source|src-real|Real}} and fake {{atom|briefing-source|fakeid|Fake}}.`;
    const { cleaned, invalidTokens } = validateInlineCitations(text, resolvers);
    expect(invalidTokens).toEqual([
      "{{atom|briefing-source|fakeid|Fake}}",
    ]);
    expect(cleaned).not.toContain("fakeid");
  });

  it("strips deprecated `{{atom:type:id:label}}` shape unconditionally", () => {
    const text = `Old shape {{atom:briefing-source:src-real:Real}} alongside body.`;
    const { cleaned, invalidTokens } = validateInlineCitations(text, resolvers);
    expect(invalidTokens).toEqual([
      "{{atom:briefing-source:src-real:Real}}",
    ]);
    expect(cleaned).not.toContain("{{atom:");
  });

  it("returns the input verbatim when there are no tokens at all", () => {
    const text = `A finding body with no citation tokens.`;
    const { cleaned, invalidTokens } = validateInlineCitations(text, resolvers);
    expect(cleaned).toBe(text);
    expect(invalidTokens).toEqual([]);
  });
});
