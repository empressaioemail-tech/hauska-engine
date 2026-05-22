/**
 * entityId disambiguation — bare-numbered embedded-ordinance sections.
 *
 * Municipal codes that adopt their subdivision / zoning ordinances as
 * lettered exhibits (Leander's Code of Ordinances Chapter 10 / 14
 * Exhibit A) number the exhibit's sections with bare integers that
 * restart per article — `Sec. 1.` exists under Article I, II, III ...
 * The atomizer's bare `<tenant>/<edition>/<num>` entityId is not unique
 * for those, so the storage write silently drops all but one.
 *
 * The atomizer pre-scans for sections whose bare entityId collides
 * across ≥2 distinct `sourceAnchor`s and re-keys each by its containing
 * chapter/article path. A corpus with self-scoping section numbers
 * (decimal / chapter-hyphenated) has no collision group and is left
 * byte-identical.
 */

import { describe, expect, it } from "vitest";

import type {
  ArticleNode,
  ChapterNode,
  CodeTreeNode,
  SectionNode,
} from "../../extraction/types.js";
import { atomize } from "../index.js";

function section(
  sectionNumber: string,
  title: string,
  sourceAnchor: string | undefined,
  bodyText: string,
): SectionNode {
  return {
    kind: "section",
    sectionNumber,
    title,
    ...(sourceAnchor ? { sourceAnchor } : {}),
    bodyText,
    children: [],
  };
}

function article(label: string, children: SectionNode[]): ArticleNode {
  return { kind: "article", label, title: `Article ${label}`, children };
}

function chapter(
  label: string,
  title: string,
  children: ArticleNode[],
): ChapterNode {
  return { kind: "chapter", label, title, children };
}

function tree(children: CodeTreeNode["children"]): CodeTreeNode {
  return {
    kind: "code-tree",
    jurisdictionTenant: "leander_tx",
    jurisdictionName: "Leander, TX",
    editionLabel: "Test Edition",
    publicationDate: "2026-01-01",
    sourceAdapter: "municode-html",
    sourceUrl: "https://example.test",
    fetchedAt: "2026-05-21T00:00:00.000Z",
    children,
  };
}

const EDITION = "leander_tx/test-edition";

describe("atomize — bare-numbered section entityId disambiguation", () => {
  it("re-keys colliding bare sections by their containing chapter/article path", () => {
    const result = atomize(
      tree([
        chapter("14", "ZONING", [
          article("I", [
            section(
              "1.",
              "Authority",
              "#CH14ZO_EXHIBIT_AZOOR_ARTIGE_S1AU",
              "This exhibit is adopted under the authority of the city.",
            ),
          ]),
          article("II", [
            section(
              "1.",
              "General",
              "#CH14ZO_EXHIBIT_AZOOR_ARTIIESZORE_S1GE",
              "This article establishes the zoning districts.",
            ),
          ]),
        ]),
        chapter("10", "SUBDIVISION", [
          article("I", [
            section(
              "1.",
              "Definitions",
              "#CH10SURE_EXHIBIT_ASUOR_ARTIGE_S1DE",
              "Terms used in this exhibit are defined here.",
            ),
          ]),
        ]),
      ]),
    );

    const ids = result.sections.map((s) => s.entityId);
    // Three sections all numbered "1." — all three survive, all unique.
    expect(result.sections).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // Each entityId carries its containing chapter/article path, taken
    // from the Municode Doc.Id sourceAnchor (minus the section segment).
    expect(ids).toContain(`${EDITION}/ch14zo-exhibit-azoor-artige/1`);
    expect(ids).toContain(`${EDITION}/ch14zo-exhibit-azoor-artiieszore/1`);
    expect(ids).toContain(`${EDITION}/ch10sure-exhibit-asuor-artige/1`);
    // No section keeps the colliding bare id.
    expect(ids).not.toContain(`${EDITION}/1`);
    // Body text is preserved for every section — nothing dropped.
    const bodies = result.sections.map((s) => s.bodyText).sort();
    expect(bodies).toEqual(
      [
        "Terms used in this exhibit are defined here.",
        "This article establishes the zoning districts.",
        "This exhibit is adopted under the authority of the city.",
      ].sort(),
    );
  });

  it("leaves self-scoping section numbers byte-identical (no collision)", () => {
    const result = atomize(
      tree([
        chapter("1", "INTRODUCTORY", [
          article("I", [
            section("1-1", "Short title", "#PT_CH1_ARTI_S1-1", "The short title."),
            section("1-2", "Authority", "#PT_CH1_ARTI_S1-2", "The authority."),
          ]),
        ]),
        chapter("2", "ZONING DISTRICTS", [
          article("I", [
            section("2-13", "SF-R district", "#PT_CH2_ARTI_S2-13", "The SF-R rules."),
          ]),
        ]),
      ]),
    );
    const ids = result.sections.map((s) => s.entityId).sort();
    // Hyphenated numbers are globally unique — bare ids, no prefix.
    expect(ids).toEqual([
      `${EDITION}/1-1`,
      `${EDITION}/1-2`,
      `${EDITION}/2-13`,
    ]);
  });

  it("does not disambiguate a single section re-emitted under one anchor", () => {
    // The Municode JSON walker emits the same Doc through overlapping
    // TOC paths — two section nodes, identical sourceAnchor. That is a
    // duplicate (storage dedupes it), not a collision: it keeps the
    // bare id rather than being split into two disambiguated atoms.
    const result = atomize(
      tree([
        chapter("3", "BUILDINGS", [
          article("I", [
            section("5.", "Permits", "#CH3_ARTI_S5", "Permit rules."),
          ]),
          article("II", [
            section("5.", "Permits", "#CH3_ARTI_S5", "Permit rules."),
          ]),
        ]),
      ]),
    );
    const ids = result.sections.map((s) => s.entityId);
    expect(ids).toEqual([`${EDITION}/5`, `${EDITION}/5`]);
  });

  it("disambiguates a raw-PDF collision by the page anchor", () => {
    // A raw-PDF source whose anchors are "#pN-section-X" rather than a
    // Municode Doc.Id: the whole anchor is the disambiguator.
    const result = atomize(
      tree([
        chapter("A", "PART A", [
          article("I", [
            section("1", "Scope", "#p4-section-1", "Part A scope."),
          ]),
        ]),
        chapter("B", "PART B", [
          article("I", [
            section("1", "Scope", "#p9-section-1", "Part B scope."),
          ]),
        ]),
      ]),
    );
    const ids = result.sections.map((s) => s.entityId).sort();
    expect(ids).toEqual([
      `${EDITION}/p4-section-1/1`,
      `${EDITION}/p9-section-1/1`,
    ]);
  });
});
