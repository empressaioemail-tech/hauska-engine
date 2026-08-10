import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { composeSitePlanModel } from "../../site-model.js";
import { boundaryEdgesForRing } from "../../__tests__/boundary-edge-fixture.js";
import { AERIAL_UNAVAILABLE_NOTE } from "../aerial.js";
import { REASON } from "../format.js";
import { emitPdfSitePlan, SITE_PLAN_BRAND_KICKER, type EmitPdfSitePlanOptions } from "../render.js";
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

// The export CONSUMES the boundary primitive (2026-07-28 directive) — the
// default render fixture exercises the primitive-consuming path.
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

// 60s ceiling matches the sibling PDF suites (dossier, flood-drainage):
// four embedded fonts per emit run well past vitest's 5s default under
// full-suite parallel load.
describe("emitPdfSitePlan", { timeout: 60_000 }, () => {
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
    // At least one quadrant bearing tag from the ring (distance-first, §4).
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
    // Smart Site brand kicker on the sheet eyebrow (REBRAND_UI brand skin).
    expect(decoded).toContain(SITE_PLAN_BRAND_KICKER);
    expect(decoded).toContain(`${SITE_PLAN_BRAND_KICKER} · SITE PLAN · SHEET 1 OF 3`);
    // Header: the address is the largest string on the sheet (uppercased).
    expect(decoded).toContain("1127 N PINE ST");
    // Sub-line carries city + parcel.
    expect(decoded).toContain("Parcel 48029:105129");
    // Legend rows (§5: every layer, fixed order) incl. the honest empty street.
    expect(decoded).toContain("Property line");
    expect(decoded).toContain("Buildable envelope");
    expect(decoded).toContain("Setback line");
    expect(decoded).toContain("no road node attaches");
    // Scale bar carries a feet unit; scale-ratio + sheet-id + stamp line present.
    expect(decoded).toContain(" ft");
    expect(decoded).toContain('1" = ');
    expect(decoded).toContain("SP-48029-105129");
    expect(decoded).toContain("generated ");
    // The embedded font is surfaced honestly to callers (Sheet Standard token map).
    expect(fontNote).toContain("Barlow");
  });

  it("labels a named attaching street on the drawing (paper-haloed name, never silently dropped)", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
      streetAnchors: [
        { name: "N PINE ST", points: [[-98.4999, 29.4002], [-98.4995, 29.4002]], sourceRef: "osm:way/123" },
      ],
      geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    });
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("N PINE ST");
  });

  it("centers a BUILDABLE ENVELOPE callout with the buildable sq ft + percent-of-lot qualifier", async () => {
    const model = buildModel();
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("BUILDABLE ENVELOPE");
    // "{sqft} sq ft · {pct}% of lot" qualifier.
    expect(decoded).toMatch(/% of lot/);
  });

  // Planner HOLD-1 (2026-07-25) + 2026-07-28 build-to-line ruling: a
  // primitive-consuming envelope whose edges include a stored setback
  // ABSENCE draws a numeric buildable area AND prints the provisional
  // honesty note — zero inset on the silent edges, nothing fabricated.
  it("prints the provisional honesty note on the summary page even though a numeric buildable area is also drawn", async () => {
    const provisionalEdges = boundaryEdgesForRing(ringWgs84, [
      { role: "front", feet: 15 },
      { role: "side", absent: true },
      { role: "rear", absent: true },
      { role: "side", feet: 5 },
    ]);
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: { ...setback, front: 15, side: 0, rear: 0, notSpecified: { side: true, rear: true } },
      boundaryEdges: provisionalEdges,
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
      zoning: { district: "R-6" },
      floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
      geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    });
    expect(model.setback.basis).toBe("boundary-primitive");
    expect(model.summary.buildableAreaSqFt).not.toBeNull();
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    // §7/§11: the provisional state is ONE grey qualifier on the value row,
    // with the long narrative folded into the sheet-2 fine print.
    expect(decoded).toContain("provisional planning estimate");
    expect(decoded).toContain("planning estimate, not a permit-ready boundary");
    expect(decoded).toContain("sq ft");
  });

  // HEADER = DRAWING (2026-07-28): the live defect printed a warm number in
  // the header while the drawing honestly drew nothing. The header now reads
  // the SAME model value as the drawing — degenerate local offset -> NONE,
  // even when a warm envelope number is on file; the warm figure moves to
  // sheet-2 wording only.
  it("header reads NONE when the local offset is degenerate, even with a warm envelope number on file", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: { ...setback, front: 100, side: 100, rear: 100 },
      frontEdgeIndex: 0,
      envelopeOutcome: { kind: "buildable", areaSqFt: 16_046 },
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
      zoning: { district: "R-6" },
      floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
      geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    });
    expect(model.setback.degenerate).toBe(true);
    expect(model.summary.buildableAreaSqFt).toBeNull();
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("NONE");
    // The warm figure never rides the header stat cluster.
    expect(decoded).not.toContain("16,046 SF");
  });

  // BAN legend/header contradiction: when the legend says the buildable
  // envelope is not drawn because no setback rule is on file, the sheet-1
  // header must not print a numeric BUILDABLE area (48113 live defect class).
  it("header reads NONE when the legend says buildable envelope not drawn for missing setback rule", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48113:007701000B0010000",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback: {
        front: 0,
        side: 0,
        rear: 0,
        sourceCodeAtomRef: {
          atomDid: "no-setback-rule-atom",
          role: "honest-absence",
          entityType: "setback-rule",
        },
        honestAbsence: true,
      },
      descriptor: { address: "DALLAS TX FIXTURE", countyName: "Dallas County" },
      floodZone: { honestUnavailable: true, reason: "test stub" },
      geometrySourceRef: "txgio-parcel:48113:007701000B0010000",
    });
    expect(model.summary.buildableAreaSqFt).toBeNull();
    expect(model.summary.lotAreaSqFt).toBeGreaterThan(0);
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("Buildable envelope — not drawn · no setback rule on file");
    expect(decoded).toContain("NONE");
    const lotSf = Math.round(model.summary.lotAreaSqFt).toLocaleString("en-US");
    // Header must not duplicate lot area under BUILDABLE.
    expect(decoded).not.toMatch(new RegExp(`BUILDABLE\\s+${lotSf.replace(/,/g, "[, ]?")}\\s*SF`, "i"));
  });

  // §11 (v1.2): the county reads by NAME only. A FIPS-shaped countyName (the
  // 2026-07-28 live defect: "Parcel 48021:47719 · 48021") is omitted from
  // the header meta line, and the County summary row takes the honest chip.
  it("omits a FIPS-shaped county from the header meta line and gives the County row the honest chip (§11 v1.2)", async () => {
    const model = composeSitePlanModel({
      parcelNodeId: "48021:47719",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      descriptor: { address: "806 Pine St, Bastrop, TX", countyName: "48021" },
      geometrySourceRef: "fips-meta-fixture",
    });
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("Parcel 48021:47719");
    // Never "Parcel 48021:47719 · 48021" — the raw code is omitted entirely.
    expect(decoded).not.toMatch(/47719\s*·\s*48021(?!:)/);
    expect(decoded).toContain(REASON.noCountyName);
  });

  it("prints the county NAME in the header meta line when one is on file", async () => {
    const model = buildModel(); // descriptor carries "Bexar County"
    const { bytes } = await emitPdfSitePlan(model, aerialStubDown);
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).toContain("Bexar County");
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
      // Tracked eyebrow reconstructs contiguously in the tight join (§2).
      expect(decoded).toContain("AERIAL");
      expect(decoded).toContain("SHEET 3 OF 3");
      // §19 imagery provenance strip — all four cells present.
      expect(decoded).toContain("SOURCE");
      expect(decoded).toContain("CAPTURE DATE");
      expect(decoded).toContain("RESOLUTION");
      expect(decoded).toContain("REGISTRATION");
      // Esri publishes no capture date — honest UNAVAILABLE, never inferred.
      expect(decoded).toContain("UNAVAILABLE");
      expect(decoded).toContain("does not publish a capture date");
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

      // §17: the page still ships with the overlay on the paper ground and an
      // UNAVAILABLE chip in the imagery strip; the fine print carries the
      // honest unavailable note. (The old full-page headline is retired.)
      const decoded = decodeAllContentStreams(result.bytes);
      expect(decoded).toContain("UNAVAILABLE");
      expect(decoded).toContain("Imagery fetch failed on this run.");
      expect(decoded).toContain(AERIAL_UNAVAILABLE_NOTE);
      // Attribution + honesty fine print still present on the honest page.
      expect(decoded).toContain("Earthstar");
    });

    // §20 (v1.2): the orthophoto embeds in NATURAL COLOR — the duotone tint
    // is retired. The stubbed 1x1 PNG is pure red; if any tint pass ran, the
    // embedded samples would be accent-hued, never (255, 0, 0).
    it("embeds the orthophoto in natural color — no duotone tint on the raster samples (§20 v1.2)", async () => {
      const model = buildModel();
      const result = await emitPdfSitePlan(model, aerialStubOk);
      expect(result.aerial.imageryEmbedded).toBe(true);

      const raw = Buffer.from(result.bytes);
      const text = raw.toString("latin1");
      const dictAt = text.indexOf("/Subtype /Image");
      expect(dictAt).toBeGreaterThan(-1);
      const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      streamRe.lastIndex = dictAt;
      const m = streamRe.exec(text);
      expect(m).not.toBeNull();
      const start = m!.index + m![0].indexOf(m![1]!);
      const pixels = inflateSync(raw.subarray(start, start + m![1]!.length));
      // 1x1 RGB sample (with or without a leading PNG filter byte): the last
      // three bytes are the pixel — still pure red, untinted.
      const px = pixels.subarray(pixels.length - 3);
      expect([px[0], px[1], px[2]]).toEqual([255, 0, 0]);
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
      expect(decoded).toContain("UNAVAILABLE");
      expect(decoded).toContain(AERIAL_UNAVAILABLE_NOTE);
    });
  });
});
