import { describe, expect, it } from "vitest";
import { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "../prompt";
import type { BriefingSourceInput, GenerateBriefingInput } from "../types";

const src = (overrides: Partial<BriefingSourceInput>): BriefingSourceInput => ({
  id: overrides.id ?? "src-1",
  layerKind: overrides.layerKind ?? "qgis-zoning",
  sourceKind: overrides.sourceKind ?? "manual-upload",
  provider: overrides.provider ?? null,
  snapshotDate: overrides.snapshotDate ?? "2026-04-01",
  note: overrides.note ?? null,
  payload: overrides.payload,
});

const baseInput = (
  overrides: Partial<GenerateBriefingInput> = {},
): GenerateBriefingInput => ({
  engagementId: overrides.engagementId ?? "eng-1",
  engagementLabel: overrides.engagementLabel,
  sources: overrides.sources ?? [],
  codeSections: overrides.codeSections,
  generatedBy: overrides.generatedBy ?? "system:test",
});

describe("BRIEFING_SYSTEM_PROMPT", () => {
  it("instructs the model to emit only the pipe-delimited token shape", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      "{{atom|briefing-source|<id>|<displayLabel>}}",
    );
    expect(BRIEFING_SYSTEM_PROMPT).toContain("[[CODE:<atomId>]]");
    expect(BRIEFING_SYSTEM_PROMPT).toContain("forbidden");
  });
  it("forbids citations in section A and G", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(
      /Section A and Section G cite NOTHING/,
    );
  });
  it("requires JSON output with all seven keys", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toContain('"a"');
    expect(BRIEFING_SYSTEM_PROMPT).toContain('"g"');
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/All seven keys present/);
  });
});

describe("buildUserPrompt", () => {
  it("groups sources by section and tags heavy vs tight", () => {
    const prompt = buildUserPrompt(
      baseInput({
        sources: [
          src({ id: "s-flood", layerKind: "fema-flood", provider: "FEMA" }),
          src({ id: "s-zone", layerKind: "qgis-zoning", provider: "QGIS" }),
          src({ id: "s-water", layerKind: "water-main", provider: "Utility" }),
          src({ id: "s-parcel", layerKind: "parcel-polygon" }),
          src({ id: "s-neigh", layerKind: "parcel-neighbors" }),
        ],
      }),
    );
    // Heavy/tight markers per Spec 51 §1.2.
    expect(prompt).toContain("B — Threshold Issues (HEAVY)");
    expect(prompt).toContain("C — Regulatory Gates (TIGHT)");
    expect(prompt).toContain("D — Site Infrastructure (TIGHT)");
    expect(prompt).toContain("E — Buildable Envelope (HEAVY)");
    expect(prompt).toContain("F — Neighboring Context (HEAVY)");
    expect(prompt).toContain("G — Next-Step Checklist (HEAVY)");
    // Sources land under the right section header.
    expect(prompt).toMatch(/B —[\s\S]*id=s-flood/);
    expect(prompt).toMatch(/C —[\s\S]*id=s-zone/);
    expect(prompt).toMatch(/D —[\s\S]*id=s-water/);
    expect(prompt).toMatch(/E —[\s\S]*id=s-parcel/);
    expect(prompt).toMatch(/F —[\s\S]*id=s-neigh/);
  });

  it("emits a gap-note instruction when a section has no sources", () => {
    const prompt = buildUserPrompt(baseInput({ sources: [] }));
    // All five citing sections should have the gap-note hint.
    const matches = prompt.match(/No briefing-sources mapped/g) ?? [];
    expect(matches.length).toBe(5);
  });

  it("lists code sections at the top of the user prompt", () => {
    const prompt = buildUserPrompt(
      baseInput({
        codeSections: [
          { atomId: "code-1", label: "IBC 1604.5", snippet: "Risk Category I" },
        ],
      }),
    );
    expect(prompt).toContain("Code sections available for citation");
    expect(prompt).toContain("atomId=code-1");
    expect(prompt).toContain("IBC 1604.5");
  });

  it("includes the displayLabel that callers should embed in tokens", () => {
    const prompt = buildUserPrompt(
      baseInput({
        sources: [src({ id: "s-flood", layerKind: "fema-flood", provider: "FEMA" })],
      }),
    );
    expect(prompt).toMatch(/displayLabel \(use in citation token\): FEMA/);
  });

  it("surfaces uncategorized sources in their own block", () => {
    const prompt = buildUserPrompt(
      baseInput({ sources: [src({ id: "weird", layerKind: "custom-thing" })] }),
    );
    expect(prompt).toContain("Uncategorized briefing-sources");
    expect(prompt).toContain("id=weird");
  });
});
