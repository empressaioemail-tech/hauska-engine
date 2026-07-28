import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { AERIAL_UNAVAILABLE_NOTE } from "../aerial.js";
import { emitPdfSitePlan, type EmitPdfSitePlanOptions } from "../render.js";
import { SITE_PLAN_HONESTY_LINE } from "../provenance.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

// 1x1 red PNG — a real, decodable PNG so the success path exercises the
// actual embedPng pipeline without any network.
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** Hermetic default for every test: the aerial fetch NEVER hits the network. */
const aerialStubOk: EmitPdfSitePlanOptions = {
  aerial: { fetchImage: async () => TINY_PNG },
};
const aerialStubDown: EmitPdfSitePlanOptions = {
  aerial: {
    fetchImage: async () => {
      throw new Error("test stub: aerial endpoint unreachable");
    },
  },
};

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
  it("emits a well-formed 3-page PDF (drawing, summary, aerial context) from the shared site model", async () => {
    const model = buildModel();
    const result = await emitPdfSitePlan(model, aerialStubDown);

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    const header = new TextDecoder().decode(result.bytes.slice(0, 8));
    expect(header).toContain("%PDF-");
    expect(result.pageCount).toBe(3);
  });

  it("embeds the exact honesty line and the setback code citation as readable text in the PDF content streams", async () => {
    const model = buildModel();
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
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
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
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
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("unavailable");
  });

  // Template-match chrome (rebuilt 2026-07-27 to the Industry gold reference).
  // The header eyebrow, right-aligned stat cluster, legend with an honest
  // empty street layer, scale bar with a feet unit, and a scale-ratio /
  // sheet-id / generated stamp line all read back from the sheet.
  it("draws template sheet chrome: address, sub-line, legend w/ honest empty street, scale-ratio + sheet-id + stamp", async () => {
    const model = buildModel();
    const { bytes, fontNote } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    // Header: the address is the largest string on the sheet (uppercased).
    expect(decoded).toContain("1127 N PINE ST");
    // Sub-line carries city + parcel.
    expect(decoded).toContain("Parcel 48029:105129");
    // Legend rows (contiguous, non-tracked) incl. the honest empty street layer.
    expect(decoded).toContain("Property line");
    expect(decoded).toContain("Setback / buildable envelope");
    expect(decoded).toContain("no road node attaches");
    // Scale bar carries a feet unit; scale-ratio + sheet-id + stamp line present.
    expect(decoded).toContain(" ft");
    expect(decoded).toContain('1" = ');
    expect(decoded).toContain("SP-48029-105129");
    expect(decoded).toContain("generated ");
    // The embedded font is surfaced honestly to callers.
    expect(fontNote).toContain("Inter");
  });

  it("centers a BUILDABLE ENVELOPE callout with the buildable sq ft + percent-of-lot qualifier", async () => {
    const model = buildModel();
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("BUILDABLE ENVELOPE");
    // "{sqft} sq ft · {pct}% of lot" qualifier.
    expect(decoded).toMatch(/% of lot/);
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
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("PROVISIONAL");
    expect(decoded).toContain("sq ft");
  });

  // ── AERIAL CONTEXT (sheet 3) ─────────────────────────────────────────────
  describe("aerial context page", () => {
    it("embeds the imagery, draws the sheet chrome + attribution + not-a-survey honesty, and reports the outcome", async () => {
      const model = buildModel();
      const result = await emitPdfSitePlan(model, aerialStubOk);

      expect(result.pageCount).toBe(3);
      expect(result.aerial.imageryEmbedded).toBe(true);
      expect(result.aerial.sourceUrl).toContain("World_Imagery/MapServer/export");
      expect(result.aerial.sourceUrl).toContain("bboxSR=3857");
      expect(result.aerial.unavailableReason).toBeUndefined();

      // A PNG image XObject is actually inside the document.
      const latin1 = Buffer.from(result.bytes).toString("latin1");
      expect(latin1).toContain("/Subtype /Image");

      const decoded = decodeAllContentStreams(result.bytes);
      // Tracked eyebrow reconstructs contiguously in the tight join.
      expect(decoded).toContain("AERIAL CONTEXT");
      expect(decoded).toContain("SHEET 3 OF 3");
      // Required provider attribution + not-a-survey honesty (single tokens —
      // wrapped fine print may break phrases at spaces).
      expect(decoded).toContain("Maxar");
      expect(decoded).toContain("Earthstar");
      expect(decoded).toContain("not a survey");
      expect(decoded).toContain("capture date is not verified");
    });

    it("still emits the page with the honest unavailable note when the fetch fails, without failing the export", async () => {
      const model = buildModel();
      const result = await emitPdfSitePlan(model, aerialStubDown);

      expect(result.pageCount).toBe(3);
      expect(result.aerial.imageryEmbedded).toBe(false);
      expect(result.aerial.unavailableReason).toContain("aerial endpoint unreachable");

      const latin1 = Buffer.from(result.bytes).toString("latin1");
      expect(latin1).not.toContain("/Subtype /Image");

      const decoded = decodeAllContentStreams(result.bytes);
      expect(decoded).toContain("AERIAL IMAGERY UNAVAILABLE");
      expect(decoded).toContain(AERIAL_UNAVAILABLE_NOTE);
      // Attribution + honesty fine print still present on the honest page.
      expect(decoded).toContain("Earthstar");
    });

    it("degrades to the honest path when the endpoint returns a non-PNG body (Esri JSON error with HTTP 200)", async () => {
      const model = buildModel();
      const result = await emitPdfSitePlan(model, {
        aerial: {
          fetchImage: async () => new TextEncoder().encode('{"error":{"code":500}}'),
        },
      });

      expect(result.pageCount).toBe(3);
      expect(result.aerial.imageryEmbedded).toBe(false);
      expect(result.aerial.unavailableReason).toContain("non-PNG body");
      const decoded = decodeAllContentStreams(result.bytes);
      expect(decoded).toContain("AERIAL IMAGERY UNAVAILABLE");
    });
  });
});
