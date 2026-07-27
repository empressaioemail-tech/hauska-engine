import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";

import type { SitePlanModel } from "../site-model.js";
import { feetFromMeters, type PlacedLabel } from "./annotation-placement.js";
import { buildSitePlanDrawingLayout, type DrawingBox, type PageXY, type SitePlanDrawingLayout } from "./layout.js";
import { buildProvenancePanelEntries, SITE_PLAN_HONESTY_LINE } from "./provenance.js";

const PAGE_WIDTH = 612; // US Letter, PDF points (72/in)
const PAGE_HEIGHT = 792;
const MARGIN = 36;
const NEATLINE_INSET = 8;
const TITLE_BLOCK_HEIGHT = 58;

const BLACK = rgb(0, 0, 0);
const PROPERTY_COLOR = rgb(0.05, 0.05, 0.05);
const ENVELOPE_FILL = rgb(0.96, 0.9, 0.78);
const SETBACK_COLOR = rgb(0.72, 0.35, 0.05);
const CONTOUR_COLOR = rgb(0.72, 0.62, 0.48);
const STREET_COLOR = rgb(0.1, 0.35, 0.75);
const GRAY = rgb(0.35, 0.35, 0.35);
const MUTED = rgb(0.5, 0.5, 0.5);
const LEADER_COLOR = rgb(0.45, 0.45, 0.45);

export interface PdfSitePlanResult {
  bytes: Uint8Array;
  pageCount: number;
}

function fieldOrNotOnFile(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  return t.length > 0 ? t : "not on file";
}

function drawNeatline(page: PDFPage): void {
  const x = MARGIN - NEATLINE_INSET;
  const y = MARGIN - NEATLINE_INSET;
  const w = PAGE_WIDTH - 2 * (MARGIN - NEATLINE_INSET);
  const h = PAGE_HEIGHT - 2 * (MARGIN - NEATLINE_INSET);
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    borderColor: BLACK,
    borderWidth: 1.25,
    color: undefined,
  });
  page.drawRectangle({
    x: x + 3,
    y: y + 3,
    width: w - 6,
    height: h - 6,
    borderColor: GRAY,
    borderWidth: 0.4,
    color: undefined,
  });
}

function drawLegendSwatch(
  page: PDFPage,
  x: number,
  y: number,
  color: RGB,
  style: "solid" | "dash" | "fill" | "thin",
): void {
  const w = 14;
  const h = 6;
  if (style === "fill") {
    page.drawRectangle({ x, y, width: w, height: h, color, borderWidth: 0 });
    return;
  }
  if (style === "dash") {
    page.drawLine({
      start: { x, y: y + h / 2 },
      end: { x: x + w, y: y + h / 2 },
      thickness: 1.2,
      color,
      dashArray: [3, 2],
    });
    return;
  }
  page.drawLine({
    start: { x, y: y + h / 2 },
    end: { x: x + w, y: y + h / 2 },
    thickness: style === "thin" ? 0.6 : 1.75,
    color,
  });
}

function drawTitleBlock(
  page: PDFPage,
  model: SitePlanModel,
  bold: PDFFont,
  font: PDFFont,
  pageScalePtsPerMeter: number | null,
): void {
  const top = PAGE_HEIGHT - MARGIN;
  const blockTop = top;
  const blockBottom = top - TITLE_BLOCK_HEIGHT;
  const blockLeft = MARGIN;
  const blockRight = PAGE_WIDTH - MARGIN;

  page.drawRectangle({
    x: blockLeft,
    y: blockBottom,
    width: blockRight - blockLeft,
    height: TITLE_BLOCK_HEIGHT,
    borderColor: BLACK,
    borderWidth: 0.9,
    color: undefined,
  });

  page.drawText("SITE PLAN", { x: blockLeft + 8, y: blockTop - 14, size: 14, font: bold, color: BLACK });
  page.drawText(`Parcel ${fieldOrNotOnFile(model.parcelNodeId)}`, {
    x: blockLeft + 8,
    y: blockTop - 28,
    size: 9,
    font,
    color: BLACK,
  });
  page.drawText(fieldOrNotOnFile(model.summary.address), {
    x: blockLeft + 8,
    y: blockTop - 40,
    size: 8,
    font,
    color: GRAY,
  });

  // Sheet meta — missing fields render "not on file"; never invent survey dates/scales.
  // Scale is derived from the drawing transform (pts/metre → ft per printed inch).
  const metaX = blockLeft + 220;
  const scaleRatio =
    pageScalePtsPerMeter != null && pageScalePtsPerMeter > 0
      ? `1" = ${feetFromMeters(72 / pageScalePtsPerMeter).toFixed(0)} ft`
      : "not on file";
  const sheetId = model.parcelNodeId?.trim()
    ? `SP-${model.parcelNodeId.replace(/:/g, "-")}`
    : "not on file";
  const metaRows: Array<[string, string]> = [
    ["Scale", scaleRatio],
    ["Date", "not on file"],
    ["Sheet", sheetId],
  ];
  let metaY = blockTop - 14;
  for (const [k, v] of metaRows) {
    page.drawText(`${k}:`, { x: metaX, y: metaY, size: 7, font: bold, color: BLACK });
    page.drawText(v, { x: metaX + 32, y: metaY, size: 7, font, color: GRAY });
    metaY -= 11;
  }

  // Legend with color swatches (right side of title band).
  const legendX = PAGE_WIDTH - MARGIN - 168;
  const legendItems: Array<{ label: string; color: RGB; style: "solid" | "dash" | "fill" | "thin" }> = [
    { label: "PROPERTY", color: PROPERTY_COLOR, style: "solid" },
    { label: "ENVELOPE", color: ENVELOPE_FILL, style: "fill" },
    { label: "SETBACK", color: SETBACK_COLOR, style: "dash" },
    { label: "CONTOUR", color: CONTOUR_COLOR, style: "thin" },
    { label: "STREET", color: STREET_COLOR, style: "solid" },
  ];
  let ly = blockTop - 12;
  page.drawText("LEGEND", { x: legendX, y: ly, size: 7, font: bold, color: BLACK });
  ly -= 11;
  for (const item of legendItems) {
    drawLegendSwatch(page, legendX, ly - 1, item.color, item.style);
    page.drawText(item.label, { x: legendX + 18, y: ly, size: 6.5, font, color: GRAY });
    ly -= 9;
  }
}

function drawRing(
  page: PDFPage,
  ring: Array<{ x: number; y: number }>,
  color: RGB = BLACK,
  thickness = 1.25,
  dashArray?: number[],
): void {
  const n = ring.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    page.drawLine({ start: a, end: b, thickness, color, dashArray });
  }
}

function drawFilledRing(page: PDFPage, ring: PageXY[], fill: RGB): void {
  if (ring.length < 3) return;
  const first = ring[0]!;
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    path += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  path += " Z";
  page.drawSvgPath(path, { color: fill, borderWidth: 0 });
}

function drawPolyline(page: PDFPage, points: Array<{ x: number; y: number }>, color = BLACK, thickness = 0.75): void {
  for (let i = 0; i < points.length - 1; i++) {
    page.drawLine({ start: points[i]!, end: points[i + 1]!, thickness, color });
  }
}

function drawPlacedLabel(
  page: PDFPage,
  label: PlacedLabel,
  font: PDFFont,
  color: RGB,
): void {
  if (label.leader) {
    page.drawLine({
      start: label.leader.from,
      end: label.leader.to,
      thickness: 0.4,
      color: LEADER_COLOR,
    });
  }
  page.drawText(label.text, {
    x: label.drawAt.x,
    y: label.drawAt.y,
    size: label.fontSize,
    font,
    color,
  });
}

/** North arrow with triangular arrowhead + N label. */
function drawNorthArrow(page: PDFPage, layout: SitePlanDrawingLayout, bold: PDFFont): void {
  const { origin, tip } = layout.north;
  const dx = tip.x - origin.x;
  const dy = tip.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const headLen = Math.min(10, len * 0.35);
  const headWidth = headLen * 0.55;
  const base = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
  const left = { x: base.x + px * headWidth, y: base.y + py * headWidth };
  const right = { x: base.x - px * headWidth, y: base.y - py * headWidth };

  page.drawLine({ start: origin, end: tip, thickness: 1.5, color: BLACK });
  // Filled arrowhead via SVG path.
  const path = `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} L ${left.x.toFixed(2)} ${left.y.toFixed(2)} L ${right.x.toFixed(2)} ${right.y.toFixed(2)} Z`;
  page.drawSvgPath(path, { color: BLACK, borderWidth: 0 });
  page.drawText("N", {
    x: tip.x + ux * 4 + 1,
    y: tip.y + uy * 4 - 2,
    size: 10,
    font: bold,
    color: BLACK,
  });
}

/** Graphic scale bar with end ticks, mid tick, 0 / mid / max labels, FEET. */
function drawScaleBar(page: PDFPage, layout: SitePlanDrawingLayout, font: PDFFont, bold: PDFFont): void {
  const { start, end, lengthMeters } = layout.scaleBar;
  const lengthFeet = feetFromMeters(lengthMeters);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const tick = 5;

  page.drawLine({ start, end, thickness: 1.5, color: BLACK });
  // End + mid ticks.
  for (const p of [start, mid, end]) {
    page.drawLine({
      start: { x: p.x, y: p.y - tick / 2 },
      end: { x: p.x, y: p.y + tick / 2 },
      thickness: 1,
      color: BLACK,
    });
  }

  const zero = "0";
  const midLabel = `${(lengthFeet / 2).toFixed(0)}`;
  const maxLabel = `${lengthFeet.toFixed(0)}`;
  page.drawText(zero, { x: start.x - 2, y: start.y + tick + 1, size: 6, font, color: BLACK });
  page.drawText(midLabel, {
    x: mid.x - font.widthOfTextAtSize(midLabel, 6) / 2,
    y: mid.y + tick + 1,
    size: 6,
    font,
    color: BLACK,
  });
  page.drawText(maxLabel, {
    x: end.x - font.widthOfTextAtSize(maxLabel, 6) / 2,
    y: end.y + tick + 1,
    size: 6,
    font,
    color: BLACK,
  });
  page.drawText("FEET", {
    x: mid.x - font.widthOfTextAtSize("FEET", 6.5) / 2,
    y: start.y - tick - 8,
    size: 6.5,
    font: bold,
    color: BLACK,
  });
}

function drawSitePlanDrawing(page: PDFPage, layout: SitePlanDrawingLayout, font: PDFFont, bold: PDFFont): void {
  // Draw order = visual hierarchy: contours behind, property + envelope dominate.

  // 1) CONTOUR (decluttered / clipped) — light, behind
  for (const contour of layout.contours) {
    drawPolyline(page, contour.points, CONTOUR_COLOR, 0.4);
  }

  // 2) STREET
  if (layout.streets.honestAbsence) {
    page.drawText(`STREET: ${layout.streets.reason ?? "no road-anchor data available"}`, {
      x: MARGIN,
      y: MARGIN + 28,
      size: 7,
      font,
      color: STREET_COLOR,
    });
  } else {
    for (const anchor of layout.streets.anchors) {
      if (anchor.leftEdge && anchor.leftEdge.length >= 2) {
        drawPolyline(page, anchor.leftEdge, STREET_COLOR, 0.75);
      }
      if (anchor.rightEdge && anchor.rightEdge.length >= 2) {
        drawPolyline(page, anchor.rightEdge, STREET_COLOR, 0.75);
      }
      drawPolyline(page, anchor.points, STREET_COLOR, 1.75);
      if (anchor.label) {
        drawPlacedLabel(page, anchor.label, bold, STREET_COLOR);
      }
    }
  }

  // 3) Buildable envelope fill (same offset ring as CAD SETBACK)
  if (layout.setback.offsetRing) {
    drawFilledRing(page, layout.setback.offsetRing, ENVELOPE_FILL);
  }

  // 4) PROPERTY_LINE + corners (dominant)
  drawRing(page, layout.propertyLine, PROPERTY_COLOR, 2);
  for (const corner of layout.propertyLine) {
    page.drawCircle({ x: corner.x, y: corner.y, size: 2.1, color: PROPERTY_COLOR });
  }

  // 5) SETBACK offset ring (dashed)
  if (layout.setback.offsetRing) {
    drawRing(page, layout.setback.offsetRing, SETBACK_COLOR, 1.35, [5, 3]);
  } else {
    page.drawText(
      `SETBACK: no buildable envelope drawn - ${layout.setback.degenerateReason ?? "offset degenerate"}`,
      { x: MARGIN, y: MARGIN + 16, size: 8, font, color: SETBACK_COLOR },
    );
  }

  // 6) Property-line tags (bearing + distance, GIS-approximate, non-colliding)
  for (const tag of layout.propertyLineTags) {
    drawPlacedLabel(page, tag, font, GRAY);
  }

  // 7) Setback role labels (inward, non-colliding)
  for (const label of layout.setback.labels) {
    drawPlacedLabel(page, label, bold, SETBACK_COLOR);
  }

  // 8) Sparse elevation labels (collision-placed)
  for (const label of layout.elevationLabels) {
    drawPlacedLabel(page, label, font, MUTED);
  }

  // 8b) Optional lot-area callout
  if (layout.lotAreaCallout) {
    drawPlacedLabel(page, layout.lotAreaCallout, bold, BLACK);
  }

  // 9) NORTH arrow + SCALE bar (craft)
  drawNorthArrow(page, layout, bold);
  drawScaleBar(page, layout, font, bold);

  // 10) GIS property-line honesty (page 1 — reinforced again on page 2)
  page.drawText(layout.propertyLineTagsHonesty, {
    x: MARGIN,
    y: MARGIN + 4,
    size: 7,
    font,
    color: MUTED,
  });
}

const SUMMARY_VALUE_X = MARGIN + 150;
const SUMMARY_VALUE_SIZE = 9;

/** Greedy word-wrap so long honesty notes (e.g. the buildable-area
 * provisional note) never run off the page edge instead of just being
 * silently truncated by the PDF viewer. */
function wrapTextToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawSummaryBlock(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont): number {
  const s = model.summary;
  let y = PAGE_HEIGHT - MARGIN;
  page.drawText("SUMMARY", { x: MARGIN, y, size: 13, font: bold, color: BLACK });
  y -= 20;

  // B3: shared vocabulary with PE map card / inspect - never print a bare
  // "setback-consumes-lot" when the warm envelope (or drawable offset) has area.
  // ASCII hyphens only in drawn strings: Helvetica/WinAnsi drops U+2014 em-dashes
  // and can omit the whole token (broke the "unavailable" honesty probe).
  const buildableAreaLine = s.buildablePdfLabel;
  const floodLine = "zone" in s.floodZone
    ? `${s.floodZone.zone ?? "outside mapped SFHA"} (${s.floodZone.inSpecialFloodHazardArea ? "in" : "not in"} special flood hazard area)`
    : `unavailable - ${s.floodZone.reason}`;
  const zoningLine = s.zoningDistrict ?? `unavailable - ${s.zoningHonestAbsenceReason ?? "no zoning-fact atom on file"}`;
  const countyLine = s.countyName ?? `FIPS ${s.countyFips ?? "unknown"} (county name not on file)`;
  const addressLine = s.address ?? "not on file";

  const rows: Array<[string, string]> = [
    ["Parcel ID", s.parcelNodeId],
    ["Address", addressLine],
    ["County", countyLine],
    ["Zoning District", zoningLine],
    ["Lot Area", `${s.lotAreaSqFt.toFixed(0)} sq ft`],
    ["Setbacks (Front/Side/Rear)", model.setback.displayLine],
    ["Buildable Area", buildableAreaLine],
    ["Flood Zone", floodLine],
    [
      "Elevation Range",
      `${s.elevationRangeMeters.min.toFixed(1)} \u2013 ${s.elevationRangeMeters.max.toFixed(1)} m (${s.verticalDatumSummary})`,
    ],
  ];

  const maxValueWidth = PAGE_WIDTH - MARGIN - SUMMARY_VALUE_X;
  for (const [label, value] of rows) {
    page.drawText(`${label}:`, { x: MARGIN, y, size: 9, font: bold, color: BLACK });
    const lines = wrapTextToWidth(value, font, SUMMARY_VALUE_SIZE, maxValueWidth);
    for (const line of lines) {
      page.drawText(line, { x: SUMMARY_VALUE_X, y, size: SUMMARY_VALUE_SIZE, font, color: BLACK });
      y -= 12;
    }
    y -= 4;
  }
  return y;
}

function drawProvenancePanel(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont, startY: number): number {
  let y = startY - 16;
  page.drawText("PROVENANCE / CITATIONS", { x: MARGIN, y, size: 13, font: bold, color: BLACK });
  y -= 18;
  const entries = buildProvenancePanelEntries(model);
  for (const entry of entries) {
    page.drawText(entry.layer, { x: MARGIN, y, size: 9, font: bold, color: BLACK });
    y -= 12;
    page.drawText(`Source: ${entry.source}`, { x: MARGIN + 12, y, size: 8, font, color: GRAY });
    y -= 11;
    page.drawText(`As of: ${entry.asOf}  |  Confidence: ${entry.confidence}`, {
      x: MARGIN + 12,
      y,
      size: 8,
      font,
      color: GRAY,
    });
    y -= 15;
  }
  return y;
}

function drawHonestyLine(page: PDFPage, bold: PDFFont, font: PDFFont, y: number): void {
  page.drawText(SITE_PLAN_HONESTY_LINE, { x: MARGIN, y: Math.max(y, MARGIN + 14), size: 9, font: bold, color: BLACK });
  page.drawText(
    "Property-line bearing/distance tags are GIS-approximate from the county parcel ring - not survey-grade.",
    { x: MARGIN, y: Math.max(y - 12, MARGIN), size: 7, font, color: MUTED },
  );
}

/**
 * Renders the PDF site-plan sheet from the SAME `SitePlanModel` the
 * DXF/IFC site-plan emitters read (WDLL 5) — page 1 is the drawing, page 2
 * is the summary block + provenance panel + honesty line.
 */
export async function emitPdfSitePlan(model: SitePlanModel): Promise<PdfSitePlanResult> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawNeatline(page1);
  const drawingBox: DrawingBox = {
    x: MARGIN,
    y: MARGIN + 40,
    width: PAGE_WIDTH - MARGIN * 2,
    height: PAGE_HEIGHT - MARGIN * 2 - TITLE_BLOCK_HEIGHT - 40,
  };
  const layout = buildSitePlanDrawingLayout(model, drawingBox, {
    measureText: (text, size) => font.widthOfTextAtSize(text, size),
  });
  drawTitleBlock(page1, model, bold, font, layout.transform.scale);
  drawSitePlanDrawing(page1, layout, font, bold);

  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawNeatline(page2);
  const afterSummaryY = drawSummaryBlock(page2, model, bold, font);
  const afterProvenanceY = drawProvenancePanel(page2, model, bold, font, afterSummaryY);
  drawHonestyLine(page2, bold, font, afterProvenanceY - 10);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount() };
}
