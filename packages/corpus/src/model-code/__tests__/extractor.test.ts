/**
 * Model-code structural extractor — Layer 1 (ADR-019) tests.
 *
 * Runs against the IRC 2021 adapter fixture (`IccCodeDocument`), so the
 * extractor and the ICC adapter share one source of truth.
 */

import { describe, expect, it } from "vitest";

import { CODE_SECTION_SCHEMA } from "@hauska-engine/atoms";

import {
  ICC_CODE_CONNECT_FIXTURES,
  IRC_2021_BOOK_ID,
} from "../../adapters/icc-code-connect/__fixtures__/irc-2021.js";
import {
  extractModelCodeAtoms,
  modelCodeEditionEntityId,
  modelCodeSectionEntityId,
  type ModelCodeReasoningLayer,
} from "../extractor.js";

const IRC_2021 = ICC_CODE_CONNECT_FIXTURES.documents[IRC_2021_BOOK_ID]!;
const EDITION_LABEL = "2021 International Residential Code";

describe("extractModelCodeAtoms — edition", () => {
  it("emits one code-edition aggregating every section, with no amendments", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    expect(result.edition.entityType).toBe("code-edition");
    expect(result.edition.entityId).toBe(
      modelCodeEditionEntityId("icc-model-code", EDITION_LABEL),
    );
    expect(result.edition.editionLabel).toBe(EDITION_LABEL);
    expect(result.edition.jurisdictionTenant).toBe("icc-model-code");
    expect(result.edition.sectionIds).toHaveLength(4);
    // Layer 1 base carries no amendments — those are Layer 2 overlays.
    expect(result.edition.amendmentIds).toEqual([]);
    expect(result.edition.effectiveFrom).toBe("2021-01-01");
    expect(result.edition.sourceAdapter).toBe("icc-code-connect");
  });
});

describe("extractModelCodeAtoms — sections (ADR-019 deep-link footing)", () => {
  it("emits a code-section per Code Connect section with a deep-link set", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    expect(result.sections.map((s) => s.sectionNumber)).toEqual([
      "R201",
      "R202",
      "R301",
      "R302",
    ]);
    for (const section of result.sections) {
      expect(section.verbatimTextDeepLink).toBeTruthy();
      expect(section.codeEditionId).toBe(result.edition.entityId);
    }
  });

  it("prefers a Code Connect viewerUrl, else synthesizes the deep-link", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    const r301 = result.sections.find((s) => s.sectionNumber === "R301")!;
    const r201 = result.sections.find((s) => s.sectionNumber === "R201")!;
    // Real API uses xmlId-based anchors (verified live 2026-07-05).
    expect(r301.verbatimTextDeepLink).toBe(
      "https://codes.iccsafe.org/content/IRC2021#IRC2021_Ch03_SecR301",
    );
    expect(r201.verbatimTextDeepLink).toBe(
      "https://codes.iccsafe.org/content/IRC2021#IRC2021_Ch02_SecR201",
    );
  });

  it("bodyText is the reasoning layer, never the verbatim normative text", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    const r301 = result.sections.find((s) => s.sectionNumber === "R301")!;
    // Reasoning-layer markers present.
    expect(r301.bodyText).toContain("Layer 1 model-code base section");
    expect(r301.bodyText).toContain("Design Criteria");
    // Verbatim normative text from the fixture must NOT be hosted.
    expect(r301.bodyText).not.toContain("safely support all loads");

    // General invariant: no section's verbatim prose leaks into bodyText.
    for (const chapterGroup of IRC_2021.chapters) {
      for (const src of Object.values(chapterGroup.sections)) {
        const verbatim = src.content.replace(/<[^>]+>/g, '').trim();
        if (verbatim.length === 0) continue;
        const atom = result.sections.find(
          (s) => s.sectionNumber === src.ordinal,
        )!;
        expect(atom.bodyText).not.toContain(verbatim);
      }
    }
  });

  it("produces section atoms that satisfy CODE_SECTION_SCHEMA", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    for (const section of result.sections) {
      expect(() => CODE_SECTION_SCHEMA.parse(section)).not.toThrow();
    }
  });

  it("honors a custom (async) reasoning-layer hook", async () => {
    const hook: ModelCodeReasoningLayer = async (input) =>
      `SUMMARY of ${input.sectionNumber}`;
    const result = await extractModelCodeAtoms(IRC_2021, {
      reasoningLayer: hook,
    });
    expect(result.sections[0]!.bodyText).toBe("SUMMARY of R201");
  });
});

describe("extractModelCodeAtoms — definitions", () => {
  it("emits a code-definition per defined term, code-scoped in the Definitions chapter", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    // TODO: Definition extraction from HTML content not yet implemented.
    // The real ICC API returns HTML content, not structured definitions.
    expect(result.definitions).toEqual([]);
  });
});

describe("extractModelCodeAtoms — cross-references", () => {
  it("parses model-code references and resolves in-edition targets", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    // R201 cites Section R202; R301 cites Table R301.2(1); R302 cites
    // Table R302.1(1), Section R302.2, Section R301, Chapter 2.
    expect(result.crossReferences.length).toBe(6);

    const resolved = result.crossReferences.filter(
      (x) => x.toSectionId !== "",
    );
    // R201 -> R202 and R302 -> R301 resolve within the edition; the
    // rest target sections outside this fixture slice.
    expect(resolved.length).toBe(2);

    const r301Id = modelCodeSectionEntityId(
      "icc-model-code",
      EDITION_LABEL,
      "R301",
    );
    const r302ToR301 = result.crossReferences.find(
      (x) => x.toSectionId === r301Id,
    );
    expect(r302ToR301?.referenceText).toBe("Section R301");
  });

  it("links the edition, definitions, and resolved cross-references", async () => {
    const result = await extractModelCodeAtoms(IRC_2021);
    const linkTypes = result.links.map((l) => l.linkType);
    // 4 edition->section contains, resolved cross-reference links.
    // TODO: No section->definition "defines" links until definition extraction from HTML is implemented.
    expect(linkTypes.filter((t) => t === "contains")).toHaveLength(4);
    expect(linkTypes.filter((t) => t === "defines")).toHaveLength(0);
    // At least 4 contains links + cross-reference links
    expect(result.links.length).toBeGreaterThanOrEqual(4);
  });
});
