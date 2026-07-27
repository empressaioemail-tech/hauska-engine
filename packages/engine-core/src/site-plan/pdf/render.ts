import { PDFDocument, PDFFont, PDFPage, StandardFonts, type RGB } from "pdf-lib";

import type { SitePlanModel } from "../site-model.js";
import { feetFromMeters, type PlacedLabel } from "./annotation-placement.js";
import { buildSitePlanDrawingLayout, type DrawingBox, type PageXY, type SitePlanDrawingLayout } from "./layout.js";
import { buildProvenancePanelEntries, SITE_PLAN_HONESTY_LINE } from "./provenance.js";
import { PROPERTY_LINE_TAGS_HONESTY } from "../../geometry/gis-property-line-tags.js";
import { STROKE, TOKENS, TRACKING, TYPE, pt } from "./template-tokens.js";

/**
 * Site-plan PDF renderer, rebuilt 2026-07-27 to match the operator's
 * professional "Industry" template (gold reference card 2a/2b). This is a
 * design port into the existing pdf-lib engine — geometry, collision
 * placement, honest-absence language, and the shared bearing formula are
 * unchanged; the header, drawing chrome, legend, scale bar, and summary page
 * were rebuilt to the template's caliber.
 *
 * FONT: the template calls for Barlow (body) + Barlow Condensed (headings).
 * This build environment has no network egress and no @pdf-lib/fontkit, so
 * the TTFs could not be vendored. Falls back to Helvetica / Helvetica-Bold,
 * matching the template's sizing, weight, colour, and (emulated) letter
 * spacing as closely as Helvetica allows. See FONT_SUBSTITUTION_NOTE.
 */
export const FONT_SUBSTITUTION_NOTE =
  "Barlow / Barlow Condensed unavailable in this build (no network, no fontkit); " +
  "rendered with Helvetica at template sizing/weight/tracking/colour.";

// US Letter, PDF points (72/in). Template sheet is 816x1056 px @96dpi.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
// Template page margins 48 / 46 / 36 px @96dpi -> points.
const MARGIN_TOP = pt(48);
const MARGIN_X = pt(46);
const MARGIN_BOTTOM = pt(36);

// Token colour aliases (drawing roles).
const INK = TOKENS.text;
const PROPERTY_COLOR = TOKENS.text; // heaviest stroke, full ink
const ENVELOPE_FILL = TOKENS.accent100;
const SETBACK_DASH_COLOR = TOKENS.accent500;
const SETBACK_LABEL_COLOR = TOKENS.accent700;
const CONTOUR_COLOR = TOKENS.neutral300;
const CONTOUR_LABEL_COLOR = TOKENS.neutral500;
const STREET_COLOR = TOKENS.accent700;
const DIM_TAG_COLOR = TOKENS.neutral700;
const MUTED = TOKENS.neutral600;
const SUPPRESSED = TOKENS.neutral500;
const ACCENT = TOKENS.accent;
const ACCENT_TYPE = TOKENS.accent700;
const LEADER_COLOR = TOKENS.neutral500;

export interface PdfSitePlanResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Names the font actually used (Barlow when embedded, else the fallback). */
  fontNote: string;
}

function fieldOrNotOnFile(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  return t.length > 0 ? t : "not on file";
}

// ─────────────────────────────────────────────────────────────────────────
// Tracked (letter-spaced) text — the template's eyebrows / stat labels / group
// headings carry 0.14–0.22em tracking. pdf-lib 1.17 has no characterSpacing
// option, so tracked runs are drawn glyph-by-glyph with an em-based advance.
// ─────────────────────────────────────────────────────────────────────────
function trackedWidth(font: PDFFont, text: string, size: number, trackingEm: number): number {
  const extra = trackingEm * size * Math.max(0, text.length - 1);
  return font.widthOfTextAtSize(text, size) + extra;
}

function drawTrackedText(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; size: number; font: PDFFont; color: RGB; trackingEm: number },
): number {
  let cursor = opts.x;
  const advance = opts.trackingEm * opts.size;
  for (const ch of text) {
    page.drawText(ch, { x: cursor, y: opts.y, size: opts.size, font: opts.font, color: opts.color });
    cursor += opts.font.widthOfTextAtSize(ch, opts.size) + advance;
  }
  return cursor - advance; // right edge (drop trailing advance)
}

/** Full-width 1px full-ink rule that closes the header (template rule 2). */
function drawHairlineRule(page: PDFPage, x: number, y: number, width: number, color: RGB = INK, thickness: number = STROKE.hairlineRule): void {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness, color });
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE 1 HEADER — gold reference 2a: eyebrow / big condensed address / sub-line
// on the left; right-aligned LOT / BUILDABLE / ZONING stat cluster; a full
// ink rule closes it. No frame, no title strip, no boxed block.
// Returns the y of the closing rule (drawing box starts below it).
// ─────────────────────────────────────────────────────────────────────────
function drawPage1Header(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont): number {
  const s = model.summary;
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  let y = PAGE_HEIGHT - MARGIN_TOP;

  // Eyebrow — accent, uppercase, 0.22em tracking.
  drawTrackedText(page, "SITE PLAN · SHEET 1 OF 2", {
    x: left,
    y,
    size: TYPE.eyebrow,
    font: bold,
    color: ACCENT,
    trackingEm: TRACKING.eyebrow,
  });
  y -= pt(30) + pt(4);

  // Address — largest string on the sheet, condensed-bold uppercase. Street
  // portion only (city goes in the sub-line, per the template) so it isn't
  // doubled.
  const address = streetOnly(s.address).toUpperCase();
  page.drawText(address, { x: left, y, size: TYPE.address, font: bold, color: INK });
  y -= pt(13) + pt(4);

  // Sub-line — city · parcel · county.
  const county = s.countyName ?? (s.countyFips ? `FIPS ${s.countyFips}` : "county not on file");
  const subParts = [cityFromAddress(s.address), `Parcel ${s.parcelNodeId}`, county].filter((p): p is string => !!p);
  page.drawText(subParts.join("  ·  "), { x: left, y, size: TYPE.subline, font, color: TOKENS.neutral700 });

  // Right-aligned stat cluster (LOT / BUILDABLE / ZONING).
  const statTop = PAGE_HEIGHT - MARGIN_TOP - pt(6);
  const stats: Array<{ label: string; value: string; accent?: boolean }> = [
    { label: "LOT", value: `${formatSqFt(s.lotAreaSqFt)} SF` },
    { label: "BUILDABLE", value: buildableStat(s), accent: true },
    { label: "ZONING", value: (s.zoningDistrict ?? "n/a").toUpperCase() },
  ];
  // Lay columns right-to-left so the cluster hugs the right margin.
  const colGap = pt(30);
  const colWidths = stats.map((st) => {
    const lw = trackedWidth(font, st.label, TYPE.statLabel, TRACKING.statLabel);
    const vw = bold.widthOfTextAtSize(st.value, TYPE.statValue);
    return Math.max(lw, vw);
  });
  let cx = right;
  for (let i = stats.length - 1; i >= 0; i--) {
    const st = stats[i]!;
    const w = colWidths[i]!;
    const colLeft = cx - w;
    // Label (small, tracked, neutral-600).
    drawTrackedText(page, st.label, {
      x: colLeft,
      y: statTop,
      size: TYPE.statLabel,
      font,
      color: TOKENS.neutral600,
      trackingEm: TRACKING.statLabel,
    });
    // Value (condensed-bold; buildable in accent-700).
    page.drawText(st.value, {
      x: colLeft,
      y: statTop - pt(22),
      size: TYPE.statValue,
      font: bold,
      color: st.accent ? ACCENT_TYPE : INK,
    });
    cx = colLeft - colGap;
  }

  // Closing full-ink rule.
  const ruleY = Math.min(y, statTop - pt(22)) - pt(10);
  drawHairlineRule(page, left, ruleY, right - left);
  return ruleY;
}

/** Street portion of an address (before the first comma), for the big header line. */
function streetOnly(address: string | undefined): string {
  if (!address) return "not on file";
  const first = address.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "not on file";
}

function cityFromAddress(address: string | undefined): string | null {
  if (!address) return null;
  // "1009 Chestnut St, Bastrop, TX" -> "Bastrop, TX"
  const parts = address.split(",").map((p) => p.trim());
  if (parts.length >= 3) return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
  if (parts.length === 2) return parts[1]!;
  return null;
}

function formatSqFt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** BUILDABLE stat: the shared warm/provisional area if any, else honest short. */
function buildableStat(s: SitePlanModel["summary"]): string {
  if (typeof s.buildableAreaSqFt === "number") return `${formatSqFt(s.buildableAreaSqFt)} SF`;
  return "SEE P.2";
}

// ─────────────────────────────────────────────────────────────────────────
// DRAWING — layer order & weight per template rule 3:
// contour → contour labels → envelope fill → setback dash → property line →
// dimension tags → sheet furniture. Property line is the heaviest stroke.
// ─────────────────────────────────────────────────────────────────────────
function drawRing(page: PDFPage, ring: PageXY[], color: RGB, thickness: number, dashArray?: number[]): void {
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

function drawPolyline(page: PDFPage, points: PageXY[], color: RGB, thickness: number, dashArray?: number[]): void {
  for (let i = 0; i < points.length - 1; i++) {
    page.drawLine({ start: points[i]!, end: points[i + 1]!, thickness, color, dashArray });
  }
}

function drawPlacedLabel(page: PDFPage, label: PlacedLabel, font: PDFFont, color: RGB): void {
  if (label.leader) {
    page.drawLine({ start: label.leader.from, end: label.leader.to, thickness: 0.4, color: LEADER_COLOR });
  }
  page.drawText(label.text, {
    x: label.drawAt.x,
    y: label.drawAt.y,
    size: label.fontSize,
    font,
    color,
  });
}

/**
 * North arrow — filled triangular arrowhead over a condensed "N" (template
 * rule 9 · sheet furniture; no compass rose).
 */
function drawNorthArrow(page: PDFPage, layout: SitePlanDrawingLayout, bold: PDFFont): void {
  const { origin, tip } = layout.north;
  const dx = tip.x - origin.x;
  const dy = tip.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const headLen = Math.min(11, len * 0.4);
  const headWidth = headLen * 0.5;
  const base = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
  const notch = { x: tip.x - ux * headLen * 0.55, y: tip.y - uy * headLen * 0.55 };
  const leftPt = { x: base.x + px * headWidth, y: base.y + py * headWidth };
  const rightPt = { x: base.x - px * headWidth, y: base.y - py * headWidth };

  // Shaft.
  page.drawLine({ start: origin, end: notch, thickness: 1, color: INK });
  // Filled arrowhead (with a slight tail notch, like the template polygon).
  const path =
    `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} ` +
    `L ${leftPt.x.toFixed(2)} ${leftPt.y.toFixed(2)} ` +
    `L ${notch.x.toFixed(2)} ${notch.y.toFixed(2)} ` +
    `L ${rightPt.x.toFixed(2)} ${rightPt.y.toFixed(2)} Z`;
  page.drawSvgPath(path, { color: INK, borderWidth: 0 });
  const nSize = pt(11);
  page.drawText("N", {
    x: tip.x - bold.widthOfTextAtSize("N", nSize) / 2,
    y: tip.y + pt(6),
    size: nSize,
    font: bold,
    color: INK,
  });
}

function drawSitePlanDrawing(page: PDFPage, layout: SitePlanDrawingLayout, font: PDFFont, bold: PDFFont): void {
  // 1) CONTOUR — faint, behind everything.
  for (const contour of layout.contours) {
    drawPolyline(page, contour.points, CONTOUR_COLOR, STROKE.contour);
  }

  // 2) CONTOUR LABELS.
  for (const label of layout.elevationLabels) {
    drawPlacedLabel(page, label, font, CONTOUR_LABEL_COLOR);
  }

  // 3) STREET (drawn behind property line; honest absence handled in footer legend).
  if (!layout.streets.honestAbsence) {
    for (const anchor of layout.streets.anchors) {
      if (anchor.leftEdge && anchor.leftEdge.length >= 2) drawPolyline(page, anchor.leftEdge, STREET_COLOR, 0.6);
      if (anchor.rightEdge && anchor.rightEdge.length >= 2) drawPolyline(page, anchor.rightEdge, STREET_COLOR, 0.6);
      drawPolyline(page, anchor.points, STREET_COLOR, 1.2);
      if (anchor.label) drawPlacedLabel(page, anchor.label, font, STREET_COLOR);
    }
  }

  // 4) BUILDABLE ENVELOPE fill (accent-tinted).
  if (layout.setback.offsetRing) {
    drawFilledRing(page, layout.setback.offsetRing, ENVELOPE_FILL);
  }

  // 5) SETBACK dash (accent-500).
  if (layout.setback.offsetRing) {
    drawRing(page, layout.setback.offsetRing, SETBACK_DASH_COLOR, STROKE.setbackDash, [3.5, 2.8]);
  }

  // 6) PROPERTY LINE — heaviest stroke on the sheet.
  drawRing(page, layout.propertyLine, PROPERTY_COLOR, STROKE.property);

  // 7) BEARING + DISTANCE tags (GIS-approximate; rotated to segment upstream? — drawn flat, non-colliding).
  for (const tag of layout.propertyLineTags) {
    drawPlacedLabel(page, tag, font, DIM_TAG_COLOR);
  }

  // 8) SETBACK role labels (accent-700, inward).
  for (const label of layout.setback.labels) {
    drawPlacedLabel(page, label, font, SETBACK_LABEL_COLOR);
  }

  // 9) Centered BUILDABLE ENVELOPE callout — condensed uppercase over grey qualifier.
  if (layout.envelopeCallout) {
    const { anchor } = layout.envelopeCallout;
    const title = "BUILDABLE ENVELOPE";
    const titleSize = pt(13);
    page.drawText(title, {
      x: anchor.x - bold.widthOfTextAtSize(title, titleSize) / 2,
      y: anchor.y,
      size: titleSize,
      font: bold,
      color: INK,
    });
    const qualifier = layout.envelopeCallout.qualifier;
    if (qualifier) {
      const qSize = pt(8.5);
      page.drawText(qualifier, {
        x: anchor.x - font.widthOfTextAtSize(qualifier, qSize) / 2,
        y: anchor.y - pt(13),
        size: qSize,
        font,
        color: TOKENS.neutral600,
      });
    }
  }

  // 10) NORTH arrow.
  drawNorthArrow(page, layout, bold);
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE 1 FOOTER — gold reference 2a: LEGEND (bottom-left, two columns, every
// layer present + honest empty state) · GRAPHIC SCALE BAR (bottom-right,
// alternating tick blocks, 0/mid/max FEET) · scale-ratio + sheet-id + stamp ·
// honesty disclaimer paragraph. All on the same baseline band.
// ─────────────────────────────────────────────────────────────────────────
interface LegendRow {
  label: string;
  swatch: "line-heavy" | "envelope" | "line-thin" | "line-dotted";
  color: RGB;
  empty?: boolean;
}

function legendRows(layout: SitePlanDrawingLayout): LegendRow[] {
  const streetRow: LegendRow = layout.streets.honestAbsence
    ? {
        label: "Street — layer empty · no road node attaches",
        swatch: "line-dotted",
        color: SUPPRESSED,
        empty: true,
      }
    : { label: "Street centerline", swatch: "line-heavy", color: STREET_COLOR };
  return [
    { label: "Property line", swatch: "line-heavy", color: PROPERTY_COLOR },
    { label: "Setback / buildable envelope", swatch: "envelope", color: ACCENT },
    { label: "Contour, 1 m interval", swatch: "line-thin", color: CONTOUR_COLOR },
    streetRow,
  ];
}

function drawLegendSwatch(page: PDFPage, row: LegendRow, x: number, y: number): void {
  const w = pt(24);
  if (row.swatch === "envelope") {
    // Accent-tinted fill with a dashed accent border.
    page.drawRectangle({ x, y: y - pt(3), width: w, height: pt(9), color: ENVELOPE_FILL, borderWidth: 0 });
    page.drawRectangle({
      x,
      y: y - pt(3),
      width: w,
      height: pt(9),
      borderColor: SETBACK_DASH_COLOR,
      borderWidth: 0.7,
      borderDashArray: [2.2, 1.6],
      color: undefined,
    });
    return;
  }
  const mid = y + pt(1);
  if (row.swatch === "line-dotted") {
    page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: 0.8, color: row.color, dashArray: [0.6, 2] });
    return;
  }
  const thick = row.swatch === "line-heavy" ? 1.4 : 0.7;
  page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: thick, color: row.color });
}

function drawLegend(page: PDFPage, layout: SitePlanDrawingLayout, font: PDFFont, baselineY: number): void {
  const left = MARGIN_X;
  const rows = legendRows(layout);
  // Two columns x two rows, like the template grid.
  const colWidth = pt(230);
  const rowGap = pt(15);
  const size = TYPE.legend;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = left + col * colWidth;
    const y = baselineY - line * rowGap;
    drawLegendSwatch(page, row, x, y);
    page.drawText(row.label, {
      x: x + pt(24) + pt(9),
      y,
      size,
      font,
      color: row.empty ? SUPPRESSED : TOKENS.neutral800,
    });
  }
}

/**
 * Graphic scale bar — three segments (alternating ink / neutral-300 tick
 * blocks) with 0 / mid / max labels, unit on the last (FEET). Bottom-right.
 * Beneath it: scale-ratio · sheet-id · generated stamp.
 */
function drawScaleBar(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  model: SitePlanModel,
  font: PDFFont,
  baselineY: number,
): void {
  const right = PAGE_WIDTH - MARGIN_X;
  const lengthFeet = feetFromMeters(layout.scaleBar.lengthMeters);
  // Three equal blocks; total bar width ~120 pt (template 120 px scaled but
  // kept legible). Alternate solid ink / neutral-300 fill.
  const barWidth = pt(120);
  const blockW = barWidth / 3;
  const barH = pt(5);
  const barLeft = right - barWidth;
  const barTop = baselineY;
  const blockColors = [INK, TOKENS.neutral300, INK];
  for (let i = 0; i < 3; i++) {
    page.drawRectangle({
      x: barLeft + i * blockW,
      y: barTop,
      width: blockW,
      height: barH,
      color: blockColors[i]!,
      borderWidth: 0,
    });
  }
  // Labels 0 / mid / max FEET under the bar.
  const labelSize = TYPE.scaleBarLabel;
  const labelY = barTop - pt(11);
  const zero = "0";
  const midLabel = `${Math.round(lengthFeet / 2)}`;
  const maxLabel = `${Math.round(lengthFeet)} ft`;
  page.drawText(zero, { x: barLeft, y: labelY, size: labelSize, font, color: TOKENS.neutral700 });
  page.drawText(midLabel, {
    x: barLeft + barWidth / 2 - font.widthOfTextAtSize(midLabel, labelSize) / 2,
    y: labelY,
    size: labelSize,
    font,
    color: TOKENS.neutral700,
  });
  page.drawText(maxLabel, {
    x: right - font.widthOfTextAtSize(maxLabel, labelSize),
    y: labelY,
    size: labelSize,
    font,
    color: TOKENS.neutral700,
  });

  // Scale-ratio · sheet-id · generated stamp (right-aligned line).
  // transform.scale = page points per local metre; 1 inch = 72 pt, so a
  // printed inch spans (72 / scale) metres = feetFromMeters(...) feet.
  const scaleRatio =
    layout.transform.scale > 0
      ? `1" = ${Math.round(feetFromMeters(72 / layout.transform.scale))}'`
      : '1" = n/a';
  const sheetId = model.parcelNodeId?.trim() ? `SP-${model.parcelNodeId.replace(/:/g, "-")}` : "SP-not-on-file";
  const stamp = `generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
  const metaLine = `${scaleRatio} · ${sheetId} · ${stamp}`;
  const metaSize = TYPE.scaleRatioLine;
  page.drawText(metaLine, {
    x: right - font.widthOfTextAtSize(metaLine, metaSize),
    y: labelY - pt(13),
    size: metaSize,
    font,
    color: TOKENS.neutral600,
  });
}

/**
 * pdf-lib's Helvetica/WinAnsi encoder drops U+2013/U+2014 dashes (and can
 * swallow the adjacent token), which broke the honesty probe before. Map
 * en/em dashes to a spaced ASCII hyphen and the middle dot to ASCII so every
 * drawn string is WinAnsi-safe. All paragraph/label text routes through here.
 */
function safeText(text: string): string {
  return text
    .replace(/—/g, " - ")
    .replace(/–/g, " - ")
    .replace(/·/g, "·"); // middle dot IS in WinAnsi (0xB7) — keep it
}

/** Greedy word-wrap so long honesty paragraphs stay on the sheet. */
function wrapTextToWidth(rawText: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = safeText(rawText);
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

/**
 * Fine print — one paragraph, 8.2px neutral-600, bottom of page. Always the
 * public-GIS / not-a-survey / GIS-approximate language; honest-absence and
 * synthetic-DEM disclosures append to the SAME paragraph (template rule 8 ·
 * no callout boxes on the drawing).
 */
function buildFinePrint(model: SitePlanModel, page: 1 | 2): string {
  // SITE_PLAN_HONESTY_LINE + PROPERTY_LINE_TAGS_HONESTY are drawn verbatim
  // (75o spec / WDLL 5): any survey-grade claim contradicts these exact
  // strings on the sheet. Template rule 8 folds honest-absence + synthetic-DEM
  // disclosures into this same paragraph — no callout boxes on the drawing.
  const base = `${SITE_PLAN_HONESTY_LINE} ${PROPERTY_LINE_TAGS_HONESTY} These bearing/distance tags are GIS-approximate and not survey-grade.`;
  if (page === 2) {
    return `${base} Zoning district and fixture values must be confirmed against live atoms on planner QA. · Sheet 2 of 2`;
  }
  const streetNote = model.streets.honestAbsence
    ? " Street layer intentionally left empty — no road node attaches to this parcel."
    : "";
  const demNote = " Elevation from a synthetic DEM on sample runs.";
  return `${base}${streetNote}${demNote} · Sheet 1 of 2`;
}

function drawFinePrint(page: PDFPage, text: string, font: PDFFont): void {
  const left = MARGIN_X;
  const size = TYPE.finePrint;
  const maxWidth = PAGE_WIDTH - MARGIN_X * 2;
  const lines = wrapTextToWidth(text, font, size, maxWidth);
  let y = MARGIN_BOTTOM + (lines.length - 1) * (size * 1.55) - pt(2);
  for (const line of lines) {
    page.drawText(line, { x: left, y, size, font, color: TOKENS.neutral600 });
    y -= size * 1.55;
  }
}

function drawPage1Footer(page: PDFPage, layout: SitePlanDrawingLayout, model: SitePlanModel, font: PDFFont): void {
  // Footer band sits above the fine print. Reserve a fine-print band at bottom.
  const finePrintBandTop = MARGIN_BOTTOM + pt(8.2 * 1.55 * 3);
  // Top rule of the footer band.
  const ruleY = finePrintBandTop + pt(52);
  drawHairlineRule(page, MARGIN_X, ruleY, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);

  const legendBaseline = ruleY - pt(16);
  drawLegend(page, layout, font, legendBaseline);
  drawScaleBar(page, layout, model, font, ruleY - pt(8));

  drawFinePrint(page, buildFinePrint(model, 1), font);
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE 2 — SUMMARY (gold reference 2b): condensed uppercase header w/ sheet
// number over parcel-id right-aligned; grouped two-column key/value table
// (PARCEL, ZONING & BUILDABILITY, SITE CONDITIONS); provenance three-column
// table; fine print.
// ─────────────────────────────────────────────────────────────────────────
function drawPage2Header(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont): number {
  const s = model.summary;
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  let y = PAGE_HEIGHT - MARGIN_TOP;

  drawTrackedText(page, "SUMMARY · SHEET 2 OF 2", {
    x: left,
    y,
    size: TYPE.eyebrow,
    font: bold,
    color: ACCENT,
    trackingEm: TRACKING.eyebrow,
  });
  y -= pt(30) + pt(4);

  const address = streetOnly(s.address).toUpperCase();
  page.drawText(address, { x: left, y, size: TYPE.address, font: bold, color: INK });

  // Right: sheet-id over parcel-id (right-aligned).
  const sheetId = model.parcelNodeId?.trim() ? `SP-${model.parcelNodeId.replace(/:/g, "-")}` : "SP-not-on-file";
  const metaTop = PAGE_HEIGHT - MARGIN_TOP;
  const metaSize = TYPE.sheetMeta;
  page.drawText(sheetId, {
    x: right - font.widthOfTextAtSize(sheetId, metaSize),
    y: metaTop - pt(20),
    size: metaSize,
    font,
    color: TOKENS.neutral600,
  });
  page.drawText(s.parcelNodeId, {
    x: right - font.widthOfTextAtSize(s.parcelNodeId, metaSize),
    y: metaTop - pt(20) - pt(15),
    size: metaSize,
    font,
    color: TOKENS.neutral600,
  });

  const ruleY = y - pt(12);
  drawHairlineRule(page, left, ruleY, right - left);
  return ruleY;
}

interface SummaryRow {
  label: string;
  value: string;
  qualifier?: string;
  accentValue?: boolean;
  chip?: "unavailable" | "fixture";
}

function buildSummaryGroups(model: SitePlanModel): Array<{ heading: string; rows: SummaryRow[] }> {
  const s = model.summary;
  const county = s.countyName ?? (s.countyFips ? `FIPS ${s.countyFips} (county name not on file)` : "not on file");
  const zoning: SummaryRow = s.zoningDistrict
    ? { label: "Zoning district", value: s.zoningDistrict }
    : { label: "Zoning district", value: "", chip: "unavailable", qualifier: s.zoningHonestAbsenceReason ?? "no zoning-fact atom on file" };

  const acres = s.lotAreaSqFt / 43560;
  // Value is the area + %-of-lot (accent); the provisional/honest note becomes
  // the single inline grey qualifier (template rule 7 — never its own row).
  const buildablePct =
    s.buildableAreaSqFt != null && s.lotAreaSqFt > 0 ? ` (${Math.round((s.buildableAreaSqFt / s.lotAreaSqFt) * 100)}% of lot)` : "";
  const buildableValue =
    s.buildableAreaSqFt != null ? `${formatSqFt(s.buildableAreaSqFt)} sq ft${buildablePct}` : "unavailable";
  const buildableQualifier = s.buildableAreaHonestNote ? `PROVISIONAL — ${s.buildableAreaHonestNote}` : undefined;
  const buildableRow: SummaryRow = {
    label: "Buildable area",
    value: buildableValue,
    accentValue: true,
    qualifier: buildableQualifier,
  };

  const flood: SummaryRow =
    "zone" in s.floodZone
      ? {
          label: "Flood zone",
          value: s.floodZone.zone ?? "outside mapped SFHA",
          qualifier: s.floodZone.inSpecialFloodHazardArea ? "in special flood hazard area" : "not in special flood hazard area",
        }
      : { label: "Flood zone", value: "", chip: "unavailable", qualifier: s.floodZone.reason };

  const street: SummaryRow = model.streets.honestAbsence
    ? { label: "Street frontage", value: "", chip: "unavailable", qualifier: model.streets.reason ?? "No road node attaches to this parcel." }
    : { label: "Street frontage", value: model.streets.anchors.map((a) => a.name).join(", ") || "attached" };

  return [
    {
      heading: "PARCEL",
      rows: [
        { label: "Parcel ID", value: s.parcelNodeId },
        { label: "Address", value: s.address ?? "not on file" },
        { label: "County", value: county },
      ],
    },
    {
      heading: "ZONING & BUILDABILITY",
      rows: [
        zoning,
        { label: "Lot area", value: `${formatSqFt(s.lotAreaSqFt)} sq ft`, qualifier: `${acres.toFixed(2)} acres` },
        { label: "Setbacks F / S / R", value: model.setback.displayLine, qualifier: `basis: ${model.setback.basis}` },
        buildableRow,
      ],
    },
    {
      heading: "SITE CONDITIONS",
      rows: [
        {
          label: "Elevation range",
          value: `${s.elevationRangeMeters.min.toFixed(1)} – ${s.elevationRangeMeters.max.toFixed(1)} m`,
          qualifier: s.verticalDatumSummary,
        },
        flood,
        street,
      ],
    },
  ];
}

function drawChip(page: PDFPage, kind: "unavailable" | "fixture", x: number, y: number, bold: PDFFont, font: PDFFont): number {
  const text = kind === "unavailable" ? "UNAVAILABLE" : "FIXTURE LABEL";
  const size = TYPE.chip;
  const padX = pt(7);
  const w = trackedWidth(bold, text, size, TRACKING.chip) + padX * 2;
  const h = size + pt(4);
  if (kind === "unavailable") {
    // Solid ink chip, light text.
    page.drawRectangle({ x, y: y - pt(2), width: w, height: h, color: INK, borderWidth: 0 });
    drawTrackedText(page, text, { x: x + padX, y: y + pt(1), size, font: bold, color: TOKENS.neutral100, trackingEm: TRACKING.chip });
  } else {
    // Outline accent chip.
    page.drawRectangle({ x, y: y - pt(2), width: w, height: h, borderColor: ACCENT, borderWidth: 0.8, color: undefined });
    drawTrackedText(page, text, { x: x + padX, y: y + pt(1), size, font: bold, color: ACCENT, trackingEm: TRACKING.chip });
  }
  return x + w;
}

function drawSummaryTable(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont, startY: number): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const labelColWidth = pt(200);
  const valueX = left + labelColWidth;
  const groups = buildSummaryGroups(model);
  let y = startY - pt(18);

  for (const group of groups) {
    // Group heading — accent, tracked.
    drawTrackedText(page, group.heading, {
      x: left,
      y,
      size: TYPE.groupHeading,
      font: bold,
      color: ACCENT,
      trackingEm: TRACKING.groupHeading,
    });
    y -= pt(14);
    for (const row of group.rows) {
      // Row rule (hairline, top of row).
      page.drawLine({ start: { x: left, y: y + pt(9) }, end: { x: right, y: y + pt(9) }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
      // Label (neutral-600).
      page.drawText(row.label, { x: left, y, size: TYPE.rowLabel, font, color: TOKENS.neutral600 });
      // Value.
      let vx = valueX;
      if (row.chip) {
        vx = drawChip(page, row.chip, vx, y, bold, font) + pt(8);
      }
      if (row.value) {
        page.drawText(row.value, {
          x: vx,
          y,
          size: TYPE.rowValue,
          font,
          color: row.accentValue ? ACCENT_TYPE : INK,
        });
        vx += font.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
      }
      if (row.qualifier) {
        const qSize = pt(11);
        const inlineRoom = right - vx;
        const isLong = row.qualifier.length > 42 || inlineRoom < pt(120);
        if (isLong) {
          // Long note (e.g. the provisional buildable basis): its own wrapped
          // grey block beneath the value, spanning valueX -> right. Never a
          // separate labelled row (template rule 7).
          const qLines = wrapTextToWidth(row.qualifier, font, qSize, right - valueX);
          for (const line of qLines) {
            y -= pt(13);
            page.drawText(line, { x: valueX, y, size: qSize, font, color: TOKENS.neutral600 });
          }
        } else {
          const qText = row.value || row.chip ? `(${row.qualifier})` : row.qualifier;
          const qLines = wrapTextToWidth(qText, font, qSize, Math.max(inlineRoom, pt(80)));
          page.drawText(qLines[0]!, { x: vx, y, size: qSize, font, color: TOKENS.neutral600 });
          for (let li = 1; li < qLines.length; li++) {
            y -= pt(13);
            page.drawText(qLines[li]!, { x: valueX, y, size: qSize, font, color: TOKENS.neutral600 });
          }
        }
      }
      y -= pt(20);
    }
    y -= pt(8);
  }
  return y;
}

function drawProvenanceTable(page: PDFPage, model: SitePlanModel, bold: PDFFont, font: PDFFont, startY: number): void {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  let y = startY - pt(4);
  drawTrackedText(page, "PROVENANCE / CITATIONS", {
    x: left,
    y,
    size: TYPE.groupHeading,
    font: bold,
    color: ACCENT,
    trackingEm: TRACKING.groupHeading,
  });
  y -= pt(16);

  const layerX = left;
  const sourceX = left + pt(150);
  const confX = right - pt(150);
  const headSize = TYPE.tableHead;
  // Head row.
  drawTrackedText(page, "LAYER", { x: layerX, y, size: headSize, font: bold, color: TOKENS.neutral600, trackingEm: TRACKING.tableHead });
  drawTrackedText(page, "SOURCE", { x: sourceX, y, size: headSize, font: bold, color: TOKENS.neutral600, trackingEm: TRACKING.tableHead });
  drawTrackedText(page, "CONFIDENCE", { x: confX, y, size: headSize, font: bold, color: TOKENS.neutral600, trackingEm: TRACKING.tableHead });
  y -= pt(4);
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });
  y -= pt(13);

  const entries = buildProvenancePanelEntries(model);
  const cellSize = TYPE.tableCell;
  for (const entry of entries) {
    // Wrap each cell independently, advance by the tallest.
    const layerLines = wrapTextToWidth(entry.layer, font, cellSize, sourceX - layerX - pt(6));
    const sourceLines = wrapTextToWidth(entry.source, font, cellSize, confX - sourceX - pt(6));
    const confLines = wrapTextToWidth(entry.confidence, font, cellSize, right - confX);
    const rows = Math.max(layerLines.length, sourceLines.length, confLines.length);
    for (let i = 0; i < rows; i++) {
      const ry = y - i * pt(12);
      if (layerLines[i]) page.drawText(layerLines[i]!, { x: layerX, y: ry, size: cellSize, font, color: TOKENS.neutral700 });
      if (sourceLines[i]) page.drawText(sourceLines[i]!, { x: sourceX, y: ry, size: cellSize, font, color: INK });
      if (confLines[i]) page.drawText(confLines[i]!, { x: confX, y: ry, size: cellSize, font, color: TOKENS.neutral600 });
    }
    y -= rows * pt(12) + pt(5);
    page.drawLine({ start: { x: left, y: y + pt(8) }, end: { x: right, y: y + pt(8) }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  }
}

/**
 * Renders the PDF site-plan sheet from the SAME `SitePlanModel` the DXF/IFC
 * emitters read (WDLL 5) — page 1 is the drawing (template card 2a), page 2
 * is the summary + provenance (template card 2b).
 */
export async function emitPdfSitePlan(model: SitePlanModel): Promise<PdfSitePlanResult> {
  const doc = await PDFDocument.create();
  // Barlow substitution: fontkit + TTFs unavailable in this build. Helvetica
  // at template sizing/weight/tracking/colour (see FONT_SUBSTITUTION_NOTE).
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // PAGE 1 — drawing.
  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const headerRuleY = drawPage1Header(page1, model, bold, font);

  // Drawing box: below the header rule, above the footer band.
  const footerBandTop = MARGIN_BOTTOM + pt(8.2 * 1.55 * 3) + pt(52) + pt(6);
  const drawingBox: DrawingBox = {
    x: MARGIN_X,
    y: footerBandTop,
    width: PAGE_WIDTH - MARGIN_X * 2,
    height: headerRuleY - pt(18) - footerBandTop,
  };
  const layout = buildSitePlanDrawingLayout(model, drawingBox, {
    measureText: (text, size) => font.widthOfTextAtSize(text, size),
    // Clamp every label to the printable sheet (minus the outer margins),
    // so a grazing street name / far tag drops instead of drawing off-page.
    sheetBounds: {
      minX: MARGIN_X,
      minY: footerBandTop,
      maxX: PAGE_WIDTH - MARGIN_X,
      maxY: headerRuleY - pt(4),
    },
  });
  drawSitePlanDrawing(page1, layout, font, bold);
  drawPage1Footer(page1, layout, model, font);

  // PAGE 2 — summary.
  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const page2RuleY = drawPage2Header(page2, model, bold, font);
  const afterSummaryY = drawSummaryTable(page2, model, bold, font, page2RuleY);
  drawProvenanceTable(page2, model, bold, font, afterSummaryY);
  drawFinePrint(page2, buildFinePrint(model, 2), font);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount(), fontNote: FONT_SUBSTITUTION_NOTE };
}
