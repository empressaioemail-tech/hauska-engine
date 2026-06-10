import { describe, expect, it } from "vitest";
import { validateSectionCitations } from "../citationValidator";

const resolvers = {
  isKnownBriefingSourceId: (id: string) => id === "src-known",
  isKnownCodeSectionId: (id: string) => id === "code-known",
};

describe("validateSectionCitations", () => {
  it("keeps tokens with known ids when allowCitations=true", () => {
    const text =
      "Hazard exposure {{atom|briefing-source|src-known|FEMA}} per [[CODE:code-known]].";
    const r = validateSectionCitations(text, resolvers, { allowCitations: true });
    expect(r.cleaned).toBe(text);
    expect(r.invalidTokens).toEqual([]);
  });

  it("strips tokens with unknown ids", () => {
    const text =
      "Hazard {{atom|briefing-source|src-bad|FEMA}} and code [[CODE:code-bad]] cited.";
    const r = validateSectionCitations(text, resolvers, { allowCitations: true });
    expect(r.cleaned).toBe("Hazard  and code  cited.");
    expect(r.invalidTokens).toContain(
      "{{atom|briefing-source|src-bad|FEMA}}",
    );
    expect(r.invalidTokens).toContain("[[CODE:code-bad]]");
  });

  it("strips deprecated colon-shape tokens unconditionally", () => {
    const text =
      "Old shape {{atom:briefing-source:src-known:FEMA}} should never reach the renderer.";
    const r = validateSectionCitations(text, resolvers, { allowCitations: true });
    expect(r.cleaned).not.toContain("{{atom:");
    expect(r.invalidTokens).toContain(
      "{{atom:briefing-source:src-known:FEMA}}",
    );
  });

  it("strips ALL citation tokens when allowCitations=false (sections A + G)", () => {
    const text =
      "Summary {{atom|briefing-source|src-known|FEMA}} with [[CODE:code-known]] tokens.";
    const r = validateSectionCitations(text, resolvers, { allowCitations: false });
    expect(r.cleaned).toBe("Summary  with  tokens.");
    expect(r.invalidTokens).toHaveLength(2);
  });

  it("returns empty invalid list for clean text", () => {
    const r = validateSectionCitations("plain prose only", resolvers, {
      allowCitations: true,
    });
    expect(r.cleaned).toBe("plain prose only");
    expect(r.invalidTokens).toEqual([]);
  });
});
