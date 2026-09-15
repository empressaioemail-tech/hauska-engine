/**
 * 504.2.2 gate for the OPT-IN tagged site-plan export.
 *
 * This suite is the armed mechanism behind the claim. It executes under
 * `pnpm test` in `.github/workflows/ci.yml`, it is triggered by every push and
 * pull request to main, and it exits non-zero when a structural property is
 * missing, when the reading order reads backwards, when the fragmentation
 * share regresses, or when the tagging pass moves a single glyph.
 *
 * Every check here is also EXERCISED AGAINST A KNOWN VIOLATION in the
 * "instruments can fail" block at the bottom. A check observed only passing has
 * not been observed working, and two instruments in this same effort were
 * silently wrong until they were run against a deliberate failure: `is True`
 * against a pypdf BooleanObject reported six conformant PDFs as unmarked, and
 * `bool(BooleanObject(False))` would have reported an unmarked PDF as marked.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { boundaryEdgesForRing } from "../../../__tests__/boundary-edge-fixture.js";
import { composeSitePlanModel } from "../../../site-model.js";
import type { EmitPdfSitePlanOptions } from "../../render.js";
import { ContentStreamRefusal, groupGlyphRuns, parseContentStream } from "../content-stream.js";
import { emitTaggedPdfSitePlan } from "../emit-site-plan.js";
import { countReadingOrderInversions } from "../reading-order.js";
import { tagPdfBytes } from "../tag-pdf.js";

/** 1x1 red PNG: a real decodable image, so the aerial path runs with no network. */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const aerialStub: EmitPdfSitePlanOptions = { aerial: { fetchImage: async () => TINY_PNG } };

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7,
    200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};
const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
  [-98.4998, 29.4001],
];
const setback = {
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: {
    atomDid: "san_antonio_tx/udc/35-310.01/35-310.01",
    role: "rule",
    entityType: "code-section",
  },
};
const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
  { role: "front", feet: 10 },
  { role: "side", feet: 5 },
  { role: "rear", feet: 20 },
  { role: "side", feet: 5 },
]);

function buildModel() {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    boundaryEdges,
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Instruments. Deliberately re-derived here from the finished BYTES rather than
// imported from the writer: a checker that shares the writer's code cannot
// detect the writer being wrong.
// ────────────────────────────────────────────────────────────────────────────

async function pageStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    if (contents === undefined) continue;
    const streams: PDFStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const entry = contents.lookup(i);
        if (entry instanceof PDFStream) streams.push(entry);
      }
    } else {
      streams.push(contents);
    }
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      out.push(Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"));
    }
  }
  return out;
}

interface Draw {
  page: number;
  x: number;
  y: number;
  size: number;
  hex: string;
}

/**
 * Every glyph-showing operation with its absolute text-space position.
 *
 * COUNTING RULE: one entry per `<hex> Tj`, positioned by the running text
 * matrix (`Tm` absolute, `T*` by the current leading), sized by the last `Tf`.
 * Two documents put the same ink in the same place if and only if these
 * sequences are equal.
 */
function drawsOf(streams: string[]): Draw[] {
  const draws: Draw[] = [];
  streams.forEach((stream, page) => {
    let x = 0;
    let y = 0;
    let size = 0;
    let leading = 0;
    for (const rawLine of stream.split("\n")) {
      const line = rawLine.trim();
      const tf = /^\/(\S+)\s+(-?[\d.]+)\s+Tf$/.exec(line);
      if (tf) {
        size = Number(tf[2]);
        continue;
      }
      const tl = /^(-?[\d.]+)\s+TL$/.exec(line);
      if (tl) {
        leading = Number(tl[1]);
        continue;
      }
      const tm = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm$/.exec(
        line,
      );
      if (tm) {
        x = Number(tm[5]);
        y = Number(tm[6]);
        continue;
      }
      if (line === "T*") {
        y -= leading;
        continue;
      }
      const tj = /^<([0-9A-Fa-f]+)>\s+Tj$/.exec(line);
      if (tj) draws.push({ page, x, y, size, hex: tj[1]!.toUpperCase() });
    }
  });
  return draws;
}

/**
 * FRAGMENTATION RULE, stated at the point of use: over all `BT .. ET` text
 * objects in the document, the share whose total glyph count is exactly one.
 * A renderer that draws a letter-spaced word one `drawText` per character puts
 * every letter in its own text object; that is the defect, and this is its
 * direct measure. It is an operator-level rule and it is NOT the pypdf
 * `extract_text()` line rule used outside CI; the two numbers differ and both
 * are reported rather than reconciled away.
 */
function singleGlyphTextObjectShare(streams: string[]): { total: number; single: number; pct: number } {
  let total = 0;
  let single = 0;
  for (const stream of streams) {
    const lines = stream.split("\n").map((l) => l.trim());
    let inText = false;
    let glyphs = 0;
    for (const line of lines) {
      if (line === "BT") {
        inText = true;
        glyphs = 0;
        continue;
      }
      if (line === "ET") {
        if (inText) {
          total += 1;
          if (glyphs === 1) single += 1;
        }
        inText = false;
        continue;
      }
      const tj = /^<([0-9A-Fa-f]+)>\s+Tj$/.exec(line);
      if (inText && tj) glyphs += tj[1]!.length / 4;
    }
  }
  return { total, single, pct: total === 0 ? 0 : (100 * single) / total };
}

/**
 * The four catalog-level properties 504.2.2 turns on, read straight off the
 * trailer. `marked` compares the SERIALISED token, not a truthiness test:
 * `/Marked false` must read as false, and a naive object-truthiness check
 * returns true for it. That exact fail-open was found in the sibling Python
 * instrument during this work.
 */
async function catalogFacts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const catalog = doc.catalog;
  const markInfo = catalog.lookup(PDFName.of("MarkInfo"));
  const marked =
    markInfo instanceof PDFDict ? String(markInfo.get(PDFName.of("Marked"))) === "true" : false;
  const lang = catalog.lookup(PDFName.of("Lang"));
  return {
    hasStructTreeRoot: catalog.get(PDFName.of("StructTreeRoot")) !== undefined,
    marked,
    langValue: lang === undefined ? "" : String(lang).replace(/^\(|\)$/g, ""),
    title: doc.getTitle() ?? "",
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe("tagged site-plan export (504.2.2)", { timeout: 120_000 }, () => {
  it("writes a structure tree, /MarkInfo, /Lang and a title, and reads in visual order", async () => {
    const result = await emitTaggedPdfSitePlan(buildModel(), aerialStub);

    expect(result.tagging.readingOrderInversions).toBe(0);
    expect(result.tagging.unmarkedRawSegments).toBe(0);
    expect(result.tagging.taggedRuns).toBeGreaterThan(50);

    const facts = await catalogFacts(result.bytes);
    expect(facts.hasStructTreeRoot).toBe(true);
    expect(facts.marked).toBe(true);
    expect(facts.langValue).toContain("en");
    expect(facts.title).toContain("1127 N PINE ST");
    expect(facts.title).toContain("48029:105129");
  });

  it("cuts single-glyph text objects from the majority of the document to under 5 percent", async () => {
    const result = await emitTaggedPdfSitePlan(buildModel(), aerialStub);

    const before = singleGlyphTextObjectShare(await pageStreams(result.untaggedBytes));
    const after = singleGlyphTextObjectShare(await pageStreams(result.bytes));

    // The SAME instrument on both inputs: it must register the defect on the
    // default output, or its verdict on the tagged output means nothing.
    expect(before.pct).toBeGreaterThan(50);
    expect(after.pct).toBeLessThan(5);
    expect(after.single).toBeLessThan(before.single);
  });

  it("moves no ink: every glyph keeps its font size and absolute position", async () => {
    const result = await emitTaggedPdfSitePlan(buildModel(), aerialStub);
    const before = drawsOf(await pageStreams(result.untaggedBytes));
    const after = drawsOf(await pageStreams(result.bytes));

    expect(after.length).toBe(before.length);
    expect(after).toEqual(before);
  });

  it("leaves the default export untouched: the untagged bytes are a valid 3-page PDF with no structure tree", async () => {
    const result = await emitTaggedPdfSitePlan(buildModel(), aerialStub);
    const facts = await catalogFacts(result.untaggedBytes);
    expect(result.render.pageCount).toBe(3);
    expect(facts.hasStructTreeRoot).toBe(false);
    expect(facts.marked).toBe(false);
  });
});

describe("the instruments can fail", () => {
  it("the reading-order counter fires on a reversed order", () => {
    const rows = [
      { x: 10, y: 700 },
      { x: 10, y: 680 },
      { x: 10, y: 660 },
      { x: 10, y: 640 },
    ];
    expect(countReadingOrderInversions(rows)).toBe(0);
    expect(countReadingOrderInversions([...rows].reverse())).toBe(3);
  });

  it("the reading-order counter fires on a same-line pair that runs right to left", () => {
    expect(countReadingOrderInversions([{ x: 300, y: 500 }, { x: 40, y: 499 }])).toBe(1);
  });

  it("the content-stream parser refuses an operator it does not understand", () => {
    const stream = ["q", "BT", "/F1 9 Tf", "1 0 0 1 10 10 Tm", "<0041> Tj", "9 Tz", "ET", "Q"].join(
      "\n",
    );
    expect(() => parseContentStream(stream)).toThrow(ContentStreamRefusal);
  });

  it("the content-stream parser refuses a text block that never closes", () => {
    expect(() => parseContentStream(["q", "BT", "/F1 9 Tf"].join("\n"))).toThrow(
      ContentStreamRefusal,
    );
  });

  it("the merge predicate refuses to weld two words that share a baseline", () => {
    // Two single-glyph blocks 40pt apart at 9pt type: 4.4x the size, far past
    // the 1.25x step ceiling. Welding these would produce one structure element
    // spanning two unrelated words.
    const twoWords = [
      "q",
      "BT",
      "/F1 9 Tf",
      "24 TL",
      "1 0 0 1 10 500 Tm",
      "<0041> Tj",
      "T*",
      "ET",
      "Q",
      "q",
      "BT",
      "/F1 9 Tf",
      "24 TL",
      "1 0 0 1 50 500 Tm",
      "<0042> Tj",
      "T*",
      "ET",
      "Q",
    ].join("\n");
    expect(groupGlyphRuns(parseContentStream(twoWords)).map((g) => g.length)).toEqual([1, 1]);

    // The same two blocks 5pt apart ARE one letter-spaced run.
    const oneRun = twoWords.replace("1 0 0 1 50 500 Tm", "1 0 0 1 15 500 Tm");
    expect(groupGlyphRuns(parseContentStream(oneRun)).map((g) => g.length)).toEqual([2]);
  });

  it("the structural checks report false on an untagged document", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const facts = await catalogFacts(await doc.save({ useObjectStreams: false }));
    expect(facts.hasStructTreeRoot).toBe(false);
    expect(facts.marked).toBe(false);
    expect(facts.title).toBe("");
  });

  it("tagPdfBytes refuses an empty title or language rather than defaulting one", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(tagPdfBytes(bytes, { title: "  ", language: "en-US" })).rejects.toThrow(/title/);
    await expect(tagPdfBytes(bytes, { title: "Fixture", language: "" })).rejects.toThrow(/language/);
  });
});
