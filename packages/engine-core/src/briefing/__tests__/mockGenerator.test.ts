import { describe, expect, it } from "vitest";
import { generateMockBriefing } from "../mockGenerator";
import type { BriefingSourceInput, GenerateBriefingInput } from "../types";

const src = (overrides: Partial<BriefingSourceInput>): BriefingSourceInput => ({
  id: overrides.id ?? "src-1",
  layerKind: overrides.layerKind ?? "qgis-zoning",
  sourceKind: overrides.sourceKind ?? "manual-upload",
  provider: overrides.provider ?? null,
  snapshotDate: overrides.snapshotDate ?? "2026-04-01",
  note: overrides.note ?? null,
});

const input = (
  overrides: Partial<GenerateBriefingInput> = {},
): GenerateBriefingInput => ({
  engagementId: overrides.engagementId ?? "eng-1",
  sources: overrides.sources ?? [],
  codeSections: overrides.codeSections,
  generatedBy: overrides.generatedBy ?? "system:test",
});

describe("generateMockBriefing", () => {
  it("returns all seven A–G keys, each non-empty", () => {
    const result = generateMockBriefing(input());
    for (const key of ["a", "b", "c", "d", "e", "f", "g"] as const) {
      expect(result[key]).toBeTruthy();
      expect(result[key].length).toBeGreaterThan(0);
    }
  });

  it("emits gap notes when no sources are present", () => {
    const result = generateMockBriefing(input());
    expect(result.b).toMatch(/No threshold-issue overlays/);
    expect(result.c).toMatch(/No zoning \/ overlay/);
    expect(result.d).toMatch(/No utility/);
    expect(result.e).toMatch(/No parcel/);
    expect(result.f).toMatch(/No neighboring-context/);
  });

  it("never emits citation tokens in section A or G", () => {
    const result = generateMockBriefing(
      input({
        sources: [
          src({ id: "s-flood", layerKind: "fema-flood", provider: "FEMA" }),
        ],
      }),
    );
    expect(result.a).not.toContain("{{atom|");
    expect(result.a).not.toContain("[[CODE:");
    expect(result.g).not.toContain("{{atom|");
    expect(result.g).not.toContain("[[CODE:");
  });

  it("only emits the pipe-delimited token shape (never the deprecated colon shape)", () => {
    const result = generateMockBriefing(
      input({
        sources: [
          src({ id: "s-flood", layerKind: "fema-flood", provider: "FEMA" }),
          src({ id: "s-zone", layerKind: "qgis-zoning", provider: "QGIS" }),
        ],
      }),
    );
    for (const key of ["b", "c", "d", "e", "f"] as const) {
      expect(result[key]).not.toMatch(/\{\{atom:/);
    }
    expect(result.b).toContain("{{atom|briefing-source|s-flood|FEMA}}");
    expect(result.c).toContain("{{atom|briefing-source|s-zone|QGIS}}");
  });

  it("cites code sections in section C using [[CODE:...]] tokens", () => {
    const result = generateMockBriefing(
      input({
        codeSections: [{ atomId: "code-1", label: "IBC 1604.5" }],
      }),
    );
    expect(result.c).toContain("[[CODE:code-1]]");
  });

  it("uses real source ids in tokens (so the citation validator's known-id path is exercised)", () => {
    const result = generateMockBriefing(
      input({
        sources: [src({ id: "src-known-id", layerKind: "fema-flood" })],
      }),
    );
    expect(result.b).toContain("src-known-id");
  });
});
