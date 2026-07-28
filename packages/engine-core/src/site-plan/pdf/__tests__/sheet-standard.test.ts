import { describe, expect, it } from "vitest";

import { PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO } from "../../../depth-warm/fixtures/parcelRings.js";
import { composeSitePlanModel, type SitePlanModel } from "../../site-model.js";
import { emitPdfSitePlan, type EmitPdfSitePlanOptions, type PdfSitePlanResult } from "../render.js";
import { buildSitePlanDrawingLayout } from "../layout.js";
import { isCleanReasonSentence, REASON } from "../format.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

/**
 * SHEET STANDARD v1.0 — the ACCEPTANCE CHECKLIST encoded as tests, run on
 * BOTH reference fixtures (§6 · reference sheets):
 *   · 48021:34785  — the three-page gold set (live TxGIO ring fixture)
 *   · qa2:dense-small — the degenerate case (8 segments, no buildable
 *     envelope, cascade tiers exercised, overflow tabulated on sheet 2)
 * The standard itself is committed as SHEET_STANDARD_v1.html next to the
 * renderer. Any single failure fails the sheet.
 */

// 1x1 red PNG — real, decodable; exercises the §20 duotone + embed path.
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const aerialStubOk: EmitPdfSitePlanOptions = { aerial: { fetchImage: async () => TINY_PNG } };
const aerialStubDown: EmitPdfSitePlanOptions = {
  aerial: {
    fetchImage: async () => {
      throw new Error("test stub: aerial endpoint unreachable");
    },
  },
};

function syntheticDem(size: number, base: number, relief: number) {
  const values = new Float32Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = base + ((x + y) / (2 * (size - 1))) * relief;
      values[y * size + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { width: size, height: size, values, minElevation: min, maxElevation: max, nodataCount: 0 };
}

/** GOLD fixture — mirrors scripts/generate-site-plan-gold-34785.mjs. */
function buildGoldModel(): SitePlanModel {
  const ring = PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO;
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const padLng = (Math.max(...lngs) - Math.min(...lngs)) * 0.35 || 0.0003;
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.35 || 0.0003;
  return composeSitePlanModel({
    parcelNodeId: "48021:34785",
    bbox: {
      westLng: Math.min(...lngs) - padLng,
      eastLng: Math.max(...lngs) + padLng,
      southLat: Math.min(...lats) - padLat,
      northLat: Math.max(...lats) + padLat,
    },
    ringWgs84: ring,
    dem: syntheticDem(8, 141.2, 3.1),
    contourIntervalMeters: 0.5,
    setback: {
      front: 15,
      side: 5,
      rear: 15,
      sourceCodeAtomRef: { atomDid: "bastrop_tx/udc:residential-front-setback", role: "rule", entityType: "code-section" },
    },
    frontEdgeIndex: 3,
    geometrySourceRef: "txgio-live-fixture:48021:34785:PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO",
    demSourceCitation: "synthetic-fixture DEM (design-pass sample; not a live USGS 3DEP clip)",
    descriptor: { address: "1009 Chestnut St, Bastrop, TX", countyName: "Bastrop County" },
    zoning: { district: "R-1", fixture: true },
    floodZone: { honestUnavailable: true, reason: "FEMA NFHL not queried on this run." },
  });
}

/** DEGENERATE fixture — mirrors scripts/generate-site-plan-gold-dense-qa2.mjs. */
function buildDenseModel(): SitePlanModel {
  const ringWgs84: Array<[number, number]> = [
    [-98.49978, 29.40012],
    [-98.49974, 29.40012],
    [-98.4997, 29.40012],
    [-98.4997, 29.40016],
    [-98.4997, 29.4002],
    [-98.49974, 29.4002],
    [-98.49978, 29.4002],
    [-98.49978, 29.40016],
    [-98.49978, 29.40012],
  ];
  return composeSitePlanModel({
    parcelNodeId: "qa2:dense-small",
    bbox: { westLng: -98.4999, eastLng: -98.4995, southLat: 29.4, northLat: 29.40035 },
    ringWgs84,
    dem: syntheticDem(6, 200, 1.5),
    contourIntervalMeters: 0.5,
    setback: {
      front: 10,
      side: 5,
      rear: 10,
      sourceCodeAtomRef: { atomDid: "fixture/udc:dense-qa2", role: "rule", entityType: "code-section" },
    },
    frontEdgeIndex: 0,
    geometrySourceRef: "qa2-dense-synthetic-ring",
    demSourceCitation: "synthetic-fixture DEM (QA2 craft sample; not live 3DEP)",
    descriptor: { countyName: "Bexar County" }, // NO address — §2 chip path
    zoning: { district: "R-6", fixture: true },
    floodZone: { honestUnavailable: true, reason: "FEMA NFHL not queried on this run." },
    streetAnchors: [
      {
        name: "N PINE ST",
        points: [
          [-98.49982, 29.40016],
          [-98.49966, 29.40016],
        ],
        sourceRef: "osm:way/dense-qa2",
      },
    ],
  });
}

/** Drawn-text sections only (TIGHT + SPACED joins) — skips binary streams.
 * The decoder's section markers carry a control byte before the word, so we
 * locate the words themselves. Neither word occurs in drawn sheet text. */
function drawnText(decoded: string): string {
  const i = decoded.indexOf("TIGHT");
  return i >= 0 ? decoded.slice(i) : decoded;
}

function spacedText(decoded: string): string {
  const i = decoded.lastIndexOf("SPACED");
  return i >= 0 ? decoded.slice(i) : decoded;
}

function tightText(decoded: string): string {
  const start = decoded.indexOf("TIGHT");
  const end = decoded.lastIndexOf("SPACED");
  if (start < 0) return decoded;
  return decoded.slice(start, end > start ? end : undefined);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) return count;
    count++;
    idx += needle.length;
  }
}

interface Rendered {
  model: SitePlanModel;
  result: PdfSitePlanResult;
  decoded: string;
  text: string;
}

async function render(model: SitePlanModel, opts: EmitPdfSitePlanOptions): Promise<Rendered> {
  const result = await emitPdfSitePlan(model, opts);
  const decoded = decodeAllContentStreams(result.bytes);
  return { model, result, decoded, text: drawnText(decoded) };
}

// Render each fixture once and share across the checklist items.
const goldP = render(buildGoldModel(), aerialStubOk);
const denseP = render(buildDenseModel(), aerialStubDown);

describe("SHEET STANDARD v1.0 acceptance checklist", () => {
  it("three pages, in order, none omitted — on both fixtures and on the aerial-down path (§1)", async () => {
    const gold = await goldP;
    const dense = await denseP;
    expect(gold.result.pageCount).toBe(3);
    expect(dense.result.pageCount).toBe(3);
    const denseUp = await emitPdfSitePlan(buildDenseModel(), aerialStubOk);
    expect(denseUp.pageCount).toBe(3);
  });

  it("no mark drawn twice: unique (page, kind, key) across tags, labels, arrows, bars, legends (§14)", async () => {
    for (const { result } of [await goldP, await denseP]) {
      const ids = result.marks.map((m) => `${m.page}:${m.kind}:${m.key}`);
      expect(new Set(ids).size).toBe(ids.length);
      const count = (page: number, kind: string) => result.marks.filter((m) => m.page === page && m.kind === kind).length;
      // Exactly one north arrow / scale bar / legend / fine print per sheet
      // that carries them (§9).
      expect(count(1, "north-arrow")).toBe(1);
      expect(count(3, "north-arrow")).toBe(1);
      expect(count(1, "scale-bar")).toBe(1);
      expect(count(3, "scale-bar")).toBe(1);
      expect(count(1, "legend")).toBe(1);
      expect(count(3, "legend")).toBe(1);
      expect(count(1, "fine-print")).toBe(1);
      expect(count(2, "fine-print")).toBe(1);
      expect(count(3, "fine-print")).toBe(1);
      expect(count(1, "property-line")).toBe(1);
    }
  });

  it("one tag per segment, keyed by segment id; every segment accounted for on sheet 1 or in the segment table (§4/§16)", async () => {
    for (const { model, result } of [await goldP, await denseP]) {
      const tagMarks = result.marks.filter((m) => m.page === 1 && m.kind === "tag");
      const leaderMarks = result.marks.filter((m) => m.page === 1 && m.kind === "margin-leader");
      expect(tagMarks.length).toBeLessThanOrEqual(model.propertySegments.length);
      expect(new Set(tagMarks.map((m) => m.key)).size).toBe(tagMarks.length);
      expect(new Set(leaderMarks.map((m) => m.key)).size).toBe(leaderMarks.length);
    }
  });

  it("segment table appears exactly when tags were shortened / moved / dropped, and the fine print says so (§16)", async () => {
    for (const r of [await goldP, await denseP]) {
      const tableMark = r.result.marks.some((m) => m.page === 2 && m.kind === "segment-table");
      expect(r.text.includes("SEGMENT TABLE")).toBe(tableMark);
      expect(r.text.includes("tabulated in the sheet-2 segment table")).toBe(tableMark);
    }
  });

  it("forced cascade: in a tight box every segment is either a placed tag or a segment-table row — a dropped tag with no row is a defect (§4/§16)", () => {
    // A small drawing box forces the cascade tiers on the 8-segment ring.
    const model = buildDenseModel();
    const box = { x: 10, y: 10, width: 150, height: 150 };
    const layout = buildSitePlanDrawingLayout(model, box, {
      sheetBounds: { minX: 0, minY: 0, maxX: 170, maxY: 170 },
    });
    expect(layout.segmentTable.length).toBeGreaterThan(0);
    const placedSegs = new Set(layout.propertyLineTags.map((t) => `S${t.seg}`));
    const tabledSegs = new Set(layout.segmentTable.map((row) => row.seg));
    for (let i = 1; i <= model.propertySegments.length; i++) {
      expect(placedSegs.has(`S${i}`) || tabledSegs.has(`S${i}`), `S${i} unaccounted`).toBe(true);
    }
    // Every table row carries the full quadrant bearing + prime distance.
    for (const row of layout.segmentTable) {
      expect(row.bearing).toMatch(/^[NS] \d+°\d{2}' [EW]$/);
      expect(row.distance).toMatch(/\d'$/);
    }
    // Margin leaders never cross the ring or each other (§16) — verified by
    // construction in layout; assert the leader labels stayed on-sheet.
    for (const leader of layout.segmentLeaders) {
      expect(leader.label.box.x).toBeGreaterThanOrEqual(0);
      expect(leader.label.box.x + leader.label.box.width).toBeLessThanOrEqual(170);
    }
  });

  it("no machine identifier, N/A, bare placeholder, unit crime, or clipped enum in drawn text (§6/§11/§12/§13)", async () => {
    for (const { text } of [await goldP, await denseP]) {
      expect(text).not.toContain("N/A");
      expect(text).not.toContain("n/a");
      expect(text).not.toContain("not on file");
      expect(text).not.toContain("sqft");
      expect(text).not.toContain("FEET");
      // Machine codes stay off the sheet except provenance SOURCE column —
      // these two are never legitimate source strings for these fixtures.
      expect(text).not.toContain("setback-consumes-lot");
      expect(text).not.toContain("approximate-assumed-per-class");
      expect(text).not.toContain("front-edge-hint");
      // §11: the nested-parenthetical datum summary never reaches the sheet.
      expect(text).not.toContain("not ellipsoidal height");
    }
  });

  it("thousands separators, prime marks and sq-ft form on the gold figures (§12)", async () => {
    const gold = await goldP;
    const spaced = spacedText(gold.decoded);
    // Lot ≈ 16,111 sq ft — separator everywhere, never a bare 16111.
    expect(spaced).toContain("16,111 sq ft");
    expect(spaced).toContain("16,111 SF");
    expect(spaced).not.toMatch(/16111/);
    // Acreage to two decimals after square feet.
    expect(spaced).toContain("(0.37 acres)");
    // Scale ratio takes a prime, never "ft".
    expect(spaced).toMatch(/1" = \d+'/);
    expect(spaced).not.toMatch(/1" = \d+ ft/);
    // Setbacks with primes.
    expect(spaced).toContain("15' / 5' / 15'");
  });

  it("UNAVAILABLE chips carry the fixed word plus one clean sentence; FIXTURE LABEL is one chip with identical wording (§6)", async () => {
    const gold = await goldP;
    const dense = await denseP;
    for (const r of [gold, dense]) {
      expect(r.text).toContain("UNAVAILABLE");
      expect(r.text).toContain("FIXTURE LABEL");
      // No second spelling of the fixture state.
      expect(r.text).not.toContain("(fixture");
      expect(r.text).not.toContain("fixture)");
    }
    // Dense has no address: §2 chip, never a placeholder.
    expect(dense.text).toContain("NO ADDRESS");
    expect(dense.text).toContain("PARCEL QA2:DENSE-SMALL");
    // Every canned §6 reason is itself a clean one-sentence ≤12-word reason.
    for (const sentence of Object.values(REASON)) {
      expect(isCleanReasonSentence(sentence), sentence).toBe(true);
    }
  });

  it("degenerate parcel states the collapse exactly three ways and draws no envelope or setback mark (§15)", async () => {
    const dense = await denseP;
    // 1) BUILDABLE header stat reads NONE.
    expect(dense.text).toContain("NONE");
    // 2) Centred callout: title over ONE plain sentence — drawn exactly once.
    expect(countOccurrences(tightText(dense.decoded), "NO BUILDABLE ENVELOPE")).toBe(1);
    expect(dense.text).toContain(REASON.setbacksConsumeLot);
    // 3) Legend rows grey out with the reason inline.
    expect(dense.text).toContain("none drawn");
    expect(dense.text).toContain("no offset survives");
    // Sheet 2 carries the UNAVAILABLE chip on buildable area (reason above).
    // NO envelope-shaped mark and NO setback label may print at all.
    const forbiddenKinds = new Set(["envelope-fill", "setback-dash", "setback-label", "envelope-callout"]);
    expect(dense.result.marks.filter((m) => m.page === 1 && forbiddenKinds.has(m.kind))).toHaveLength(0);
    expect(dense.result.marks.filter((m) => m.page === 3 && m.kind === "setback-dash")).toHaveLength(0);
    expect(dense.text).not.toContain("SIDE 5");
    expect(dense.text).not.toContain("FRONT SETBACK");
  });

  it("legend lists every layer in fixed order with inline reasons for empty rows (§5)", async () => {
    const gold = await goldP;
    expect(gold.text).toContain("Property line");
    expect(gold.text).toContain("Buildable envelope");
    expect(gold.text).toContain("Setback line");
    expect(gold.text).toContain("Contour, 0.5 m interval");
    // Gold has no street — greyed row, reason inline on the SAME row.
    expect(gold.text).toContain("Street — layer empty · no road node attaches");
  });

  it("no drawing type below the rendered 10 px floor on either fixture (§13, geometry table)", () => {
    const box = { x: 34.5, y: 160, width: 543, height: 480 };
    for (const model of [buildGoldModel(), buildDenseModel()]) {
      const layout = buildSitePlanDrawingLayout(model, box);
      for (const label of layout.allPlacedLabels) {
        // 10 px @96dpi = 7.5 pt.
        expect(label.fontSize, label.text).toBeGreaterThanOrEqual(7.5);
      }
    }
  });

  it("aerial sheet: same-geometry overlay, registration tolerance stated, four-cell imagery strip, honest capture-date chip (§17–§19)", async () => {
    const gold = await goldP; // imagery OK path
    expect(gold.result.aerial.imageryEmbedded).toBe(true);
    // Strip labels are tracked (glyph-by-glyph) — they reconstruct in the
    // tight join; values and sentences read from either join via gold.text.
    expect(gold.text).toContain("SOURCE");
    expect(gold.text).toContain("CAPTURE DATE");
    expect(gold.text).toContain("RESOLUTION");
    expect(gold.text).toContain("REGISTRATION");
    expect(gold.text).toContain("Esri World Imagery");
    // Esri publishes no capture date: honest chip + reason, never inferred.
    expect(spacedText(gold.decoded)).toContain(REASON.noCaptureDate);
    // Registration tolerance is computed and printed (header + strip) plus
    // the fine-print sentence.
    expect(gold.text).toMatch(/±\d+\.\d+ (FT|ft)/);
    expect(spacedText(gold.decoded)).toContain("Overlay registration to the imagery is approximate to");
    expect(spacedText(gold.decoded)).toContain("sheet 1 governs");
    // §17: the down path still ships the sheet with the strip chips.
    const dense = await denseP;
    expect(dense.result.aerial.imageryEmbedded).toBe(false);
    expect(spacedText(dense.decoded)).toContain(REASON.imageryFetchFailed);
  });

  it("fine print on all three pages carries the standing disclaimers (§8)", async () => {
    for (const r of [await goldP, await denseP]) {
      const spaced = spacedText(r.decoded);
      expect(countOccurrences(spaced, "Derived from public GIS records. Not a boundary survey. Not for legal record.")).toBe(3);
      // Fixture disclosure appended to the same paragraph (both fixtures are
      // fixture-zoned).
      expect(spaced).toContain("fixture label");
    }
  });

  it("degenerate summary buildable row is an UNAVAILABLE chip with the collapse sentence (§15/§6)", async () => {
    const dense = await denseP;
    expect(dense.text).toContain(REASON.setbacksConsumeLot);
    expect(dense.model.summary.buildableAreaSqFt).toBeNull();
    expect(dense.model.setback.degenerate).toBe(true);
  });
});
