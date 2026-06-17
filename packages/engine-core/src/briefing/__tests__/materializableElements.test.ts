/**
 * Unit coverage for the materializable-element extractor.
 *
 * Sections A / B / E / G are intentionally NOT scanned even when they
 * carry sentence-level claims — Spec 51 §6 only flags C / D / F as
 * containing turn-into-Revit-element design constraints.
 */

import { describe, expect, it } from "vitest";
import {
  extractMaterializableElements,
  splitSectionClaims,
} from "../materializableElements";
import type { BriefingSections } from "../types";

const sections = (overrides: Partial<BriefingSections>): BriefingSections => ({
  a: "Executive summary text.",
  b: "Threshold issue text.",
  c: "Section C is empty.",
  d: "Section D is empty.",
  e: "Envelope text.",
  f: "Section F is empty.",
  g: "- Step one.",
  ...overrides,
});

describe("splitSectionClaims", () => {
  it("returns [] for empty / whitespace-only input", () => {
    expect(splitSectionClaims("")).toEqual([]);
    expect(splitSectionClaims("   \n  ")).toEqual([]);
  });

  it("splits sentence-terminating periods, keeping each period attached", () => {
    expect(
      splitSectionClaims("First claim. Second claim. Third claim."),
    ).toEqual(["First claim.", "Second claim.", "Third claim."]);
  });

  it("preserves citation tokens inside the claim text", () => {
    const body =
      "Layer A on file {{atom|briefing-source|src-1|FEMA}}. Code [[CODE:c-1]] applies.";
    expect(splitSectionClaims(body)).toEqual([
      "Layer A on file {{atom|briefing-source|src-1|FEMA}}.",
      "Code [[CODE:c-1]] applies.",
    ]);
  });
});

describe("extractMaterializableElements", () => {
  it("only walks sections C, D, F per Spec 51 §6", () => {
    const elements = extractMaterializableElements(
      sections({
        a: "Should be ignored.",
        b: "Should be ignored.",
        c: "Section C claim.",
        d: "Section D claim.",
        e: "Should be ignored.",
        f: "Section F claim.",
        g: "Should be ignored.",
      }),
    );
    expect(elements.map((e) => e.section)).toEqual(["c", "d", "f"]);
    expect(elements.map((e) => e.text)).toEqual([
      "Section C claim.",
      "Section D claim.",
      "Section F claim.",
    ]);
  });

  it("emits one element per sentence within each scanned section, indexed from 0", () => {
    const elements = extractMaterializableElements(
      sections({
        c: "Claim C0. Claim C1. Claim C2.",
        d: "Claim D0.",
        f: "",
      }),
    );
    expect(elements).toEqual([
      { section: "c", index: 0, text: "Claim C0." },
      { section: "c", index: 1, text: "Claim C1." },
      { section: "c", index: 2, text: "Claim C2." },
      { section: "d", index: 0, text: "Claim D0." },
    ]);
  });
});
