import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO } from "../../../depth-warm/fixtures/parcelRings.js";
import { composeSitePlanModel, type SitePlanModel } from "../../site-model.js";
import { emitPdfSitePlan, type EmitPdfSitePlanOptions, type PdfSitePlanResult } from "../render.js";
import { fontVerticalMetrics, lineBox, placeRowBelowRule, type RhythmRow } from "../line-box.js";
import { LINE_HEIGHT, SPACE, TYPE, pt } from "../template-tokens.js";

/**
 * §21 · VERTICAL RHYTHM GATE (Sheet Standard v1.1).
 *
 * This is the numeric rhythm gate: the renderer exports every rhythm-
 * governed text row on `result.rhythm` (rule y, line-box top, cap-top y,
 * baseline y, pads, half-leading), and this suite asserts the line-box
 * invariants against REAL font metrics read from the vendored Barlow TTFs —
 * the same bytes pdf-lib embeds. No rasterization involved; the assertions
 * hold to 1e-6 pt, which a pixel diff could never do.
 *
 * Invariants:
 *  1. rule → cap-top gap = padTop + halfLeading + (ascent − capHeight)·S/upm
 *     — text never crowds the rule above it (the 2026-07-28 live defect).
 *  2. The gap is UNIFORM across every row of a kind, on both fixtures.
 *  3. Baseline → next-rule gap = descent + halfLeading + padBottom > 0.
 *  4. A group heading sits ≥ space-6 below the previous block and exactly
 *     space-2 above its first rule (proximity: closer to its rows).
 *  5. Multi-line rows grow by whole line boxes (pitch = lineBoxHeight).
 */

const EPS = 1e-6;

// 1x1 red PNG — decodable; exercises the imagery-OK path.
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
    descriptor: { countyName: "Bexar County" },
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

// The SAME font bytes pdf-lib embeds — walk up from this test to assets/.
function loadBarlow(): Uint8Array {
  return new Uint8Array(
    readFileSync(join(__dirname, "..", "..", "..", "..", "assets", "fonts", "Barlow-Regular.ttf")),
  );
}

const goldP = emitPdfSitePlan(buildGoldModel(), aerialStubOk);
const denseP = emitPdfSitePlan(buildDenseModel(), aerialStubDown);

function rowsOf(result: PdfSitePlanResult, kind: string): RhythmRow[] {
  return result.rhythm.filter((r) => r.kind === kind);
}

function ruleToCapGap(row: RhythmRow): number {
  if (row.ruleY == null) throw new Error(`row kind=${row.kind} has no rule`);
  return row.ruleY - row.capTopY;
}

describe("§21 vertical rhythm gate (Sheet Standard v1.1)", () => {
  it("line-box math reproduces the documented 13px-body numbers from real Barlow metrics", () => {
    const metrics = fontVerticalMetrics(loadBarlow());
    // The §21 derivation constants (upm 1000 / ascent 1000 / descent −200 /
    // capHeight 700) are the REAL vendored-font values, not assumptions.
    expect(metrics.unitsPerEm).toBe(1000);
    expect(metrics.ascent).toBe(1000);
    expect(metrics.descent).toBe(-200);
    expect(metrics.capHeight).toBe(700);
    const lb = lineBox(metrics, 13, 1.6); // px in, px out
    expect(lb.lineBoxHeight).toBeCloseTo(20.8, 6);
    expect(lb.halfLeading).toBeCloseTo(2.6, 6);
    expect(lb.baselineFromBoxTop).toBeCloseTo(15.6, 6);
    expect(lb.capTopFromBoxTop).toBeCloseTo(6.5, 6);
    expect(lb.descentBelowBaseline).toBeCloseTo(2.6, 6);
    // Row model at space-2 pads: rule→cap 13.3px, baseline→next-rule 12px.
    const placed = placeRowBelowRule(100, lb, { padTop: 6.8, padBottom: 6.8 });
    expect(100 - placed.capTopY).toBeCloseTo(13.3, 6);
    expect(placed.baselines[0]! - placed.nextRuleY).toBeCloseTo(12, 6);
  });

  it("summary K/V rows: rule→cap gap is metrics-exact and uniform on both fixtures", async () => {
    const metrics = fontVerticalMetrics(loadBarlow());
    const lb = lineBox(metrics, TYPE.rowValue, LINE_HEIGHT.body); // pt
    const expected = pt(SPACE.s2) + lb.capTopFromBoxTop;
    for (const result of [await goldP, await denseP]) {
      const rows = rowsOf(result, "kv-row");
      expect(rows.length).toBeGreaterThanOrEqual(9);
      for (const row of rows) {
        // Invariant 1: the cap top clears the rule by padTop + halfLeading
        // + (ascent − capHeight) — never less.
        expect(ruleToCapGap(row)).toBeCloseTo(expected, 6);
        expect(ruleToCapGap(row)).toBeGreaterThanOrEqual(row.padTopPt + row.halfLeadingPt - EPS);
        // Invariant 3: baseline keeps descent + halfLeading + padBottom of
        // air before the next rule.
        expect(row.baselineY - row.bottomY).toBeCloseTo(
          lb.descentBelowBaseline + lb.halfLeading + pt(SPACE.s2) + (row.lines - 1) * 0,
          6,
        );
        // Invariant 5: multi-line rows grow by whole line boxes.
        expect(row.bottomY).toBeCloseTo(
          row.boxTopY - row.lines * row.lineBoxHeightPt - pt(SPACE.s2),
          6,
        );
      }
      // Invariant 2: uniform across every row.
      const gaps = new Set(rows.map((r) => ruleToCapGap(r).toFixed(6)));
      expect(gaps.size).toBe(1);
    }
  });

  it("group headings: ≥ space-6 from the block above, space-2 to their first rule (proximity)", async () => {
    for (const result of [await goldP, await denseP]) {
      const headings = result.rhythm.filter((r) => r.kind === "group-heading" && r.page === 2);
      expect(headings.length).toBeGreaterThanOrEqual(4); // 3 summary groups + provenance (+ segment table)
      for (const h of headings) {
        // Gap above (block boundary → heading box top) is exactly space-6…
        expect(h.padTopPt).toBeCloseTo(pt(SPACE.s6), 6);
        // …and the heading hangs space-2 above its first rule: bottom pad.
        const bottomPad = h.bottomY;
        const headingBoxBottom = h.boxTopY - h.lineBoxHeightPt;
        expect(headingBoxBottom - bottomPad).toBeCloseTo(pt(SPACE.s2), 6);
        // Proximity: closer to its rows (space-2) than to the section above (space-6).
        expect(pt(SPACE.s2)).toBeLessThan(pt(SPACE.s6));
      }
      // The first row under each heading really starts at the heading's
      // nextRule position: a K/V row hangs its rule there, or a table header
      // row hangs its line box there (padTop below the same boundary).
      const rows = result.rhythm.filter((r) => r.page === 2 && r.kind !== "group-heading");
      for (const h of headings) {
        const attached = rows.some((r) => {
          const hangsFrom = r.ruleY ?? r.boxTopY + r.padTopPt;
          return Math.abs(hangsFrom - h.bottomY) < EPS;
        });
        expect(attached, `heading at boxTop=${h.boxTopY} has no attached first row`).toBe(true);
      }
    }
  });

  it("summary groups are separated by at least space-6 of air (rule-to-cap across groups)", async () => {
    for (const result of [await goldP, await denseP]) {
      const page2 = result.rhythm.filter((r) => r.page === 2);
      // Rows in draw order; group heading n+1 hangs from the bottom of the
      // previous group's last row.
      for (let i = 1; i < page2.length; i++) {
        const row = page2[i]!;
        if (row.kind !== "group-heading") continue;
        const prev = page2
          .slice(0, i)
          .filter((r) => r.bottomY >= row.boxTopY - EPS)
          .sort((a, b) => a.bottomY - b.bottomY)[0];
        if (!prev) continue; // first heading hangs from the header rule
        expect(prev.bottomY - row.boxTopY).toBeGreaterThanOrEqual(pt(SPACE.s6) - EPS);
      }
    }
  });

  it("segment + provenance table rows: metrics-exact gap at table density, uniform", async () => {
    const metrics = fontVerticalMetrics(loadBarlow());
    const lb = lineBox(metrics, TYPE.tableCell, LINE_HEIGHT.body);
    const expected = pt(SPACE.s1) + lb.capTopFromBoxTop;
    // NOTE: at full sheet size neither fixture forces the tag cascade, so
    // the segment table may be legitimately absent (§16: it appears exactly
    // when tags were moved). Its rows share the same line box + pads as the
    // provenance rows asserted below; when present they are gated identically.
    for (const result of [await goldP, await denseP]) {
      const rows = [...rowsOf(result, "segment-row"), ...rowsOf(result, "provenance-row")];
      expect(rowsOf(result, "provenance-row").length).toBeGreaterThanOrEqual(6);
      const gaps = new Set<string>();
      for (const row of rows) {
        expect(ruleToCapGap(row)).toBeCloseTo(expected, 6);
        expect(ruleToCapGap(row)).toBeGreaterThanOrEqual(row.padTopPt + row.halfLeadingPt - EPS);
        gaps.add(ruleToCapGap(row).toFixed(6));
      }
      expect(gaps.size).toBe(1);
    }
  });

  it("legend rows (sheets 1 and 3): first row clears the footer rule, pitch is whole line boxes", async () => {
    for (const result of [await goldP, await denseP]) {
      for (const page of [1, 3] as const) {
        const rows = result.rhythm.filter((r) => r.kind === "legend-row" && r.page === page);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const first = rows.find((r) => r.ruleY != null)!;
        expect(first).toBeDefined();
        const lb = lineBox(fontVerticalMetrics(loadBarlow()), first.fontSizePt, LINE_HEIGHT.body);
        expect(ruleToCapGap(first)).toBeCloseTo(pt(SPACE.s2) + lb.capTopFromBoxTop, 6);
        expect(ruleToCapGap(first)).toBeGreaterThanOrEqual(first.padTopPt + first.halfLeadingPt - EPS);
        // Uniform pitch: consecutive rows are exactly one line box + space-2 apart.
        const sorted = [...rows].sort((a, b) => b.boxTopY - a.boxTopY);
        for (let i = 1; i < sorted.length; i++) {
          const pitch = sorted[i - 1]!.boxTopY - sorted[i]!.boxTopY;
          expect(pitch).toBeCloseTo(sorted[i]!.lineBoxHeightPt + pt(SPACE.s2), 6);
        }
      }
    }
  });

  it("imagery strip cells hang space-3 below the strip's top rule with line-box clearance", async () => {
    for (const result of [await goldP, await denseP]) {
      const cells = result.rhythm.filter((r) => r.kind === "strip-cell" && r.page === 3);
      expect(cells.length).toBe(4);
      for (const cell of cells) {
        expect(cell.padTopPt).toBeCloseTo(pt(SPACE.s3), 6);
        expect(ruleToCapGap(cell)).toBeGreaterThanOrEqual(cell.padTopPt + cell.halfLeadingPt - EPS);
      }
    }
  });

  it("page 2 never runs into the fine-print band (§13: restructure, never spill)", async () => {
    for (const result of [await goldP, await denseP]) {
      for (const row of result.rhythm.filter((r) => r.page === 2)) {
        expect(row.bottomY).toBeGreaterThan(72); // fine-print band top ≈ 65–75pt
      }
    }
  });
});
