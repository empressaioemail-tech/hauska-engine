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
