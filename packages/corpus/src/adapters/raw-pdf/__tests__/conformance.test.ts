/**
 * Conformance pass for the raw-PDF adapter.
 *
 * Uses a stubbed RespectfulFetch + stubbed text extractor so the suite
 * runs deterministically without any network or pdfjs-dist invocation.
 * The captured fixture mirrors the structural shape of the Bastrop B3
 * Code (the first raw-PDF jurisdiction onboarded under this adapter
 * per the 2026-05-19 Sync 4.5 dispatch).
 */

import { describe, expect, it } from "vitest";

import { runAdapterConformance } from "../../__fixtures__/conformance.js";
import { RespectfulFetch } from "../../http.js";
import { RawPdfAdapter, type PdfPageText, type PdfTextExtractor } from "../index.js";
import type { CodeReference, RawCode } from "../../types.js";

class StubBytesFetch extends RespectfulFetch {
  constructor(private readonly bytes: Uint8Array) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchBytes(): Promise<Uint8Array> {
    return this.bytes;
  }
}

// Two-page fixture in the B3 Code layout. Whole lines (no embedded
// newlines per logical block) so the stub matches what the real pdfjs
// extractor returns after our Y-jump line-break reconstruction.
const FIXTURE_PAGES: ReadonlyArray<PdfPageText> = [
  {
    pageNumber: 24,
    text: [
      "INTRODUCTION",
      "24 of 265",
      "CHAPTER 1: SUBDIVISIONS",
      "ARTICLE 1.1 PROVISION APPLICABLE TO ALL PLATTING PROCEDURES",
      "SEC. 1.1.001 GENERAL PLATTING PROCEDURES",
      "(a) All plats submitted under this Article shall comply with Sec. 1.2.003 and Article 1.4.",
      "(b) See § 5.04(b) for additional dimensional standards.",
      "(1) The applicant must file within the deadline as defined in Chapter 2.",
    ].join("\n"),
  },
  {
    pageNumber: 25,
    text: [
      "INTRODUCTION",
      "25 of 265",
      "SEC. 1.1.002 DORMANT FINAL SUBDIVISION PLATS",
      "(a) A plat is dormant when it has not been recorded within 18 months.",
      "Notwithstanding Sec. 1.1.001, dormant plats are subject to Article 1.3.",
    ].join("\n"),
  },
];

const stubExtractor: PdfTextExtractor = async () => FIXTURE_PAGES;

const fixtureReference: CodeReference = {
  sourceId: "bastrop-b3-april-2025",
  jurisdictionTenant: "bastrop-tx",
  editionLabel: "Bastrop Building Block (B3) Code — April 2025",
  sourceUrl:
    "https://www.cityofbastrop.org/upload/page/0107/docs/B3/B3%20Code%20-%20April%202025.pdf",
};

// One byte is enough — the stub textExtractor ignores body content.
// The adapter just needs `raw.body.length > 0` to take the extraction
// path through normalize().
const stubBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" marker

const adapter = new RawPdfAdapter({
  textExtractor: stubExtractor,
  http: new StubBytesFetch(stubBytes),
});

runAdapterConformance({ adapter, fixtureReference });

describe("RawPdfAdapter — content-specific (B3 fixture)", () => {
  it("emits chapter, article, section headings at the right depths", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const headings = normalized.blocks.filter((b) => b.kind === "heading");
    const depths = new Set(headings.map((h) => (h.kind === "heading" ? h.depth : -1)));
    expect(depths.has(1)).toBe(true); // chapter
    expect(depths.has(2)).toBe(true); // article
    expect(depths.has(3)).toBe(true); // section

    const chapter = headings.find(
      (h) => h.kind === "heading" && h.depth === 1,
    );
    const article = headings.find(
      (h) => h.kind === "heading" && h.depth === 2,
    );
    const section = headings.find(
      (h) => h.kind === "heading" && h.depth === 3,
    );

    // Heading text is the canonical signal; the extractor's
    // splitHeadingLabel parses sectionNumber + title from it via the
    // "Sec." / "Article" / "Chapter" abbrev forms.
    expect(chapter && chapter.kind === "heading" ? chapter.text : "").toMatch(
      /^Chapter 1/,
    );
    expect(article && article.kind === "heading" ? article.text : "").toMatch(
      /^Article 1\.1/,
    );
    expect(section && section.kind === "heading" ? section.text : "").toMatch(
      /^Sec\. 1\.1\.001/,
    );
  });

  it("attaches subsection labels to paragraph blocks", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const paragraphs = normalized.blocks.filter(
      (b) => b.kind === "paragraph",
    );
    expect(paragraphs.length).toBeGreaterThan(0);
    const labels = paragraphs
      .map((p) => (p.kind === "paragraph" ? p.subsectionLabel : undefined))
      .filter((s): s is string => Boolean(s));
    expect(labels).toContain("(a)");
    expect(labels).toContain("(b)");
    // Nested-numeric subsection composes onto the prior alpha label.
    expect(labels.some((l) => l.startsWith("(b)") && l.endsWith("(1)"))).toBe(
      true,
    );
  });

  it("extracts cross-references with the right reference types", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const xrefs = normalized.blocks.filter(
      (b) => b.kind === "cross-reference",
    );
    expect(xrefs.length).toBeGreaterThanOrEqual(4);
    const labels = xrefs.map((x) =>
      x.kind === "cross-reference" ? x.targetSectionLabel : undefined,
    );
    expect(labels).toContain("1.2.003");
    expect(labels).toContain("1.4");
    expect(labels).toContain("5.04(b)");
    expect(labels).toContain("2");
    // Notwithstanding paragraph emits a typed reference.
    const types = new Set(
      xrefs.map((x) =>
        x.kind === "cross-reference" ? x.referenceType : undefined,
      ),
    );
    expect(types.has("notwithstanding")).toBe(true);
  });

  it("suppresses page-number boilerplate from the block stream", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const hasPageMarker = normalized.blocks.some(
      (b) =>
        (b.kind === "paragraph" && b.text.match(/^\d+ of 265$/)) ||
        (b.kind === "heading" && b.text.match(/^\d+ of 265$/)),
    );
    expect(hasPageMarker).toBe(false);
  });

  it("fetch() returns a base64 body when extractor is configured", async () => {
    const raw = await adapter.fetch(fixtureReference);
    expect(raw.contentType).toBe("application/pdf");
    expect(raw.body.length).toBeGreaterThan(0);
    // Base64 of "%PDF" is "JVBERg==".
    expect(raw.body).toBe("JVBERg==");
  });

  it("falls back to empty blocks when body is empty", async () => {
    const emptyAdapter = new RawPdfAdapter({
      textExtractor: stubExtractor,
      http: new StubBytesFetch(new Uint8Array([])),
    });
    // Empty bytes still go through fetch() — body becomes "" (Buffer
    // base64 of an empty array is the empty string), which normalize()
    // treats as not-loadable.
    const raw = await emptyAdapter.fetch(fixtureReference);
    expect(raw.body).toBe("");
    const normalized = await emptyAdapter.normalize(raw);
    expect(normalized.blocks).toEqual([]);
  });
});

// Synthetic fixture in the Hutto UDC layout: a front-matter table of
// contents, then body pages whose chapter label lives in the running
// header and whose sections use the decimal-dotted `10.NNN` numbering.
// Page 16 also carries a per-chapter mini-table-of-contents run that
// must be skipped in favor of the real headings.
const HUTTO_FIXTURE_PAGES: ReadonlyArray<PdfPageText> = [
  {
    pageNumber: 5,
    text: [
      "City of Hutto Unified Development Code",
      "Revised March 2024",
      "Contents",
      "10.101 Title 1",
      "10.102 Purpose 1",
    ].join("\n"),
  },
  {
    pageNumber: 16,
    text: [
      "Chapter 1 Introduction §10.101 Title",
      "1",
      "City of Hutto Unified Development Code",
      "Revised March 2024",
      "10.101 Title 1",
      "10.102 Purpose 1",
      "10.101 Title",
      "This ordinance is known as the Hutto UDC.",
      "10.102 Purpose",
      "This code is enacted to promote orderly development. See §10.101 for naming.",
    ].join("\n"),
  },
  {
    pageNumber: 44,
    text: [
      "Chapter 2 Development review §10.201 General rules",
      "44",
      "City of Hutto Unified Development Code",
      "Revised March 2024",
      "10.201 General rules",
      "All development shall comply with this code.",
    ].join("\n"),
  },
];

const huttoExtractor: PdfTextExtractor = async () => HUTTO_FIXTURE_PAGES;

const huttoAdapter = new RawPdfAdapter({
  textExtractor: huttoExtractor,
  http: new StubBytesFetch(stubBytes),
  normalizeOptions: { headingConvention: "decimal-numbered" },
  capabilitiesNameOverride: "hutto-udc-pdf",
});

describe("RawPdfAdapter — decimal-numbered convention (Hutto UDC)", () => {
  it("opens chapter containers from the per-page running header", async () => {
    const raw = await huttoAdapter.fetch(fixtureReference);
    const normalized = await huttoAdapter.normalize(raw);
    const chapters = normalized.blocks
      .filter((b) => b.kind === "heading" && b.depth === 1)
      .map((b) => (b.kind === "heading" ? b.text : ""));
    expect(chapters).toEqual([
      "Chapter 1 Introduction",
      "Chapter 2 Development review",
    ]);
  });

  it("emits decimal-numbered section headings at depth 3", async () => {
    const raw = await huttoAdapter.fetch(fixtureReference);
    const normalized = await huttoAdapter.normalize(raw);
    const sections = normalized.blocks
      .filter((b) => b.kind === "heading" && b.depth === 3)
      .map((b) => (b.kind === "heading" ? b.text : ""));
    expect(sections).toEqual([
      "10.101 Title",
      "10.102 Purpose",
      "10.201 General rules",
    ]);
  });

  it("skips front matter and per-chapter mini-table-of-contents runs", async () => {
    const raw = await huttoAdapter.fetch(fixtureReference);
    const normalized = await huttoAdapter.normalize(raw);
    // TOC / mini-TOC entries carry a trailing page number; none should
    // survive as a heading or paragraph block.
    const polluted = normalized.blocks.some((b) => {
      const text =
        b.kind === "heading" || b.kind === "paragraph" ? b.text : "";
      return /^10\.\d+ .*\s\d+$/.test(text);
    });
    expect(polluted).toBe(false);
    const hasContents = normalized.blocks.some(
      (b) => b.kind === "paragraph" && b.text === "Contents",
    );
    expect(hasContents).toBe(false);
  });

  it("captures rule prose and cross-references in the body", async () => {
    const raw = await huttoAdapter.fetch(fixtureReference);
    const normalized = await huttoAdapter.normalize(raw);
    const paragraphs = normalized.blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => (b.kind === "paragraph" ? b.text : ""));
    expect(paragraphs).toContain("This ordinance is known as the Hutto UDC.");
    const xrefLabels = normalized.blocks
      .filter((b) => b.kind === "cross-reference")
      .map((x) => (x.kind === "cross-reference" ? x.targetSectionLabel : ""));
    expect(xrefLabels).toContain("10.101");
  });
});

// Synthetic fixture in the Taylor "Taylor Made" Land Development Code
// layout: a front-matter table of contents, then body pages whose
// chapter label is a standalone all-caps heading (repeated as a running
// header) and whose sections use chapter-scoped decimal numbering
// (`1.1`, `1.2.1`, `1.9.1.1`, `2.1`). Publisher running-header
// boilerplate and `chapter - page` page-number lines are interleaved.
const TAYLOR_FIXTURE_PAGES: ReadonlyArray<PdfPageText> = [
  {
    pageNumber: 4,
    text: [
      "TAYLOR MADE LAND DEVELOPMENT ORDINANCE 4",
      "TABLE OF CONTENTS",
      "CHAPTER 1 - INTENT & GENERAL PROVISIONS 6",
      "1.1 TITLE 7",
      "1.2 PURPOSE 7",
      "CHAPTER 2 - DEVELOPMENT PROCESS 20",
    ].join("\n"),
  },
  {
    pageNumber: 7,
    text: [
      "TAYLOR MADE LAND DEVELOPMENT ORDINANCE",
      "CHAPTER 1 - INTENT AND GENERAL PROVISIONS",
      "1 - 7",
      "1.1 TITLE.",
      "This Ordinance shall be known as the Land Development Code.",
      "1.2 PURPOSE.",
      "1.2.1 The purpose of this LDC is to align policies.",
      "This code shall be read together with Section 1.1 for naming.",
    ].join("\n"),
  },
  {
    pageNumber: 8,
    text: [
      "TAYLOR MADE LAND DEVELOPMENT ORDINANCE",
      "CHAPTER 1 - INTENT AND GENERAL PROVISIONS",
      "1 - 8",
      "1.9.1.1 Any annexed land shall be classified P2 Rural.",
      "Reclassification follows the procedure in this Chapter.",
      // Flowchart fragment: "LOTS OVER 2.5 ACRES" split across boxes.
      // The decimal-leading "2.5 ACRES" must not promote to a heading.
      "LOTS OVER",
      "2.5 ACRES",
    ].join("\n"),
  },
  {
    pageNumber: 21,
    text: [
      "TAYLOR MADE LAND DEVELOPMENT ORDINANCE",
      "CHAPTER 2 - DEVELOPMENT PROCESS",
      "2 - 21",
      "2.1 PROCESS OVERVIEW.",
      "The development process begins with a pre-application meeting.",
    ].join("\n"),
  },
];

const taylorExtractor: PdfTextExtractor = async () => TAYLOR_FIXTURE_PAGES;

const taylorAdapter = new RawPdfAdapter({
  textExtractor: taylorExtractor,
  http: new StubBytesFetch(stubBytes),
  normalizeOptions: {
    headingConvention: "chapter-decimal",
    ignoreLineRegex: /^TAYLOR MADE LAND DEVELOPMENT ORDINANCE/i,
  },
  capabilitiesNameOverride: "taylor-ldc-pdf",
});

describe("RawPdfAdapter — chapter-decimal convention (Taylor LDC)", () => {
  it("opens chapter containers from standalone all-caps headings", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    const chapters = normalized.blocks
      .filter((b) => b.kind === "heading" && b.depth === 1)
      .map((b) => (b.kind === "heading" ? b.text : ""));
    // The chapter-1 heading repeats as a running header on page 8; it
    // must be emitted exactly once. Chapter 2 opens on page 21.
    expect(chapters).toEqual([
      "Chapter 1 INTENT AND GENERAL PROVISIONS",
      "Chapter 2 DEVELOPMENT PROCESS",
    ]);
  });

  it("emits chapter-scoped decimal section headings at depth 3", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    const sections = normalized.blocks
      .filter((b) => b.kind === "heading" && b.depth === 3)
      .map((b) => (b.kind === "heading" ? b.text : ""));
    expect(sections).toEqual([
      "1.1 TITLE.",
      "1.2 PURPOSE.",
      "1.2.1 The purpose of this LDC is to align policies.",
      "1.9.1.1 Any annexed land shall be classified P2 Rural.",
      "2.1 PROCESS OVERVIEW.",
    ]);
  });

  it("skips the table of contents and its page-referenced entries", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    // No TOC entry (heading-like text + trailing page number) survives,
    // and the "TABLE OF CONTENTS" label itself is dropped.
    const polluted = normalized.blocks.some((b) => {
      const text =
        b.kind === "heading" || b.kind === "paragraph" ? b.text : "";
      return /\s\d{1,4}$/.test(text) || /^TABLE OF CONTENTS$/i.test(text);
    });
    expect(polluted).toBe(false);
  });

  it("suppresses running-header boilerplate and page-number lines", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    const noisy = normalized.blocks.some((b) => {
      const text =
        b.kind === "heading" || b.kind === "paragraph" ? b.text : "";
      return (
        /^TAYLOR MADE LAND DEVELOPMENT ORDINANCE/i.test(text) ||
        /^\d{1,2}\s*-\s*\d{1,4}$/.test(text)
      );
    });
    expect(noisy).toBe(false);
  });

  it("captures rule prose and cross-references in the body", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    const paragraphs = normalized.blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => (b.kind === "paragraph" ? b.text : ""));
    expect(paragraphs).toContain(
      "This Ordinance shall be known as the Land Development Code.",
    );
    const xrefLabels = normalized.blocks
      .filter((b) => b.kind === "cross-reference")
      .map((x) => (x.kind === "cross-reference" ? x.targetSectionLabel : ""));
    expect(xrefLabels).toContain("1.1");
  });

  it("does not promote a decimal measurement to a section heading", async () => {
    const raw = await taylorAdapter.fetch(fixtureReference);
    const normalized = await taylorAdapter.normalize(raw);
    // "2.5 ACRES" is a flowchart quantity, not a section. It must not
    // appear as a heading; it stays in the block stream as body prose.
    const headingTexts = normalized.blocks
      .filter((b) => b.kind === "heading")
      .map((b) => (b.kind === "heading" ? b.text : ""));
    expect(headingTexts.some((t) => /^2\.5\b/.test(t))).toBe(false);
    const paragraphTexts = normalized.blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => (b.kind === "paragraph" ? b.text : ""));
    expect(paragraphTexts).toContain("2.5 ACRES");
  });
});

describe("RawPdfAdapter — deferred-stub behavior (no hooks)", () => {
  // Preserves the original empty-blocks behavior when callers
  // explicitly opt out of both hooks. Used by the early conformance
  // suite check-in before the first raw-PDF jurisdiction landed.
  const stubAdapter = new RawPdfAdapter({
    textExtractor: undefined,
    ocr: undefined,
  });

  it("fetch() returns an empty body", async () => {
    const raw = await stubAdapter.fetch(fixtureReference);
    expect(raw.body).toBe("");
  });

  it("normalize() returns empty blocks", async () => {
    const raw = await stubAdapter.fetch(fixtureReference);
    const normalized = await stubAdapter.normalize(raw);
    expect(normalized.blocks).toEqual([]);
  });
});
