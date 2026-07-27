import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

import type { SitePlanModel } from "../site-model.js";
import { buildSitePlanDrawingLayout, type DrawingBox, type SitePlanDrawingLayout } from "./layout.js";
import { buildProvenancePanelEntries, SITE_PLAN_HONESTY_LINE } from "./provenance.js";

const PAGE_WIDTH = 612; // US Letter, PDF points (72/in)
const PAGE_HEIGHT = 792;
const MARGIN = 36;

const BLACK = rgb(0, 0, 0);
const SETBACK_COLOR = rgb(0.72, 0.35, 0.05);
const CONTOUR_COLOR = rgb(0.55, 0.4, 0.25);
const STREET_COLOR = rgb(0.1, 0.35, 0.75);
const GRAY = rgb(0.35, 0.35, 0.35);

export interface PdfSitePlanResult {
  bytes: Uint8Array;
  pageCount: number;
}

function drawTitleBlock(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont): void {
  const top = PAGE_HEIGHT - MARGIN;
  page.drawText("SITE PLAN", { x: MARGIN, y: top - 14, size: 16, font: bold, color: BLACK });
  page.drawText(`Parcel ${model.parcelNodeId}`, { x: MARGIN, y: top - 32, size: 11, font, color: BLACK });
  if (model.summary.address) {
    page.drawText(model.summary.address, { x: MARGIN, y: top - 46, size: 10, font, color: GRAY });
  }
  page.drawLine({
    start: { x: MARGIN, y: top - 54 },
    end: { x: PAGE_WIDTH - MARGIN, y: top - 54 },
    thickness: 0.75,
    color: GRAY,
  });
}

function drawRing(page: PDFPage, ring: Array<{ x: number; y: number }>, color = BLACK, dashArray?: number[]): void {
  const n = ring.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    page.drawLine({ start: a, end: b, thickness: dashArray ? 1 : 1.25, color, dashArray });
  }
}

function drawPolyline(page: PDFPage, points: Array<{ x: number; y: number }>, color = BLACK, thickness = 0.75): void {
  for (let i = 0; i < points.length - 1; i++) {
    page.drawLine({ start: points[i]!, end: points[i + 1]!, thickness, color });
  }
}

function drawSitePlanDrawing(page: PDFPage, layout: SitePlanDrawingLayout, font: PDFFont): void {
  // PROPERTY_LINE + corner markers
  drawRing(page, layout.propertyLine, BLACK);
  for (const corner of layout.propertyLine) {
    page.drawCircle({ x: corner.x, y: corner.y, size: 1.75, color: BLACK });
  }
  // DIMENSION
  for (const dim of layout.dimensions) {
    page.drawText(`${dim.lengthFeet.toFixed(1)}'`, {
      x: dim.mid.x + 2,
      y: dim.mid.y + 2,
      size: 7,
      font,
      color: GRAY,
    });
  }
  // SETBACK (offset ring, dashed, labeled F/S/R)
  if (layout.setback.offsetRing) {
    drawRing(page, layout.setback.offsetRing, SETBACK_COLOR, [4, 3]);
    for (const label of layout.setback.labels) {
      page.drawText(label.text, {
        x: label.mid.x + 2,
        y: label.mid.y - 8,
        size: 7,
        font,
        color: SETBACK_COLOR,
      });
    }
  } else {
    page.drawText(
      `SETBACK: no buildable envelope drawn — ${layout.setback.degenerateReason ?? "offset degenerate"}`,
      { x: MARGIN, y: MARGIN + 4, size: 8, font, color: SETBACK_COLOR },
    );
  }
  // CONTOUR + ELEVATION_LABEL
  for (const contour of layout.contours) {
    drawPolyline(page, contour.points, CONTOUR_COLOR, 0.5);
  }
  for (const label of layout.elevationLabels) {
    page.drawText(label.elevationMeters.toFixed(1), {
      x: label.point.x + 2,
      y: label.point.y + 2,
      size: 6,
      font,
      color: CONTOUR_COLOR,
    });
  }
  // STREET (or honest absence note)
  if (layout.streets.honestAbsence) {
    page.drawText(`STREET: ${layout.streets.reason ?? "no road-anchor data available"}`, {
      x: MARGIN,
      y: MARGIN + 16,
      size: 8,
      font,
      color: STREET_COLOR,
    });
  } else {
    for (const anchor of layout.streets.anchors) {
      drawPolyline(page, anchor.points, STREET_COLOR, 1.5);
      const label = anchor.points[Math.floor(anchor.points.length / 2)];
      if (label) {
        page.drawText(anchor.name, { x: label.x + 2, y: label.y + 4, size: 8, font, color: STREET_COLOR });
      }
    }
  }
  // NORTH arrow + label
  page.drawLine({ start: layout.north.origin, end: layout.north.tip, thickness: 1.25, color: BLACK });
  page.drawText("N", { x: layout.north.tip.x + 2, y: layout.north.tip.y, size: 9, font, color: BLACK });
  // SCALE bar + label
  page.drawLine({ start: layout.scaleBar.start, end: layout.scaleBar.end, thickness: 1.25, color: BLACK });
  page.drawText(`${layout.scaleBar.lengthMeters.toFixed(0)} m`, {
    x: layout.scaleBar.start.x,
    y: layout.scaleBar.start.y + 4,
    size: 7,
    font,
    color: BLACK,
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

  // B3: shared vocabulary with PE map card / inspect — never print a bare
  // "setback-consumes-lot" when the warm envelope (or drawable offset) has area.
  const buildableAreaLine = s.buildablePdfLabel;  const floodLine = "zone" in s.floodZone
    ? `${s.floodZone.zone ?? "outside mapped SFHA"} (${s.floodZone.inSpecialFloodHazardArea ? "in" : "not in"} special flood hazard area)`
    : `unavailable — ${s.floodZone.reason}`;
  const zoningLine = s.zoningDistrict ?? `unavailable — ${s.zoningHonestAbsenceReason ?? "no zoning-fact atom on file"}`;
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

function drawHonestyLine(page: PDFPage, bold: PDFFont, y: number): void {
  page.drawText(SITE_PLAN_HONESTY_LINE, { x: MARGIN, y: Math.max(y, MARGIN), size: 9, font: bold, color: BLACK });
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
  drawTitleBlock(page1, model, bold, font);
  const drawingBox: DrawingBox = {
    x: MARGIN,
    y: MARGIN + 24,
    width: PAGE_WIDTH - MARGIN * 2,
    height: PAGE_HEIGHT - MARGIN * 2 - 70,
  };
  const layout = buildSitePlanDrawingLayout(model, drawingBox);
  drawSitePlanDrawing(page1, layout, font);

  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const afterSummaryY = drawSummaryBlock(page2, model, bold, font);
  const afterProvenanceY = drawProvenancePanel(page2, model, bold, font, afterSummaryY);
  drawHonestyLine(page2, bold, afterProvenanceY - 10);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount() };
}
