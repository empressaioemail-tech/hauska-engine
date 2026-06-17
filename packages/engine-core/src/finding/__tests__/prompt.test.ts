/**
 * Snapshot-style tests for the prompt assembly layer.
 *
 * The prompt is the LLM contract surface: changing wording here
 * changes model behavior. These tests pin the load-bearing structural
 * properties (XML block boundaries, presence of citation rules,
 * narrative-excerpt cap, snippet cap) without freezing every word —
 * that lets us tweak prose without churning the test file, but a
 * structural regression (e.g. forgetting the `<reference_code_atoms>`
 * block) breaks compilation immediately.
 */

import { describe, expect, it } from "vitest";
import {
  FINDING_SYSTEM_PROMPT,
  buildUserPrompt,
  PROMPT_NARRATIVE_MAX_CHARS,
  PROMPT_CODE_SNIPPET_MAX_CHARS,
} from "../prompt";
import type { GenerateFindingsInput } from "../types";

const baseInput = (
  overrides: Partial<GenerateFindingsInput> = {},
): GenerateFindingsInput => ({
  submission: {
    id: "sub-prompt",
    jurisdiction: "Bastrop, TX",
    projectName: "Sample Project",
    note: null,
  },
  briefingNarrative: overrides.briefingNarrative,
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

describe("FINDING_SYSTEM_PROMPT", () => {
  it("locks the citation-token grammar in plain text", () => {
    expect(FINDING_SYSTEM_PROMPT).toContain("[[CODE:<atomId>]]");
    expect(FINDING_SYSTEM_PROMPT).toContain(
      "{{atom|briefing-source|<id>|<displayLabel>}}",
    );
  });

  it("forbids the deprecated atom-token shape", () => {
    expect(FINDING_SYSTEM_PROMPT).toMatch(
      /deprecated.*\{\{atom:type:id:label\}\}.*forbidden/s,
    );
  });

  it("locks the severity rubric and category enum", () => {
    expect(FINDING_SYSTEM_PROMPT).toMatch(/blocker.*concern.*advisory/s);
    expect(FINDING_SYSTEM_PROMPT).toContain(
      "setback | height | coverage | egress | use | overlay-conflict | divergence-related | other",
    );
  });

  it("instructs the model to emit strict JSON with a top-level `findings` array", () => {
    expect(FINDING_SYSTEM_PROMPT).toContain('"findings"');
    expect(FINDING_SYSTEM_PROMPT).toMatch(/MAY be empty/i);
  });
});

describe("buildUserPrompt", () => {
  it("emits a `<submission>` block with the project metadata", () => {
    const out = buildUserPrompt(baseInput());
    expect(out).toContain("<submission>");
    expect(out).toContain("</submission>");
    expect(out).toContain("id: sub-prompt");
    expect(out).toContain("projectName: Sample Project");
    expect(out).toContain("jurisdiction: Bastrop, TX");
  });

  it("includes a `<bim_elements>` block when BIM elements are provided", () => {
    const out = buildUserPrompt(baseInput());
    expect(out).toContain("<bim_elements>");
    expect(out).toContain("ref=wall:north-side-l2");
  });

  it("omits the `<bim_elements>` block when no elements are provided", () => {
    const out = buildUserPrompt(baseInput({ bimElements: [] }));
    expect(out).not.toContain("<bim_elements>");
  });

  it("emits `<reference_code_atoms>` and `<reference_briefing_sources>` blocks for the resolver", () => {
    const out = buildUserPrompt(baseInput());
    expect(out).toContain("<reference_code_atoms>");
    expect(out).toContain("atomId=code-1");
    expect(out).toContain("<reference_briefing_sources>");
    expect(out).toContain("id=src-1");
  });

  it("includes the briefing excerpt when a narrative is provided", () => {
    const narrative = "Section A — Executive Summary: this parcel sits in a wildfire zone.";
    const out = buildUserPrompt(baseInput({ briefingNarrative: narrative }));
    expect(out).toContain("<briefing>");
    expect(out).toContain("wildfire zone");
  });

  it("hard-trims the briefing narrative to PROMPT_NARRATIVE_MAX_CHARS", () => {
    const long = "x".repeat(PROMPT_NARRATIVE_MAX_CHARS + 500);
    const out = buildUserPrompt(baseInput({ briefingNarrative: long }));
    // The block contains an ellipsis when trimmed.
    expect(out).toContain("…");
    // The full overrun is NOT present.
    expect(out).not.toContain("x".repeat(PROMPT_NARRATIVE_MAX_CHARS + 1));
  });

  it("hard-trims a code-section snippet to PROMPT_CODE_SNIPPET_MAX_CHARS", () => {
    const longSnippet = "y".repeat(PROMPT_CODE_SNIPPET_MAX_CHARS + 200);
    const out = buildUserPrompt(
      baseInput({
        codeSections: [{ atomId: "code-long", label: "Long", snippet: longSnippet }],
      }),
    );
    expect(out).toContain("…");
    expect(out).not.toContain("y".repeat(PROMPT_CODE_SNIPPET_MAX_CHARS + 1));
  });

  it("uses provider as the displayLabel hint when provided, falls back to layerKind", () => {
    const withProvider = buildUserPrompt(
      baseInput({
        sources: [
          {
            id: "src-1",
            layerKind: "fema-flood",
            sourceKind: "federal-adapter",
            provider: "FEMA",
            snapshotDate: "2026-02-01",
            note: null,
          },
        ],
      }),
    );
    expect(withProvider).toContain("displayLabel (use in citation token): FEMA");

    const noProvider = buildUserPrompt(
      baseInput({
        sources: [
          {
            id: "src-2",
            layerKind: "fema-flood",
            sourceKind: "federal-adapter",
            provider: null,
            snapshotDate: "2026-02-01",
            note: null,
          },
        ],
      }),
    );
    expect(noProvider).toContain(
      "displayLabel (use in citation token): fema-flood",
    );
  });

  it("ends with a closing instruction restating the JSON-only output requirement", () => {
    const out = buildUserPrompt(baseInput());
    expect(out).toMatch(/strict JSON only/);
  });
});
