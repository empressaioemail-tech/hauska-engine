import { describe, expect, it } from "vitest";

import { composeSitePlanModel, type SitePlanModel } from "../../site-model.js";
import {
  countSitePlanSheets,
  emitPdfSitePlan,
  SITE_PLAN_BRAND_KICKER,
  type EmitPdfSitePlanOptions,
  type PdfSitePlanResult,
} from "../render.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

/**
 * OVERFLOW-PAGINATION GATE (operator rule, 2026-07-29): "if information for a
 * sheet flows over, insert another page so it does not get jumbled."
 *
 * Live repro shape: Bastrop 48021:81432 ("1409 SH 95", 32 acres) — a boundary
 * with many segments whose segment table + provenance sections overflowed the
 * summary sheet's content frame and drew on top of each other. The gate
 * fixture is a synthetic 32-segment ring that forces the same overflow.
 *
 * Mechanical assertions (this repo's standard — never prose):
 *   a. layout invariant — every drawn block's bottom stays inside the content
 *      frame on every summary sheet (asserted numerically off the §21 rhythm
 *      capture, no rasterizing);
 *   b. pagination triggers — >1 summary sheet, the table header row repeated
 *      on the continuation, the split section's heading re-drawn suffixed
 *      "(CONTINUED)";
 *   c. "SHEET k OF n" consistency — same n everywhere, k strictly increasing,
 *      n equals the actual page count (eyebrows AND fine-print trailers);
 *   d. section headings are never orphaned — each heading lands with at least
 *      2 content rows on its sheet;
 *   e. countSitePlanSheets (the host-document sizing seam) agrees with the
 *      emitted page count.
 */

const EPS = 1e-6;

// 1x1 red PNG — real, decodable; the aerial fetch NEVER hits the network.
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const aerialStubOk: EmitPdfSitePlanOptions = { aerial: { fetchImage: async () => TINY_PNG } };

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

/** Deterministic 32-vertex ring (~60 m across): every edge is far too short
 * for a full bearing tag, so every segment lands in the sheet-2 segment table
 * (distance-only / margin-leader / dropped) — 32 table rows, guaranteed. */
function manySegmentRing(n: number): Array<[number, number]> {
  const cx = -97.32;
  const cy = 30.11;
  const radius = 0.00028;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = radius * (1 + 0.15 * Math.sin(3 * a));
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.87]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

const SEGMENTS = 32;

function buildOverflowModel(): SitePlanModel {
  const ring = manySegmentRing(SEGMENTS);
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const padLng = (Math.max(...lngs) - Math.min(...lngs)) * 0.35;
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.35;
  return composeSitePlanModel({
    parcelNodeId: "qa:overflow-32seg",
    bbox: {
      westLng: Math.min(...lngs) - padLng,
      eastLng: Math.max(...lngs) + padLng,
      southLat: Math.min(...lats) - padLat,
      northLat: Math.max(...lats) + padLat,
    },
    ringWgs84: ring,
    dem: syntheticDem(8, 130, 3.2),
    contourIntervalMeters: 0.5,
    setback: {
      front: 15,
      side: 5,
      rear: 15,
      sourceCodeAtomRef: { atomDid: "fixture/udc:overflow-gate", role: "rule", entityType: "code-section" },
    },
    frontEdgeIndex: 0,
    geometrySourceRef: "qa-overflow-synthetic-32-segment-ring",
    demSourceCitation: "synthetic-fixture DEM (overflow gate sample; not live 3DEP)",
    descriptor: { address: "1409 SH 95, Bastrop, TX", countyName: "Bastrop County" },
    zoning: { district: "R-1", fixture: true },
    floodZone: { honestUnavailable: true, reason: "FEMA NFHL not queried on this run." },
  });
}

function tightText(decoded: string): string {
  const start = decoded.indexOf("TIGHT");
  const end = decoded.lastIndexOf("SPACED");
  if (start < 0) return decoded;
  return decoded.slice(start, end > start ? end : undefined);
}

function spacedText(decoded: string): string {
  const i = decoded.lastIndexOf("SPACED");
  return i >= 0 ? decoded.slice(i) : decoded;
}

interface Rendered {
  model: SitePlanModel;
  result: PdfSitePlanResult;
  decoded: string;
}

async function render(): Promise<Rendered> {
  const model = buildOverflowModel();
  const result = await emitPdfSitePlan(model, aerialStubOk);
  return { model, result, decoded: decodeAllContentStreams(result.bytes) };
}

// Render once, share across the gate items (fonts make each emit heavy).
const renderedP = render();

describe("overflow-pagination gate (summary-sheet flow)", { timeout: 120_000 }, () => {
  it("the fixture actually forces the overflow: 20+ segment-table rows and more than one summary sheet", async () => {
    const { result } = await renderedP;
    // Every one of the 32 segments lands in the table (short edges — full
    // tags can never fit), so the flow MUST paginate.
    const segRows = result.rhythm.filter((r) => r.kind === "segment-row");
    expect(segRows.length).toBeGreaterThanOrEqual(20);
    expect(result.summarySheets.length).toBeGreaterThan(1);
    expect(result.pageCount).toBe(2 + result.summarySheets.length);
  });

  it("a) LAYOUT INVARIANT: every drawn block's bottom y stays inside the content frame on every summary sheet", async () => {
    const { result } = await renderedP;
    for (const sheet of result.summarySheets) {
      const rows = result.rhythm.filter((r) => r.page === sheet.localPage);
      expect(rows.length, `summary sheet localPage=${sheet.localPage} has no rhythm rows`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          row.bottomY,
          `${row.kind} on localPage ${sheet.localPage} crosses the frame bottom`,
        ).toBeGreaterThanOrEqual(sheet.frameBottomY - EPS);
        expect(
          row.boxTopY,
          `${row.kind} on localPage ${sheet.localPage} rises into the header`,
        ).toBeLessThanOrEqual(sheet.frameTopY + EPS);
      }
    }
  });

  it("b) PAGINATION TRIGGERS: the split section re-draws its heading '(CONTINUED)' and repeats the table header row", async () => {
    const { result, decoded } = await renderedP;
    // The section heading on the continuation sheet carries the suffix.
    expect(tightText(decoded)).toContain("(CONTINUED)");
    // The segment table splits between rows: its header row (SEG · BEARING ·
    // DIST. · ON SHEET 1) is drawn on more than one summary sheet.
    const headPages = new Set(result.rhythm.filter((r) => r.kind === "segment-head").map((r) => r.page));
    expect(headPages.size).toBeGreaterThanOrEqual(2);
    // Rows for the same table appear on every sheet that carries its header
    // — the table flows, it is never re-drawn whole (no duplicated rows).
    const segRows = result.rhythm.filter((r) => r.kind === "segment-row");
    const rowPages = new Set(segRows.map((r) => r.page));
    for (const p of headPages) expect(rowPages.has(p)).toBe(true);
    // §14 stays intact across the split: no duplicate (page, kind, key) mark.
    const ids = result.marks.map((m) => `${m.page}:${m.kind}:${m.key}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("c) 'SHEET k OF n' is consistent everywhere: same n, k strictly increasing, n equals the page count", async () => {
    const { result, decoded } = await renderedP;
    const n = result.pageCount;
    expect(n).toBeGreaterThan(3); // the old hard-coded "OF 3" cannot be right here

    // Eyebrows (tracked caps reconstruct contiguously in the tight join). One
    // exact "SHEET k OF n" per sheet, k = 1..n: drawing, each summary sheet,
    // aerial last.
    const tight = tightText(decoded);
    expect(tight).toContain(`${SITE_PLAN_BRAND_KICKER} · SITE PLAN · SHEET 1 OF ${n}`);
    for (const sheet of result.summarySheets) {
      expect(sheet.printedNo).toBe(sheet.localPage); // standalone: startAt = 1
      expect(tight).toContain(`${SITE_PLAN_BRAND_KICKER} · SUMMARY · SHEET ${sheet.printedNo} OF ${n}`);
    }
    expect(tight).toContain(`${SITE_PLAN_BRAND_KICKER} · AERIAL · SHEET ${n} OF ${n}`);
    // No sheet still prints a stale total (e.g. the pre-pagination "OF 3").
    for (let k = 1; k <= n; k++) {
      expect(tight).not.toContain(`SHEET ${k} OF ${n - 1}`);
      expect(tight).not.toContain(`SHEET ${k} OF ${n + 1}`);
    }

    // Fine-print trailers ("· Sheet k of n") on every sheet, same n.
    const spaced = spacedText(decoded);
    const trailerKs = new Set<number>();
    const trailerRe = /Sheet (\d+) of (\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = trailerRe.exec(spaced))) {
      trailerKs.add(Number(m[1]));
      expect(Number(m[2]), `fine-print total in "${m[0]}"`).toBe(n);
    }
    expect([...trailerKs].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it("d) NO ORPHANED SECTION HEADER: every heading lands with at least 2 content rows on its sheet", async () => {
    const { result } = await renderedP;
    for (const sheet of result.summarySheets) {
      const rows = result.rhythm.filter((r) => r.page === sheet.localPage);
      const headings = rows.filter((r) => r.kind === "group-heading");
      for (const h of headings) {
        const below = rows.filter((r) => r.kind !== "group-heading" && r.boxTopY <= h.bottomY + EPS);
        expect(
          below.length,
          `heading at boxTop=${h.boxTopY.toFixed(1)} on localPage ${sheet.localPage} is orphaned`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("e) countSitePlanSheets (host-document sizing seam) agrees with the emitted page count", async () => {
    const { model, result } = await renderedP;
    await expect(countSitePlanSheets(model)).resolves.toBe(result.pageCount);
  });

  it("keeps the single-sheet contract intact: summarySheets reports exactly one frame per summary sheet and the aerial keeps its marks on its own page", async () => {
    const { result } = await renderedP;
    const aerialLocalPage = result.summarySheets.length + 2;
    // Aerial furniture landed on the LAST page, not hard-coded page 3.
    const aerialMarks = result.marks.filter((m) => m.kind === "imagery-strip");
    expect(aerialMarks).toHaveLength(1);
    expect(aerialMarks[0]!.page).toBe(aerialLocalPage);
    // Exactly one fine print per emitted page.
    const finePrints = result.marks.filter((m) => m.kind === "fine-print");
    expect(finePrints).toHaveLength(result.pageCount);
    expect(new Set(finePrints.map((m) => m.page)).size).toBe(result.pageCount);
  });
});
