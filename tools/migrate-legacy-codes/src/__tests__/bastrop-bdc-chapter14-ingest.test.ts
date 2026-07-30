import { describe, expect, it } from "vitest";

import {
  BDC_EDITION_ENTITY_ID,
  buildBdcSectionAtoms,
  parseChapter14Sections,
} from "../bastrop-bdc-chapter14-ingest.js";

describe("parseChapter14Sections", () => {
  it("extracts Sec. 14.02.003 and skips TOC leaders", () => {
    const pages = [
      {
        pageNumber: 4,
        text: [
          "CHAPTER 14 TABLE OF CONTENTS",
          "Sec. 14.02.003 District Requirements ..................................................................... 7",
          "Sec. 14.02.004 Development Patterns. ................................................................. 23",
        ].join("\n"),
      },
      {
        pageNumber: 10,
        text: [
          "ARTICLE 14.02 ZONING DISTRICTS",
          "Sec. 14.02.001 Establishment of Zoning Districts.",
          "Districts include SF-1.",
          "Sec. 14.02.003 District Requirements",
          "A. Parks and Open Space (P/OS)",
          "3) Dimensional Standards Chart:",
          "SF-1 Front Setback 30 feet Side Setback 10 feet",
          "Sec. 14.02.004 Development Patterns.",
          "Pattern rules follow.",
        ].join("\n"),
      },
    ];

    const parsed = parseChapter14Sections(pages);
    expect(parsed.map((s) => s.sectionNumber)).toEqual([
      "14.02.001",
      "14.02.003",
      "14.02.004",
    ]);
    const dim = parsed.find((s) => s.sectionNumber === "14.02.003");
    expect(dim?.title).toMatch(/District Requirements/i);
    expect(dim?.bodyText).toMatch(/Front Setback 30 feet/);
    expect(dim?.bodyText).not.toMatch(/Development Patterns/);
  });

  it("builds atoms onto the existing BDC stub entityId", () => {
    const atoms = buildBdcSectionAtoms(
      [
        {
          sectionNumber: "14.02.003",
          title: "District Requirements",
          bodyText: "SF-1 30/10/20/30",
          pageStart: 10,
        },
      ],
      {
        fetchedAt: "2026-07-29T00:00:00.000Z",
        sourceUrl: "https://example.com/ord.pdf",
      },
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.codeEditionId).toBe(BDC_EDITION_ENTITY_ID);
    expect(atoms[0]!.entityId).toBe(`${BDC_EDITION_ENTITY_ID}/14-02-003`);
    expect(atoms[0]!.sectionNumber).toBe("14.02.003");
  });
});
