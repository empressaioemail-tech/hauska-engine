import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { chromeMonoFonts, drawMasthead, drawRunningHeader, type ChromeFonts } from "../report-chrome.js";
import { loadFont } from "../render.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

/**
 * P-239 falsifier 3. Generate a REAL PDF and decode it, to prove the masthead
 * wordmark actually reaches the page as extractable text.
 *
 * This repo's documented hazard: pdf-lib `StandardFonts` carry no ToUnicode
 * CMap, so text drawn in them is invisible to the decoder and every assertion
 * about it silently passes on nothing. The chrome deliberately uses the
 * fontkit-embedded Barlow faces for exactly this reason (see the ChromeFonts
 * note in report-chrome.ts), so the wordmark SHOULD decode. This test is what
 * makes that a measured fact rather than an assumption.
 *
 * Set P239_PDF_OUT to also write the bytes somewhere for eyeballing.
 */
describe("P-239: the masthead wordmark reaches a real PDF as decodable text", () => {
  it("decodes 'SMART SITE' out of a generated document", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const body = await doc.embedFont(loadFont("Barlow-Regular.ttf"), { subset: false });
    const bodyMedium = await doc.embedFont(loadFont("Barlow-Medium.ttf"), { subset: false });
    const F: ChromeFonts = {
      body,
      bodyMedium,
      display: await doc.embedFont(loadFont("BarlowCondensed-SemiBold.ttf"), { subset: false }),
      displayMedium: await doc.embedFont(loadFont("BarlowCondensed-Medium.ttf"), { subset: false }),
      ...chromeMonoFonts(body, bodyMedium),
    };

    // The operator's own reported document: 908 PINE / 48021:34137.
    const page = doc.addPage([612, 792]);
    drawMasthead(
      page,
      {
        reportType: "Feasibility Study",
        address: "908 PINE ST",
        subjectMeta: "BASTROP, TX 78602 · 48021:34137 · Bastrop County (48021)",
        docIdValue: "FS-48021-34137-001",
      },
      F,
    );

    const page2 = doc.addPage([612, 792]);
    drawRunningHeader(page2, { reportType: "Feasibility Study", rightMeta: "908 PINE ST · 48021:34137" }, F);

    const bytes = await doc.save();
    if (process.env.P239_PDF_OUT) writeFileSync(process.env.P239_PDF_OUT, bytes);

    const decoded = decodeAllContentStreams(bytes);

    // The wordmark is drawn glyph-by-glyph (tracked), so assert the run, not a
    // single Tj operand.
    expect(decoded).toContain("SMART");
    expect(decoded).toContain("SITE");

    // NOT VACUOUS: prove the decoder is actually reading this document's text
    // and would notice an absence. A decoder returning "" contains neither.
    expect(decoded).not.toContain("SMURF");
    expect(decoded.length).toBeGreaterThan(200);
  });
});
