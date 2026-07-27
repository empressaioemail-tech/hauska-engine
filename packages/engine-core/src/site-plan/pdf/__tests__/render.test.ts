import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { emitPdfSitePlan } from "../render.js";
import { SITE_PLAN_HONESTY_LINE } from "../provenance.js";

/**
 * pdf-lib Flate-compresses page content streams by default with no public
 * toggle to disable it. To assert drawn TEXT (not just raw bytes) actually
 * reads back from the artifact, inflate every `stream…endstream` block and
 * concatenate the decoded PostScript operators — the drawn strings (Tj
 * operands) are literal ASCII/WinAnsi bytes for the plain text this emitter
 * draws, so a substring search against the decoded text is a real
 * "is this citation/line actually in the rendered PDF" check.
 */
function decodeAllContentStreams(pdfBytes: Uint8Array): string {
  const raw = Buffer.from(pdfBytes);
  const text = raw.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  const decoded: string[] = [];
  while ((match = streamRe.exec(text))) {
    const startIndex = match.index + match[0].indexOf(match[1]!);
    const endIndex = startIndex + match[1]!.length;
    const streamBytes = raw.subarray(startIndex, endIndex);
    try {
      decoded.push(inflateSync(streamBytes).toString("latin1"));
    } catch {
      decoded.push(streamBytes.toString("latin1"));
    }
  }
  const joined = decoded.join("\n");
  // pdf-lib's Helvetica/WinAnsi text runs emit hex string operands
  // (`<...> Tj`) rather than literal `(...)` strings; hex-decode those back
  // to the original ASCII text so the substring assertions below actually
  // check the drawn text, not its wire encoding.
  return joined.replace(/<([0-9A-Fa-f]+)>/g, (_all, hex: string) => Buffer.from(hex, "hex").toString("latin1"));
}

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2,
    199.8, 200.2, 200.7, 201.0,
    199.5, 200.0, 200.4, 200.8,
    199.2, 199.7, 200.1, 200.5,
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
  sourceCodeAtomRef: { atomDid: "san_antonio_tx/udc/35-310.01/35-310.01", role: "rule", entityType: "code-section" },
};

function buildModel() {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
  });
}

describe("emitPdfSitePlan", () => {
  it("emits a well-formed 2-page PDF from the shared site model", async () => {
    const model = buildModel();
    const result = await emitPdfSitePlan(model);

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    const header = new TextDecoder().decode(result.bytes.slice(0, 8));
    expect(header).toContain("%PDF-");
    expect(result.pageCount).toBe(2);
  });

  it("embeds the exact honesty line and the setback code citation as readable text in the PDF content streams", async () => {
    const model = buildModel();
    const { bytes } = await emitPdfSitePlan(model);
    // The dispatch's "assert drawing coords / citations match model" bar,
    // applied to the actual rendered artifact rather than just the pure
    // layout: decode the (Flate-compressed) page content streams and
    // confirm the honesty line and setback citation are literally drawn.
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain(SITE_PLAN_HONESTY_LINE);
    expect(decoded).toContain("san_antonio_tx/udc/35-310.01");
    expect(decoded).toContain("48029:105129");
  });

  it("draws GIS-approximate property-line tags (bearing+distance) with honesty, never survey-grade", async () => {
    const model = buildModel();
    const { bytes } = await emitPdfSitePlan(model);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("GIS-approximate");
    expect(decoded).toContain("not a boundary survey");
    expect(decoded.toLowerCase()).toContain("not survey-grade");
    // At least one quadrant bearing tag from the ring.
    expect(decoded).toMatch(/[NS] \d+°\d{2}' [EW]/);
  });

  it("renders honest zoning-absence and flood-unavailable text when those inputs are omitted", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
    });
    const { bytes } = await emitPdfSitePlan(model);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("unavailable");
  });

  // Planner HOLD-1 (2026-07-25): buildModel() above uses the default 4-edge
  // ring with no frontEdgeIndex hint, so its own basis is already the
  // geometric heuristic — the PDF summary must print the provisional
  // honesty note ALONGSIDE the numeric buildable area, not only when the
  // area itself is unavailable.
  it("prints the provisional honesty note on the summary page even though a numeric buildable area is also drawn", async () => {
    const model = buildModel();
    expect(model.setback.basis).toBe("geometric-heuristic:shortest-edge-pair-south-most");
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    const { bytes } = await emitPdfSitePlan(model);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("PROVISIONAL");
    expect(decoded).toContain("sq ft");
  });
});
