import { describe, expect, it } from "vitest";
import { deduplicateFindings, normalizeFindingText } from "../planSet/dedupe";
import type { EngineFinding } from "../types";

function makeFinding(
  overrides: Partial<EngineFinding> & Pick<EngineFinding, "text">,
): EngineFinding {
  return {
    atomId: overrides.atomId ?? "finding:sub-1:AAA",
    submissionId: overrides.submissionId ?? "sub-1",
    severity: overrides.severity ?? "concern",
    category: overrides.category ?? "other",
    text: overrides.text,
    citations: overrides.citations ?? [
      { kind: "code-section", atomId: "code-1" },
    ],
    confidence: overrides.confidence ?? 0.7,
    lowConfidence: overrides.lowConfidence ?? false,
    elementRef: overrides.elementRef ?? null,
    sourceRef: overrides.sourceRef ?? null,
    aiGeneratedAt: overrides.aiGeneratedAt ?? new Date("2026-06-07T00:00:00Z"),
    discipline: overrides.discipline ?? "building",
  };
}

describe("deduplicateFindings", () => {
  it("collapses identical normalized text and keeps higher confidence", () => {
    const a = makeFinding({
      text: "Same   finding body [[CODE:code-1]]",
      confidence: 0.6,
      atomId: "finding:sub-1:A",
    });
    const b = makeFinding({
      text: "same finding body [[CODE:code-1]]",
      confidence: 0.9,
      atomId: "finding:sub-1:B",
    });
    const { findings, deduplicatedCount } = deduplicateFindings([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.atomId).toBe("finding:sub-1:B");
    expect(deduplicatedCount).toBe(1);
  });

  it("preserves distinct findings", () => {
    const a = makeFinding({ text: "Finding one [[CODE:code-1]]" });
    const b = makeFinding({ text: "Finding two [[CODE:code-1]]" });
    const { findings, deduplicatedCount } = deduplicateFindings([a, b]);
    expect(findings).toHaveLength(2);
    expect(deduplicatedCount).toBe(0);
  });

  it("normalizes whitespace for comparison", () => {
    expect(normalizeFindingText("  Hello\n  world ")).toBe("hello world");
  });
});
