/**
 * Unit tests for the deterministic mock generator. The fixture is
 * the canonical "valid output" the engine emits in mock mode; these
 * tests pin that the citation tokens it inlines correspond to the
 * `citations` array (so the validator's resolver sees a coherent
 * pair) and that the fixture suppresses findings whose citation
 * prerequisites are missing.
 */

import { describe, expect, it } from "vitest";
import { generateMockFindings } from "../mockGenerator";
import type { GenerateFindingsInput } from "../types";

const baseInput = (
  overrides: Partial<GenerateFindingsInput> = {},
): GenerateFindingsInput => ({
  submission: overrides.submission ?? {
    id: "sub-mock",
    jurisdiction: "Bastrop, TX",
    projectName: "Mock Project",
    note: null,
  },
  sources: overrides.sources ?? [
    {
      id: "src-1",
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "Bastrop UDC",
      snapshotDate: "2026-01-01",
      note: null,
    },
  ],
  codeSections: overrides.codeSections ?? [
    { atomId: "code-1", label: "Sample Rule" },
  ],
  bimElements: overrides.bimElements ?? [
    { ref: "wall:north-side-l2", label: "North wall, L2" },
  ],
});

describe("generateMockFindings", () => {
  it("emits up to three findings (1 blocker, 1 concern, 1 advisory) with full inputs", () => {
    const findings = generateMockFindings(baseInput());
    expect(findings.map((f) => f.severity).sort()).toEqual([
      "advisory",
      "blocker",
      "concern",
    ]);
  });

  it("inlines citation tokens that match the citations array exactly", () => {
    const findings = generateMockFindings(baseInput());
    for (const f of findings) {
      for (const c of f.citations) {
        if (c.kind === "code-section") {
          expect(f.text).toContain(`[[CODE:${c.atomId}]]`);
        } else {
          expect(f.text).toContain(
            `{{atom|briefing-source|${c.id}|${c.label}}}`,
          );
        }
      }
    }
  });

  it("anchors the blocker on the first BIM element when present", () => {
    const findings = generateMockFindings(baseInput());
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker?.elementRef).toBe("wall:north-side-l2");
  });

  it("suppresses the blocker when no briefing-source is supplied", () => {
    const findings = generateMockFindings(baseInput({ sources: [] }));
    const severities = findings.map((f) => f.severity).sort();
    expect(severities).toEqual(["advisory", "concern"]);
  });

  it("emits zero findings when neither code-sections nor sources are supplied", () => {
    const findings = generateMockFindings(
      baseInput({ codeSections: [], sources: [] }),
    );
    expect(findings).toEqual([]);
  });

  it("stamps each finding with the input's submission id", () => {
    const findings = generateMockFindings(
      baseInput({
        submission: {
          id: "sub-deadbeef",
          jurisdiction: null,
          projectName: null,
          note: null,
        },
      }),
    );
    for (const f of findings) expect(f.submissionId).toBe("sub-deadbeef");
  });

  it("stamps every finding with the same `aiGeneratedAt` (fixture-determinism)", () => {
    const fixed = new Date("2026-04-01T00:00:00.000Z");
    const findings = generateMockFindings(baseInput(), () => fixed);
    for (const f of findings) expect(f.aiGeneratedAt).toEqual(fixed);
  });

  it("uses provider as the citation displayLabel; falls back to layerKind when provider is null", () => {
    const findings = generateMockFindings(
      baseInput({
        sources: [
          {
            id: "src-1",
            layerKind: "fema-flood",
            sourceKind: "federal-adapter",
            provider: null,
            snapshotDate: "2026-02-01",
            note: null,
          },
        ],
      }),
    );
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker?.citations).toContainEqual({
      kind: "briefing-source",
      id: "src-1",
      label: "fema-flood",
    });
  });

  it("low-confidence is set on the concern (per fixture rubric)", () => {
    const findings = generateMockFindings(baseInput());
    const concern = findings.find((f) => f.severity === "concern");
    expect(concern?.lowConfidence).toBe(true);
    const blocker = findings.find((f) => f.severity === "blocker");
    expect(blocker?.lowConfidence).toBe(false);
  });

  it("atomId carries the `finding:{submissionId}:` prefix", () => {
    const findings = generateMockFindings(baseInput());
    for (const f of findings) {
      expect(f.atomId.startsWith("finding:sub-mock:")).toBe(true);
    }
  });
});
