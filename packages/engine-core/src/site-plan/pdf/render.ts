import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fontkit from "@pdf-lib/fontkit";
import { degrees, PDFDocument, PDFFont, PDFPage, type PDFImage, type RGB } from "pdf-lib";

import type { SitePlanModel } from "../site-model.js";
import {
  AERIAL_IMAGERY_ATTRIBUTION,
  AERIAL_NOT_A_SURVEY_LINE,
  AERIAL_UNAVAILABLE_NOTE,
  aerialImagePixelSize,
  aerialPagePointsPerGroundMeter,
  buildAerialExportUrl,
  computeAerialMercatorBbox,
  fetchAerialImagery,
  localEnuToWgs84,
  makeAerialOverlayTransform,
  type AerialImageFetcher,
  type AerialImageryResult,
  type MercatorBbox,
  type PageRect,
} from "./aerial.js";
import { clipPolylineToAabb, feetFromMeters, type PlacedLabel } from "./annotation-placement.js";
import {
  CHIP_FIXTURE_LABEL,
  CHIP_NO_ADDRESS,
  CHIP_UNAVAILABLE,
  REASON,
  countyDisplayName,
  describeSetbackBasis,
  streetDisplayName,
  formatAcresQualifier,
  formatFeetPrime,
  formatMetersRange,
  formatScaleRatio,
  formatSetbacksFSR,
  formatSf,
  formatSqFt,
  sheetReason,
} from "./format.js";
import { buildSitePlanDrawingLayout, type DrawingBox, type PageXY, type SitePlanDrawingLayout } from "./layout.js";
import {
  RhythmCapture,
  fontVerticalMetrics,
  lineBox,
  placeRowBelowRule,
  type FontVerticalMetrics,
  type LineBox,
  type RhythmRow,
} from "./line-box.js";
import { buildProvenancePanelEntries, SITE_PLAN_HONESTY_LINE } from "./provenance.js";
import { PROPERTY_LINE_TAGS_HONESTY } from "../../geometry/gis-property-line-tags.js";
import { LINE_HEIGHT, RASTER_OUTLINE_PT, SETBACK_DASH, SPACE, STROKE, TOKENS, TRACKING, TYPE, pt } from "./template-tokens.js";
import { anyNotSpecified } from "../setback-display.js";

/**
 * Site-plan PDF renderer, reworked 2026-07-28 to the operator's binding
 * SITE PLAN SHEET STANDARD v1.2. The standard is committed alongside this
 * module as `SHEET_STANDARD_v1.html` — twenty-one rules (§1–§21), a token
 * map, the 2026-07-27 defect audit and a 15-item acceptance checklist.
 * Where any other reference and the standard disagree, the standard
 * governs. §21 (v1.1) is the vertical-rhythm rule: every text row against a
 * rule is a metrics-driven line box (line-box.ts), never a bare baseline.
 * v1.2 (2026-07-28): §3 frame clip (context layers confined to the drawing
 * frame; roads label by display name only) and §20 natural-color aerial
 * (duotone tint removed; legibility via paper outlines).
 *
 * Geometry still comes exclusively from the shared `SitePlanModel` (WDLL 5/6);
 * this module maps model geometry to the three Letter sheets: drawing,
 * summary, aerial context.
 *
 * FONT (token map): Barlow (body, OFL) + Barlow Condensed (display, OFL),
 * vendored under packages/engine-core/assets/fonts/ and embedded via
 * @pdf-lib/fontkit. See FONT_NOTE.
 */
export const FONT_NOTE =
  "Rendered with embedded Barlow (Regular/Medium) and Barlow Condensed (Medium/SemiBold), OFL.";
/** @deprecated retained for API compatibility; see FONT_NOTE. */
export const FONT_SUBSTITUTION_NOTE = FONT_NOTE;

// ─────────────────────────────────────────────────────────────────────────
// Vendored Barlow TTFs (OFL). Resolve the assets dir robustly so the same
// code finds the fonts whether this module runs from src (tsx / vitest — the
// engine-api Docker runtime executes `tsx src/index.ts`) or from dist/.
// ─────────────────────────────────────────────────────────────────────────
const FONT_DIR = resolveFontDir();

function resolveFontDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "assets", "fonts");
    try {
      readFileSync(join(candidate, "Barlow-Regular.ttf"));
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `[site-plan] Barlow TTFs not found walking up from ${here}; expected packages/engine-core/assets/fonts/Barlow-Regular.ttf. ` +
      "Ensure the assets dir ships with the module (COPY packages in the engine-api image).",
  );
}

function loadFont(file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FONT_DIR, file)));
}

// ─────────────────────────────────────────────────────────────────────────
// §21 · real vertical metrics per vendored face, read once per process via
// fontkit — the line-box model (line-box.ts) is computed from these, never
// from guessed offsets. All four Barlow faces share upm 1000 / ascent 1000 /
// descent −200 / capHeight 700, but each is still read individually so a
// font swap retunes the rhythm automatically.
// ─────────────────────────────────────────────────────────────────────────
const METRICS: { body: FontVerticalMetrics; bodyMedium: FontVerticalMetrics; display: FontVerticalMetrics; displayMedium: FontVerticalMetrics } = {
  body: fontVerticalMetrics(loadFont("Barlow-Regular.ttf")),
  bodyMedium: fontVerticalMetrics(loadFont("Barlow-Medium.ttf")),
  display: fontVerticalMetrics(loadFont("BarlowCondensed-SemiBold.ttf")),
  displayMedium: fontVerticalMetrics(loadFont("BarlowCondensed-Medium.ttf")),
};

/** §21 line boxes for the recurring sheet roles (PDF points). */
const LB = {
  /** Sheet-2 K/V row: governed by the 13px value at body line-height 1.6. */
  kvRow: lineBox(METRICS.body, TYPE.rowValue, LINE_HEIGHT.body),
  /** Group heading: condensed 10.5px at display line-height 1.1. */
  groupHeading: lineBox(METRICS.display, TYPE.groupHeading, LINE_HEIGHT.display),
  /** Data-table row (segment + provenance): 11px body at 1.6. */
  tableRow: lineBox(METRICS.body, TYPE.tableCell, LINE_HEIGHT.body),
  /** Data-table header row (tracked condensed-medium caps, 11px). */
  tableHead: lineBox(METRICS.displayMedium, TYPE.tableHead, LINE_HEIGHT.display),
  /** Legend row, 11px body at 1.6. */
  legend: lineBox(METRICS.body, TYPE.legend, LINE_HEIGHT.body),
  /** Aerial-sheet legend row, 10px body at 1.6. */
  legendSmall: lineBox(METRICS.body, pt(10), LINE_HEIGHT.body),
  /** Header block lines. */
  eyebrow: lineBox(METRICS.display, TYPE.eyebrow, LINE_HEIGHT.display),
  address: lineBox(METRICS.display, TYPE.address, LINE_HEIGHT.display),
  subline: lineBox(METRICS.body, TYPE.subline, LINE_HEIGHT.body),
  statLabel: lineBox(METRICS.body, TYPE.statLabel, LINE_HEIGHT.display),
  statValue: lineBox(METRICS.display, TYPE.statValue, LINE_HEIGHT.display),
  sheetMeta: lineBox(METRICS.body, TYPE.sheetMeta, LINE_HEIGHT.body),
  /** Imagery-strip cells (§19). */
  stripLabel: lineBox(METRICS.body, TYPE.stripLabel, LINE_HEIGHT.display),
  stripValue: lineBox(METRICS.body, TYPE.stripValue, LINE_HEIGHT.body),
  /** Fine print keeps the template's 1.55. */
  finePrint: lineBox(METRICS.body, TYPE.finePrint, LINE_HEIGHT.finePrint),
} as const;

// US Letter, PDF points (72/in). Standard sheet is 816x1056 px @96dpi (§1).
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
// §1 page margins 48 / 46 / 36 px @96dpi -> points.
const MARGIN_TOP = pt(48);
const MARGIN_X = pt(46);
const MARGIN_BOTTOM = pt(36);

// Token colour aliases (drawing roles, token map).
const INK = TOKENS.text;
const PAPER = TOKENS.neutral100;
const PROPERTY_COLOR = TOKENS.text; // heaviest stroke, full ink (§3)
const ENVELOPE_FILL = TOKENS.accent100;
const SETBACK_DASH_COLOR = TOKENS.accent500;
const SETBACK_LABEL_COLOR = TOKENS.accent700;
const CONTOUR_COLOR = TOKENS.neutral300;
const CONTOUR_LABEL_COLOR = TOKENS.neutral500;
const STREET_COLOR = TOKENS.neutral500;
const DIM_TAG_COLOR = TOKENS.neutral700;
const SUPPRESSED = TOKENS.neutral500;
const ACCENT = TOKENS.accent;
const ACCENT_TYPE = TOKENS.accent700;
const LEADER_COLOR = TOKENS.neutral500;

/** The sheet set is always exactly this size: drawing, summary, aerial context (§1). */
export const TOTAL_SHEETS = 3;

/** Page-space axis-aligned extent of a drawn mark (PDF points). */
export interface MarkBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** §14 draw-once ledger entry: one row per mark actually drawn. */
export interface SheetMark {
  /** Page number within the emitting document. The site plan uses its local
   * 1–3 regardless of dossier renumbering (printed strings renumber; the
   * mark ledger stays in local sheet space so gates keep their meaning). */
  page: number;
  kind: string;
  key: string;
  /**
   * §3 (v1.2) frame-clip gate seam: the page-space AABB of everything this
   * mark draws (polyline points, label boxes incl. leaders, callout text
   * extents). Recorded for every sheet-1 drawing-layer mark; tests assert
   * each bbox sits inside `page1Frame` — no contour, street, label or any
   * other drawing mark may cross the header rule or the furniture band.
   */
  bbox?: MarkBbox;
}

export interface PdfSitePlanResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Names the font actually used (embedded Barlow / Barlow Condensed, OFL). */
  fontNote: string;
  /**
   * Aerial-context page (sheet 3) outcome. The page is ALWAYS emitted; when
   * the bounded imagery fetch fails the page carries the honest treatment
   * (§17: overlay on the paper ground, UNAVAILABLE chip in the imagery strip)
   * and `unavailableReason` says why. Never blocks the export.
   */
  aerial: { imageryEmbedded: boolean; sourceUrl: string; unavailableReason?: string };
  /**
   * §14 draw-once capture seam: every keyed mark drawn, exactly once per
   * (page, kind, key). Tests assert tag/arrow/legend counts here.
   */
  marks: ReadonlyArray<SheetMark>;
  /**
   * §21 rhythm capture seam: one record per rhythm-governed text row (rule
   * y, cap-top y, baseline y, pads, half-leading). The vertical-rhythm gate
   * asserts the line-box invariants numerically against this.
   */
  rhythm: ReadonlyArray<RhythmRow>;
  /**
   * §3 (v1.2) sheet-1 drawing frame: the rect between the header rule and
   * the furniture band that every drawing-layer mark must stay inside. The
   * frame-clip gate asserts each sheet-1 mark bbox against this rect.
   */
  page1Frame: MarkBbox;
}

/**
 * Sheet-numbering seam (dossier append, 2026-07-29): when the 3 site-plan
 * sheets ride inside a larger document (the property dossier), every printed
 * "SHEET N OF TOTAL" — eyebrows and the fine-print trailer — renumbers to the
 * host document's sequence. Marks/rhythm stay in local sheet space (1–3).
 */
export interface SheetNumbering {
  /** Absolute sheet number of the FIRST site-plan sheet in the document. */
  startAt: number;
  /** Total sheet count of the whole document. */
  total: number;
}

export interface EmitPdfSitePlanOptions {
  /** Aerial-context page (sheet 3) imagery seam. Tests MUST stub `fetchImage`
   * so no test hits the network; production uses the default Esri fetcher. */
  aerial?: {
    fetchImage?: AerialImageFetcher;
    timeoutMs?: number;
  };
  /** Renumber printed sheet labels for a host document (dossier append).
   * Default: standalone `{ startAt: 1, total: TOTAL_SHEETS }`. */
  numbering?: SheetNumbering;
}

/** §14: keyed mark registry — a duplicate (page, kind, key) is never drawn twice. */
class MarkRegistry {
  readonly marks: SheetMark[] = [];
  private readonly seen = new Set<string>();

  /** Returns true when the mark is new (caller may draw); false = duplicate, skip.
   * `bbox` (§3 v1.2) records the mark's page-space extent for the frame gate. */
  once(page: number, kind: string, key: string, bbox?: MarkBbox): boolean {
    const id = `${page}:${kind}:${key}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.marks.push(bbox ? { page, kind, key, bbox } : { page, kind, key });
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// §3 (v1.2) bbox helpers for the frame-clip gate.
// ─────────────────────────────────────────────────────────────────────────
function bboxOfPoints(points: ReadonlyArray<PageXY>): MarkBbox | undefined {
  if (points.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function unionBbox(...boxes: Array<MarkBbox | undefined>): MarkBbox | undefined {
  let out: MarkBbox | undefined;
  for (const b of boxes) {
    if (!b) continue;
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : { ...b };
  }
  return out;
}

/** A placed label's extent: its collision box (rotated AABB) plus any leader. */
function labelBbox(label: PlacedLabel): MarkBbox {
  const box: MarkBbox = {
    minX: label.box.x,
    minY: label.box.y,
    maxX: label.box.x + label.box.width,
    maxY: label.box.y + label.box.height,
  };
  return label.leader ? unionBbox(box, bboxOfPoints([label.leader.from, label.leader.to]))! : box;
}

interface Fonts {
  body: PDFFont;
  bodyMedium: PDFFont;
  display: PDFFont; // Barlow Condensed SemiBold (600)
  displayMedium: PDFFont; // Barlow Condensed Medium (500)
}

// ─────────────────────────────────────────────────────────────────────────
// Tracked (letter-spaced) text — kickers / stat labels / group headings carry
// 0.08–0.22em tracking. pdf-lib 1.17 has no characterSpacing option, so
// tracked runs are drawn glyph-by-glyph with an em-based advance.
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

/** Full-width rule (§2: a 1px full-ink rule closes the header). */
function drawHairlineRule(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  color: RGB = INK,
  thickness: number = STROKE.hairlineRule,
): void {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness, color });
}

// ─────────────────────────────────────────────────────────────────────────
// Chips (§6): solid ink UNAVAILABLE · outline FIXTURE LABEL — identical
// wording every time. Returns the x just past the chip.
// ─────────────────────────────────────────────────────────────────────────
function drawChipText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  style: "solid" | "outline",
  F: Fonts,
  size: number = TYPE.chip,
): number {
  const padX = pt(7);
  const w = trackedWidth(F.displayMedium, text, size, TRACKING.chip) + padX * 2;
  const h = size + pt(4);
  if (style === "solid") {
    page.drawRectangle({ x, y: y - pt(2), width: w, height: h, color: INK, borderWidth: 0 });
    drawTrackedText(page, text, {
      x: x + padX,
      y: y + pt(1),
      size,
      font: F.displayMedium,
      color: PAPER,
      trackingEm: TRACKING.chip,
    });
  } else {
    page.drawRectangle({ x, y: y - pt(2), width: w, height: h, borderColor: ACCENT, borderWidth: 0.8, color: undefined });
    drawTrackedText(page, text, {
      x: x + padX,
      y: y + pt(1),
      size,
      font: F.displayMedium,
      color: ACCENT,
      trackingEm: TRACKING.chip,
    });
  }
  return x + w;
}

/**
 * §21: a chip is a BOX, not a baseline run — centre it vertically on the
 * row's line box so it neither crowds the rule above nor sinks below the
 * baseline neighbours. Returns the x just past the chip.
 */
function drawChipOnLineBox(
  page: PDFPage,
  text: string,
  x: number,
  boxTopY: number,
  lb: LineBox,
  style: "solid" | "outline",
  F: Fonts,
  size: number = TYPE.chip,
): number {
  const h = size + pt(4);
  const centerY = boxTopY - lb.lineBoxHeight / 2;
  const chipBaseline = centerY - h / 2 + pt(2);
  return drawChipText(page, text, x, chipBaseline, style, F, size);
}

// ─────────────────────────────────────────────────────────────────────────
// HEADER (§2): kicker → address (condensed 600 uppercase) → one meta line;
// right: stat columns in condensed 600. A 1px full-ink rule closes it.
// No frame, no boxed block, no empty-field placeholders. Vertical placement
// is the §21 line-box stack: 2px gaps between line boxes, space-4 to the
// closing rule.
// ─────────────────────────────────────────────────────────────────────────
interface HeaderStat {
  label: string;
  value?: string;
  chip?: string;
  color?: RGB;
}

function drawHeaderStats(page: PDFPage, stats: HeaderStat[], right: number, boxTop: number, F: Fonts): void {
  const colGap = pt(30);
  const labelBaseline = boxTop - LB.statLabel.baselineFromBoxTop;
  const valueBoxTop = boxTop - LB.statLabel.lineBoxHeight - pt(2);
  const valueBaseline = valueBoxTop - LB.statValue.baselineFromBoxTop;
  const widths = stats.map((st) => {
    const lw = trackedWidth(F.body, st.label, TYPE.statLabel, TRACKING.statLabel);
    const vw = st.chip
      ? trackedWidth(F.displayMedium, st.chip, TYPE.chip, TRACKING.chip) + pt(14)
      : F.display.widthOfTextAtSize(st.value ?? "", TYPE.statValue);
    return Math.max(lw, vw);
  });
  let cx = right;
  for (let i = stats.length - 1; i >= 0; i--) {
    const st = stats[i]!;
    const w = widths[i]!;
    const colLeft = cx - w;
    drawTrackedText(page, st.label, {
      x: colLeft,
      y: labelBaseline,
      size: TYPE.statLabel,
      font: F.body,
      color: TOKENS.neutral600,
      trackingEm: TRACKING.statLabel,
    });
    if (st.chip) {
      drawChipOnLineBox(page, st.chip, colLeft, valueBoxTop, LB.statValue, "solid", F);
    } else {
      page.drawText(st.value ?? "", {
        x: colLeft,
        y: valueBaseline,
        size: TYPE.statValue,
        font: F.display,
        color: st.color ?? INK,
      });
    }
    cx = colLeft - colGap;
  }
}

/** Street portion of an address (before the first comma). Null = no address. */
function streetOnly(address: string | undefined): string | null {
  if (!address) return null;
  const first = address.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function cityFromAddress(address: string | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim());
  if (parts.length >= 3) return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
  if (parts.length === 2) return parts[1]!;
  return null;
}

/**
 * BUILDABLE header stat (§2/§15): the header reads the SAME model value the
 * drawing draws — `summary.buildableAreaSqFt` — or NONE. The old regex
 * fallback that scraped a warm number out of `buildablePdfLabel` is gone
 * (2026-07-28): it printed a warm figure over a drawing that honestly drew
 * nothing. A warm-vs-local discrepancy belongs in the sheet-2 buildable row
 * wording (shared vocab), never in the header.
 */
function buildableHeaderStat(s: SitePlanModel["summary"]): { value: string; none: boolean } {
  if (typeof s.buildableAreaSqFt === "number") {
    return { value: formatSf(s.buildableAreaSqFt), none: false };
  }
  return { value: "NONE", none: true };
}

function drawSheetHeader(
  page: PDFPage,
  model: SitePlanModel,
  F: Fonts,
  eyebrow: string,
  stats: HeaderStat[] | null,
  rightMeta: string[] | null,
): number {
  const s = model.summary;
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const top = PAGE_HEIGHT - MARGIN_TOP; // top of the kicker's line box

  drawTrackedText(page, eyebrow, {
    x: left,
    y: top - LB.eyebrow.baselineFromBoxTop,
    size: TYPE.eyebrow,
    font: F.display,
    color: ACCENT,
    trackingEm: TRACKING.eyebrow,
  });

  // Address, or the parcel id plus a NO ADDRESS chip — never a placeholder (§2).
  const titleBoxTop = top - LB.eyebrow.lineBoxHeight - pt(2);
  const street = streetOnly(s.address);
  const big = (street ?? `PARCEL ${s.parcelNodeId}`).toUpperCase();
  page.drawText(big, {
    x: left,
    y: titleBoxTop - LB.address.baselineFromBoxTop,
    size: TYPE.address,
    font: F.display,
    color: INK,
  });
  if (!street) {
    const bigW = F.display.widthOfTextAtSize(big, TYPE.address);
    drawChipOnLineBox(page, CHIP_NO_ADDRESS, left + bigW + pt(10), titleBoxTop, LB.address, "solid", F);
  }

  // One meta line — only fields that exist (§2: omit absent fields). §11
  // (v1.2): the county appears by NAME only; a FIPS-shaped countyName is
  // omitted entirely — a raw code never prints in the meta line.
  const metaBoxTop = titleBoxTop - LB.address.lineBoxHeight - pt(2);
  const metaParts = [cityFromAddress(s.address), `Parcel ${s.parcelNodeId}`, countyDisplayName(s.countyName)].filter(
    (p): p is string => !!p,
  );
  page.drawText(metaParts.join("  ·  "), {
    x: left,
    y: metaBoxTop - LB.subline.baselineFromBoxTop,
    size: TYPE.subline,
    font: F.body,
    color: TOKENS.neutral700,
  });

  if (stats) {
    drawHeaderStats(page, stats, right, top - pt(6), F);
  }
  if (rightMeta) {
    const metaTop = top - pt(6);
    rightMeta.forEach((line, i) => {
      page.drawText(line, {
        x: right - F.body.widthOfTextAtSize(line, TYPE.sheetMeta),
        y: metaTop - i * LB.sheetMeta.lineBoxHeight - LB.sheetMeta.baselineFromBoxTop,
        size: TYPE.sheetMeta,
        font: F.body,
        color: TOKENS.neutral600,
      });
    });
  }

  const ruleY = headerRuleY();
  drawHairlineRule(page, left, ruleY, right - left);
  return ruleY;
}

/** The header's closing-rule y is deterministic (§21 line-box stack with
 * fixed 2px gaps and a space-4 pad to the rule), so the aerial page can size
 * its imagery rect BEFORE the header is drawn. */
function headerRuleY(): number {
  return (
    PAGE_HEIGHT -
    MARGIN_TOP -
    LB.eyebrow.lineBoxHeight -
    pt(2) -
    LB.address.lineBoxHeight -
    pt(2) -
    LB.subline.lineBoxHeight -
    pt(SPACE.s4)
  );
}

function page1HeaderStats(model: SitePlanModel): HeaderStat[] {
  const s = model.summary;
  const buildable = buildableHeaderStat(s);
  const stats: HeaderStat[] = [
    { label: "LOT", value: formatSf(s.lotAreaSqFt) },
    {
      label: "BUILDABLE",
      value: buildable.value,
      color: buildable.none ? SUPPRESSED : ACCENT_TYPE,
    },
  ];
  if (s.zoningDistrict) {
    stats.push({ label: "ZONING", value: s.zoningDistrict.toUpperCase() });
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────
// DRAWING (§3): contour → contour labels → envelope fill → setback dash →
// property line → dimension tags → sheet furniture. Property line heaviest.
// Every mark keyed through the §14 registry.
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
    ...(label.rotationDeg ? { rotate: degrees(label.rotationDeg) } : {}),
  });
}

/** North arrow (§9): filled triangle over a condensed "N", no compass rose. */
function drawNorthArrow(page: PDFPage, north: { origin: PageXY; tip: PageXY }, display: PDFFont): void {
  const { origin, tip } = north;
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

  page.drawLine({ start: origin, end: notch, thickness: 1, color: INK });
  const path =
    `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} ` +
    `L ${leftPt.x.toFixed(2)} ${leftPt.y.toFixed(2)} ` +
    `L ${notch.x.toFixed(2)} ${notch.y.toFixed(2)} ` +
    `L ${rightPt.x.toFixed(2)} ${rightPt.y.toFixed(2)} Z`;
  page.drawSvgPath(path, { color: INK, borderWidth: 0 });
  const nSize = pt(11);
  page.drawText("N", {
    x: tip.x - display.widthOfTextAtSize("N", nSize) / 2,
    y: tip.y + pt(6),
    size: nSize,
    font: display,
    color: INK,
  });
}

function drawSitePlanDrawing(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  F: Fonts,
  marks: MarkRegistry,
): void {
  // 1) CONTOUR — faint, behind everything (§3).
  layout.contours.forEach((contour, i) => {
    if (!marks.once(1, "contour", `${contour.elevation}:${i}`, bboxOfPoints(contour.points))) return;
    drawPolyline(page, contour.points, CONTOUR_COLOR, STROKE.contour);
  });

  // 2) CONTOUR LABELS — left margin (§4).
  for (const label of layout.elevationLabels) {
    if (!marks.once(1, "contour-label", label.text, labelBbox(label))) continue;
    drawPlacedLabel(page, label, F.body, CONTOUR_LABEL_COLOR);
  }

  // 3) STREET (context, beneath the parcel linework). §11 (v1.2): the label
  // (when present) is the display name alone — unnamed roads draw unlabeled.
  if (!layout.streets.honestAbsence) {
    layout.streets.anchors.forEach((anchor, i) => {
      const streetBbox = unionBbox(
        bboxOfPoints(anchor.points),
        anchor.leftEdge ? bboxOfPoints(anchor.leftEdge) : undefined,
        anchor.rightEdge ? bboxOfPoints(anchor.rightEdge) : undefined,
        anchor.label ? labelBbox(anchor.label) : undefined,
      );
      if (!marks.once(1, "street", `${anchor.name}:${i}`, streetBbox)) return;
      if (anchor.leftEdge && anchor.leftEdge.length >= 2)
        drawPolyline(page, anchor.leftEdge, TOKENS.neutral400, 0.5, [1.4, 1.1]);
      if (anchor.rightEdge && anchor.rightEdge.length >= 2)
        drawPolyline(page, anchor.rightEdge, TOKENS.neutral400, 0.5, [1.4, 1.1]);
      drawPolyline(page, anchor.points, STREET_COLOR, 0.9, [3.4, 2.3]);
      // Street name rides a paper halo (§20 paint-order) so it stays legible
      // over its own dashed centerline / contours.
      if (anchor.label) {
        if (anchor.label.leader) {
          page.drawLine({
            start: anchor.label.leader.from,
            end: anchor.label.leader.to,
            thickness: 0.4,
            color: LEADER_COLOR,
          });
        }
        drawHaloedText(page, anchor.label.text, {
          x: anchor.label.drawAt.x,
          y: anchor.label.drawAt.y,
          size: anchor.label.fontSize,
          font: F.body,
          color: TOKENS.neutral600,
          rotationDeg: anchor.label.rotationDeg,
        });
      }
    });
  }

  // 4+5) BUILDABLE ENVELOPE fill + SETBACK dash — only when honestly drawable
  // (§15: a degenerate or honest-absent offset draws NOTHING envelope-shaped).
  if (layout.setback.drawEnvelope && layout.setback.offsetRing) {
    const envBbox = bboxOfPoints(layout.setback.offsetRing);
    if (marks.once(1, "envelope-fill", "envelope", envBbox)) {
      drawFilledRing(page, layout.setback.offsetRing, ENVELOPE_FILL);
    }
    if (marks.once(1, "setback-dash", "envelope", envBbox)) {
      drawRing(page, layout.setback.offsetRing, SETBACK_DASH_COLOR, STROKE.setbackDash, SETBACK_DASH);
    }
  }

  // 6) PROPERTY LINE — heaviest stroke on the sheet (§3).
  if (marks.once(1, "property-line", "ring", bboxOfPoints(layout.propertyLine))) {
    drawRing(page, layout.propertyLine, PROPERTY_COLOR, STROKE.property);
  }

  // 7) DIMENSION TAGS — one per segment, keyed by segment id (§14).
  for (const tag of layout.propertyLineTags) {
    if (!marks.once(1, "tag", `S${tag.seg ?? tag.text}`, labelBbox(tag))) continue;
    drawPlacedLabel(page, tag, F.body, DIM_TAG_COLOR);
  }

  // 7b) MARGIN LEADERS (§16) — 0.13-unit neutral-500, keyed by segment.
  for (const leader of layout.segmentLeaders) {
    const leaderBbox = unionBbox(bboxOfPoints([leader.from, leader.to]), labelBbox(leader.label));
    if (!marks.once(1, "margin-leader", `S${leader.seg}`, leaderBbox)) continue;
    page.drawLine({ start: leader.from, end: leader.to, thickness: STROKE.marginLeader, color: LEADER_COLOR });
    drawPlacedLabel(page, leader.label, F.body, DIM_TAG_COLOR);
  }

  // 8) SETBACK role labels (accent-700; §4 collapse rules applied upstream).
  for (const label of layout.setback.labels) {
    if (!marks.once(1, "setback-label", label.text, labelBbox(label))) continue;
    drawPlacedLabel(page, label, F.body, SETBACK_LABEL_COLOR);
  }

  // 9) Centred callout: BUILDABLE ENVELOPE (§9/§12) or the §15 degenerate
  // statement — title over ONE plain sentence, nothing else on the drawing.
  if (layout.degenerateCallout) {
    const c0 = layout.degenerateCallout;
    const degW = Math.max(
      F.display.widthOfTextAtSize(c0.title, c0.titleSize),
      F.body.widthOfTextAtSize(c0.sentence, c0.sentenceSize),
    );
    const degBbox: MarkBbox = {
      minX: c0.anchor.x - degW / 2,
      maxX: c0.anchor.x + degW / 2,
      minY: c0.anchor.y - c0.titleSize - pt(3) - c0.sentenceSize * 0.25,
      maxY: c0.anchor.y + c0.titleSize,
    };
    if (marks.once(1, "degenerate-callout", "callout", degBbox)) {
      const c = c0;
      page.drawText(c.title, {
        x: c.anchor.x - F.display.widthOfTextAtSize(c.title, c.titleSize) / 2,
        y: c.anchor.y,
        size: c.titleSize,
        font: F.display,
        color: INK,
      });
      page.drawText(c.sentence, {
        x: c.anchor.x - F.body.widthOfTextAtSize(c.sentence, c.sentenceSize) / 2,
        y: c.anchor.y - c.titleSize - pt(3),
        size: c.sentenceSize,
        font: F.body,
        color: TOKENS.neutral600,
      });
    }
  } else if (layout.envelopeCallout) {
    const c1 = layout.envelopeCallout;
    const envTitle = "BUILDABLE ENVELOPE";
    const envW = Math.max(
      F.display.widthOfTextAtSize(envTitle, c1.titleSize),
      c1.qualifier ? F.body.widthOfTextAtSize(c1.qualifier, c1.qualifierSize) : 0,
    );
    const envCalloutBbox: MarkBbox = {
      minX: c1.anchor.x - envW / 2,
      maxX: c1.anchor.x + envW / 2,
      minY: c1.anchor.y - c1.titleSize - pt(2) - c1.qualifierSize * 0.25,
      maxY: c1.anchor.y + c1.titleSize,
    };
    if (marks.once(1, "envelope-callout", "callout", envCalloutBbox)) {
      const c = c1;
      const title = envTitle;
      page.drawText(title, {
        x: c.anchor.x - F.display.widthOfTextAtSize(title, c.titleSize) / 2,
        y: c.anchor.y,
        size: c.titleSize,
        font: F.display,
        color: INK,
      });
      if (c.qualifier) {
        page.drawText(c.qualifier, {
          x: c.anchor.x - F.body.widthOfTextAtSize(c.qualifier, c.qualifierSize) / 2,
          y: c.anchor.y - c.titleSize - pt(2),
          size: c.qualifierSize,
          font: F.body,
          color: TOKENS.neutral600,
        });
      }
    }
  } else if (layout.lotAreaCallout) {
    if (marks.once(1, "lot-area-callout", "callout", labelBbox(layout.lotAreaCallout))) {
      drawPlacedLabel(page, layout.lotAreaCallout, F.body, TOKENS.neutral600);
    }
  }

  // 10) NORTH arrow — exactly one (§9/§14). Bbox covers shaft, head, and the
  // "N" glyph above the tip (see drawNorthArrow geometry).
  {
    const { origin, tip } = layout.north;
    const len = Math.hypot(tip.x - origin.x, tip.y - origin.y) || 1;
    const headHalf = Math.min(11, len * 0.4) * 0.5;
    const nSize = pt(11);
    const northBbox = unionBbox(bboxOfPoints([origin, tip]), {
      minX: tip.x - Math.max(headHalf, nSize / 2),
      maxX: tip.x + Math.max(headHalf, nSize / 2),
      minY: tip.y - Math.min(11, len * 0.4),
      maxY: tip.y + pt(6) + nSize,
    });
    if (marks.once(1, "north-arrow", "north", northBbox)) {
      drawNorthArrow(page, layout.north, F.display);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// LEGEND (§5): every layer, fixed order, populated or not. Empty layers grey
// to neutral-500 with the reason INLINE on the same row.
// ─────────────────────────────────────────────────────────────────────────
interface LegendRow {
  label: string;
  swatch: "line-heavy" | "envelope" | "line-dashed" | "line-thin" | "line-dotted" | "leader";
  color: RGB;
  empty?: boolean;
}

function legendRows(layout: SitePlanDrawingLayout, model: SitePlanModel, sheet2No: number): LegendRow[] {
  const rows: LegendRow[] = [{ label: "Property line", swatch: "line-heavy", color: PROPERTY_COLOR }];

  if (layout.setback.drawEnvelope) {
    rows.push({ label: "Buildable envelope", swatch: "envelope", color: ACCENT });
    rows.push({ label: "Setback line", swatch: "line-dashed", color: SETBACK_DASH_COLOR });
  } else if (layout.setback.degenerate) {
    rows.push({
      label: "Buildable envelope — none drawn · setbacks exceed the lot",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
    rows.push({
      label: "Setback line — not drawn · no offset survives",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
  } else if (layout.setback.frontEdgeUnresolved) {
    rows.push({
      label: "Buildable envelope — not drawn · front edge unresolved",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
    rows.push({
      label: "Setback line — not drawn · front edge unresolved",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
  } else {
    rows.push({
      label: "Buildable envelope — not drawn · no setback rule on file",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
    rows.push({
      label: "Setback line — not drawn · no setback rule on file",
      swatch: "line-dashed",
      color: SUPPRESSED,
      empty: true,
    });
  }

  rows.push(
    layout.contours.length > 0
      ? { label: `Contour, ${model.contourIntervalMeters} m interval`, swatch: "line-thin", color: CONTOUR_COLOR }
      : { label: "Contour — layer empty · no elevation data", swatch: "line-thin", color: SUPPRESSED, empty: true },
  );

  rows.push(
    layout.streets.honestAbsence
      ? { label: "Street — layer empty · no road node attaches", swatch: "line-dotted", color: SUPPRESSED, empty: true }
      : {
          label: layout.streets.anchors.some((a) => a.leftEdge || a.rightEdge)
            ? "Street centerline & ROW edges"
            : "Street centerline",
          swatch: "line-dashed",
          color: STREET_COLOR,
        },
  );

  if (layout.segmentLeaders.length > 0) {
    rows.push({ label: `Margin leader · segment keyed to sheet ${sheet2No}`, swatch: "leader", color: LEADER_COLOR });
  }
  return rows;
}

function drawLegendSwatch(page: PDFPage, row: LegendRow, x: number, y: number): void {
  const w = pt(24);
  if (row.swatch === "envelope") {
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
  if (row.swatch === "line-dashed") {
    page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: 0.8, color: row.color, dashArray: [2.2, 1.6] });
    return;
  }
  if (row.swatch === "leader") {
    page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: STROKE.marginLeader, color: row.color });
    return;
  }
  const thick = row.swatch === "line-heavy" ? 1.4 : 0.7;
  page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: thick, color: row.color });
}

function drawLegend(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  model: SitePlanModel,
  F: Fonts,
  ruleY: number,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  numbering?: SheetNumbering,
): void {
  if (!marks.once(1, "legend", "legend")) return;
  const left = MARGIN_X;
  const rows = legendRows(layout, model, sheetLabel(2, numbering).no);
  const size = TYPE.legend;
  // §21: rows hang from the footer rule — space-2 pad, then line boxes on a
  // uniform pitch (line box + space-2 row gap).
  const pitch = LB.legend.lineBoxHeight + pt(SPACE.s2);
  // Column-major fill (fixed §5 order, read down then across) with a measured
  // first-column width so long inline reasons never collide with the scale bar.
  const perCol = Math.ceil(rows.length / 2);
  const swatchBand = pt(24) + pt(9);
  const col1Width =
    Math.max(...rows.slice(0, perCol).map((r) => F.body.widthOfTextAtSize(r.label, size))) + swatchBand;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const col = Math.floor(i / perCol);
    const line = i % perCol;
    const x = col === 0 ? left : left + col1Width + pt(18);
    const boxTop = ruleY - pt(SPACE.s2) - line * pitch;
    const y = boxTop - LB.legend.baselineFromBoxTop;
    drawLegendSwatch(page, row, x, y);
    page.drawText(row.label, {
      x: x + swatchBand,
      y,
      size,
      font: F.body,
      color: row.empty ? SUPPRESSED : TOKENS.neutral800,
    });
    if (col === 0) {
      const placed = placeRowBelowRule(ruleY - line * pitch, LB.legend, {
        padTop: pt(SPACE.s2),
        padBottom: pt(SPACE.s2),
      });
      rhythm.row(1, "legend-row", placed, LB.legend, pt(SPACE.s2), { ruleDrawn: line === 0 });
    }
  }
}

/** §21 footer geometry, page 1: worst-case legend depth (4 rows per column)
 * reserved above the fine-print band — the drawing box never overlaps the
 * legend even when the margin-leader row appears. */
function page1FooterRuleY(): number {
  const finePrintBandTop = MARGIN_BOTTOM + LB.finePrint.lineBoxHeight * 4;
  const legendBlock = pt(SPACE.s2) + 4 * LB.legend.lineBoxHeight + 3 * pt(SPACE.s2);
  return finePrintBandTop + pt(SPACE.s3) + legendBlock;
}

/**
 * Graphic scale bar (§9): three segments, three labels, unit on the LAST one
 * (0 · 33 · 66 ft — never the unit on its own line). Beneath it: scale ratio
 * with a prime (§12), sheet id, generated stamp.
 */
function drawScaleBar(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  model: SitePlanModel,
  F: Fonts,
  baselineY: number,
  marks: MarkRegistry,
): void {
  if (!marks.once(1, "scale-bar", "scale")) return;
  const right = PAGE_WIDTH - MARGIN_X;
  const lengthFeet = feetFromMeters(layout.scaleBar.lengthMeters);
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
  const labelSize = TYPE.scaleBarLabel;
  const labelY = barTop - pt(11);
  const zero = "0";
  const midLabel = `${Math.round(lengthFeet / 2)}`;
  const maxLabel = `${Math.round(lengthFeet)} ft`;
  page.drawText(zero, { x: barLeft, y: labelY, size: labelSize, font: F.body, color: TOKENS.neutral700 });
  page.drawText(midLabel, {
    x: barLeft + barWidth / 2 - F.body.widthOfTextAtSize(midLabel, labelSize) / 2,
    y: labelY,
    size: labelSize,
    font: F.body,
    color: TOKENS.neutral700,
  });
  page.drawText(maxLabel, {
    x: right - F.body.widthOfTextAtSize(maxLabel, labelSize),
    y: labelY,
    size: labelSize,
    font: F.body,
    color: TOKENS.neutral700,
  });

  // Scale ratio (§12 prime form) · sheet-id · generated stamp.
  const scaleRatio =
    layout.transform.scale > 0
      ? formatScaleRatio(Math.round(feetFromMeters(72 / layout.transform.scale)))
      : "";
  const sheetId = `SP-${model.parcelNodeId.replace(/:/g, "-")}`;
  const stamp = `generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
  const metaLine = [scaleRatio, sheetId, stamp].filter(Boolean).join(" · ");
  const metaSize = TYPE.scaleRatioLine;
  page.drawText(metaLine, {
    x: right - F.body.widthOfTextAtSize(metaLine, metaSize),
    y: labelY - pt(13),
    size: metaSize,
    font: F.body,
    color: TOKENS.neutral600,
  });
}

/** Greedy word-wrap so fine-print paragraphs stay on the sheet (§13: wrap, never clip). */
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

// ─────────────────────────────────────────────────────────────────────────
// FINE PRINT (§8): one consolidated paragraph per page — the four standing
// disclaimers plus conditional disclosures (honest absence, fixture, moved
// tags, imagery age). No callout boxes on the drawing.
// ─────────────────────────────────────────────────────────────────────────
function joinSegList(segs: string[]): string {
  if (segs.length === 0) return "";
  if (segs.length === 1) return segs[0]!;
  return `${segs.slice(0, -1).join(", ")} and ${segs[segs.length - 1]!}`;
}

interface FinePrintContext {
  movedSegs: string[];
  registrationSentence?: string;
  imagery?: AerialImageryResult;
  imageryAgeMonths?: number | null;
  /** Dossier renumbering: the printed sheet label for this page. Defaults to
   * the standalone `Sheet {page} of TOTAL_SHEETS`. */
  numbering?: SheetNumbering;
}

/** Printed sheet label under (optional) host-document renumbering. */
function sheetLabel(localPage: 1 | 2 | 3, numbering?: SheetNumbering): { no: number; total: number } {
  const n = numbering ?? { startAt: 1, total: TOTAL_SHEETS };
  return { no: n.startAt + localPage - 1, total: n.total };
}

function buildFinePrint(model: SitePlanModel, page: 1 | 2 | 3, ctx: FinePrintContext): string {
  const sentences: string[] = [];
  const label = sheetLabel(page, ctx.numbering);
  if (page === 3) {
    const s1 = sheetLabel(1, ctx.numbering).no;
    sentences.push(SITE_PLAN_HONESTY_LINE);
    sentences.push(
      "Aerial imagery is an illustrative backdrop, not a measurement source.",
      `All dimensions, areas and setbacks come from the parcel geometry on sheet ${s1}; where the imagery and the overlay disagree, sheet ${s1} governs.`,
    );
    if (ctx.registrationSentence) sentences.push(ctx.registrationSentence);
    sentences.push(AERIAL_NOT_A_SURVEY_LINE);
    if (ctx.imagery && !ctx.imagery.ok) {
      sentences.push(`${AERIAL_UNAVAILABLE_NOTE}: ${ctx.imagery.reason}. Site geometry is on sheet ${s1}.`);
    }
    if (typeof ctx.imageryAgeMonths === "number" && ctx.imageryAgeMonths > 24) {
      sentences.push(
        `Imagery is about ${Math.round(ctx.imageryAgeMonths)} months old — structures, vegetation and surfacing may have changed.`,
      );
    }
    sentences.push(AERIAL_IMAGERY_ATTRIBUTION);
    sentences.push(`· Sheet ${label.no} of ${label.total}`);
    return sentences.join(" ");
  }

  sentences.push(SITE_PLAN_HONESTY_LINE, PROPERTY_LINE_TAGS_HONESTY);
  if (ctx.movedSegs.length > 0) {
    const s1 = sheetLabel(1, ctx.numbering).no;
    const s2 = sheetLabel(2, ctx.numbering).no;
    sentences.push(
      `Tags for segments ${joinSegList(ctx.movedSegs)} were shortened, moved or dropped on sheet ${s1} and are tabulated in the sheet-${s2} segment table.`,
    );
  }
  if (page === 1) {
    if (model.streets.honestAbsence) {
      sentences.push("Street layer intentionally left empty — no road node attaches to this parcel.");
    }
    if (/synthetic|fixture|sample/i.test(model.citations.contour)) {
      sentences.push("Elevation from a synthetic DEM on this sample.");
    }
  }
  if (model.summary.zoningFixture) {
    sentences.push("Zoning district shown is a fixture label — confirm against live zoning-fact on planner QA.");
  }
  if (page === 2 && model.summary.buildableAreaHonestNote && model.summary.buildableAreaSqFt != null) {
    sentences.push(
      "Buildable area is provisional pending front-edge resolution; treat it as a planning estimate, not a permit-ready boundary.",
    );
  }
  sentences.push(`· Sheet ${label.no} of ${label.total}`);
  return sentences.join(" ");
}

function drawFinePrint(page: PDFPage, pageNo: number, text: string, F: Fonts, marks: MarkRegistry): void {
  if (!marks.once(pageNo, "fine-print", "paragraph")) return;
  const left = MARGIN_X;
  const size = TYPE.finePrint;
  const maxWidth = PAGE_WIDTH - MARGIN_X * 2;
  const lines = wrapTextToWidth(text, F.body, size, maxWidth);
  let y = MARGIN_BOTTOM + (lines.length - 1) * LB.finePrint.lineBoxHeight - pt(2);
  for (const line of lines) {
    page.drawText(line, { x: left, y, size, font: F.body, color: TOKENS.neutral600 });
    y -= LB.finePrint.lineBoxHeight;
  }
}

function drawPage1Footer(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  model: SitePlanModel,
  F: Fonts,
  marks: MarkRegistry,
  finePrint: string,
  rhythm: RhythmCapture,
  numbering?: SheetNumbering,
): void {
  const ruleY = page1FooterRuleY();
  drawHairlineRule(page, MARGIN_X, ruleY, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);

  drawLegend(page, layout, model, F, ruleY, marks, rhythm, numbering);
  drawScaleBar(page, layout, model, F, ruleY - pt(8), marks);

  drawFinePrint(page, 1, finePrint, F, marks);
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE 2 — SUMMARY (§7): two-column key/value grid on a 200px label column,
// hairline rule per row, three groups; §16 segment table; three-column
// provenance table; fine print.
// ─────────────────────────────────────────────────────────────────────────
interface SummaryRow {
  label: string;
  value?: string;
  qualifier?: string;
  accentValue?: boolean;
  chip?: "unavailable" | "fixture";
  /** Chip reason sentence (§6) — drawn beside the chip. */
  chipReason?: string;
}

function buildSummaryGroups(model: SitePlanModel): Array<{ heading: string; rows: SummaryRow[] }> {
  const s = model.summary;

  const address: SummaryRow = s.address
    ? { label: "Address", value: s.address }
    : { label: "Address", chip: "unavailable", chipReason: REASON.noAddress };

  // §11 (v1.2): FIPS-shaped countyName is NOT a county name — the row takes
  // the honest chip rather than printing a raw code.
  const countyName = countyDisplayName(s.countyName);
  const county: SummaryRow = countyName
    ? { label: "County", value: countyName }
    : { label: "County", chip: "unavailable", chipReason: REASON.noCountyName };

  const zoning: SummaryRow = s.zoningDistrict
    ? s.zoningFixture
      ? { label: "Zoning district", value: s.zoningDistrict, chip: "fixture" }
      : { label: "Zoning district", value: s.zoningDistrict }
    : {
        label: "Zoning district",
        chip: "unavailable",
        chipReason: sheetReason(s.zoningHonestAbsenceReason, REASON.noZoning),
      };

  // §7/§11 one-qualifier rule: the value cell carries ONLY the three axis
  // states. When an axis is code-silent, "build-to-line governs" IS the one
  // grey qualifier; the front-edge basis moves to the provenance SOURCE
  // column (see buildProvenancePanelEntries). Otherwise the basis stays the
  // single qualifier.
  const setbacksNotSpecified = anyNotSpecified(model.setback.notSpecified);
  const setbacks: SummaryRow = model.setback.honestAbsence
    ? { label: "Setbacks F / S / R", chip: "unavailable", chipReason: REASON.noSetbackRule }
    : {
        label: "Setbacks F / S / R",
        value: setbacksNotSpecified
          ? model.setback.displayLine.replace(/\s*—\s*build-to-line governs\s*$/, "")
          : formatSetbacksFSR(model.setback.front, model.setback.side, model.setback.rear),
        qualifier: setbacksNotSpecified ? "build-to-line governs" : describeSetbackBasis(model.setback.basis),
      };

  const provisional = s.buildableAreaHonestNote != null && s.buildableAreaSqFt != null;
  const pct =
    s.buildableAreaSqFt != null && s.lotAreaSqFt > 0
      ? Math.round((s.buildableAreaSqFt / s.lotAreaSqFt) * 100)
      : null;
  const buildable: SummaryRow =
    s.buildableAreaSqFt != null
      ? {
          label: "Buildable area",
          value: formatSqFt(s.buildableAreaSqFt),
          accentValue: true,
          qualifier: provisional
            ? `provisional planning estimate${pct != null ? ` · ${pct}% of lot` : ""}`
            : pct != null
              ? `(${pct}% of lot)`
              : undefined,
        }
      : model.setback.frontEdgeUnresolved
        ? {
            label: "Buildable area",
            chip: "unavailable",
            // Warm-vs-local discrepancies live in THIS row's wording (shared
            // vocab), never in the header stat — the header reads the model
            // value or NONE (§2/§15).
            chipReason:
              s.buildableDisplayKind === "provisional"
                ? "Front edge unresolved; a provisional warm estimate is on file."
                : REASON.frontEdgeUnresolved,
          }
        : { label: "Buildable area", chip: "unavailable", chipReason: REASON.setbacksConsumeLot };

  const flood: SummaryRow =
    "zone" in s.floodZone
      ? {
          label: "Flood zone",
          value: s.floodZone.zone ?? "outside mapped SFHA",
          qualifier: s.floodZone.inSpecialFloodHazardArea
            ? "in special flood hazard area"
            : "not in special flood hazard area",
        }
      : {
          label: "Flood zone",
          chip: "unavailable",
          chipReason: sheetReason(s.floodZone.reason, REASON.floodNotQueried),
        };

  // §11 (v1.2): the frontage row reads display names only — machine
  // road-node ids never print; an unnamed attaching road reads "unnamed road".
  const streetHasEdges = model.streets.anchors.some((a) => a.leftEdgeLocal || a.rightEdgeLocal);
  const streetNames = model.streets.anchors
    .map((a) => streetDisplayName(a.name))
    .filter((n): n is string => !!n);
  const street: SummaryRow = model.streets.honestAbsence
    ? { label: "Street frontage", chip: "unavailable", chipReason: REASON.noStreet }
    : {
        label: "Street frontage",
        value: [...new Set(streetNames)].join(", ") || "unnamed road",
        qualifier: streetHasEdges ? "centerline accurate, ROW edges assumed" : "centerline accurate",
      };

  return [
    {
      heading: "PARCEL",
      rows: [{ label: "Parcel ID", value: s.parcelNodeId }, address, county],
    },
    {
      heading: "ZONING & BUILDABILITY",
      rows: [
        zoning,
        { label: "Lot area", value: formatSqFt(s.lotAreaSqFt), qualifier: formatAcresQualifier(s.lotAreaSqFt) },
        setbacks,
        buildable,
      ],
    },
    {
      heading: "SITE CONDITIONS",
      rows: [
        {
          label: "Elevation range",
          value: formatMetersRange(s.elevationRangeMeters.min, s.elevationRangeMeters.max),
          qualifier: "NAVD88 orthometric (USGS 3DEP)",
        },
        flood,
        street,
      ],
    },
  ];
}

/**
 * §21 · section heading: the heading's line box hangs space-6 below the
 * previous block's bottom boundary and sits space-2 above its first row's
 * rule — closer to its own rows than to the section above (proximity rule).
 * Returns the y where the group's first rule goes.
 */
function drawSectionHeading(
  page: PDFPage,
  pageNo: number,
  text: string,
  prevBottomY: number,
  F: Fonts,
  rhythm: RhythmCapture,
): number {
  const boxTop = prevBottomY - pt(SPACE.s6);
  drawTrackedText(page, text, {
    x: MARGIN_X,
    y: boxTop - LB.groupHeading.baselineFromBoxTop,
    size: TYPE.groupHeading,
    font: F.display,
    color: ACCENT,
    trackingEm: TRACKING.groupHeading,
  });
  const placed = placeRowBelowRule(prevBottomY, LB.groupHeading, {
    padTop: pt(SPACE.s6),
    padBottom: pt(SPACE.s2),
  });
  rhythm.row(pageNo, "group-heading", placed, LB.groupHeading, pt(SPACE.s6), { ruleDrawn: false });
  return placed.nextRuleY;
}

function drawSummaryTable(
  page: PDFPage,
  model: SitePlanModel,
  F: Fonts,
  headerRule: number,
  rhythm: RhythmCapture,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const labelColWidth = pt(200);
  const valueX = left + labelColWidth;
  const groups = buildSummaryGroups(model);
  const padRow = pt(SPACE.s2);
  let bottom = headerRule;

  for (const group of groups) {
    let ruleY = drawSectionHeading(page, 2, group.heading, bottom, F, rhythm);
    group.rows.forEach((row, ri) => {
      // Pre-compose the trailing grey text (chip reason or qualifier) so the
      // row's line count — and therefore its box — is known before drawing.
      let vx = valueX;
      const chipPadX = pt(7);
      if (row.chip === "unavailable") {
        vx += trackedWidth(F.displayMedium, CHIP_UNAVAILABLE, TYPE.chip, TRACKING.chip) + chipPadX * 2 + pt(8);
      }
      if (row.value) {
        vx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
      }
      if (row.chip === "fixture") {
        vx += trackedWidth(F.displayMedium, CHIP_FIXTURE_LABEL, TYPE.chip, TRACKING.chip) + chipPadX * 2 + pt(8);
      }
      const grey = row.chipReason ?? row.qualifier;
      const greySize = row.chipReason ? pt(12) : TYPE.rowQualifier;
      const greyColor = row.chipReason ? TOKENS.neutral700 : TOKENS.neutral600;
      const greyLines = grey
        ? wrapTextToWidth(grey, F.body, greySize, Math.max(right - vx, row.chipReason ? pt(120) : pt(90)))
        : [];
      const lines = Math.max(1, greyLines.length);

      const placed = placeRowBelowRule(ruleY, LB.kvRow, { padTop: padRow, padBottom: padRow, lines });
      // Rule above: neutral-300 opens a group, neutral-200 within it (§7/§21).
      page.drawLine({
        start: { x: left, y: ruleY },
        end: { x: right, y: ruleY },
        thickness: STROKE.rowRule,
        color: ri === 0 ? TOKENS.neutral300 : TOKENS.neutral200,
      });
      const baseline = placed.baselines[0]!;
      page.drawText(row.label, { x: left, y: baseline, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
      let dx = valueX;
      if (row.chip === "unavailable") {
        dx = drawChipOnLineBox(page, CHIP_UNAVAILABLE, dx, placed.boxTopY, LB.kvRow, "solid", F) + pt(8);
      }
      if (row.value) {
        page.drawText(row.value, {
          x: dx,
          y: baseline,
          size: TYPE.rowValue,
          font: row.accentValue ? F.bodyMedium : F.body,
          color: row.accentValue ? ACCENT_TYPE : INK,
        });
        dx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
      }
      if (row.chip === "fixture") {
        dx = drawChipOnLineBox(page, CHIP_FIXTURE_LABEL, dx, placed.boxTopY, LB.kvRow, "outline", F) + pt(8);
      }
      greyLines.forEach((line, li) => {
        page.drawText(line, {
          x: li === 0 ? dx : valueX,
          y: placed.baselines[li]!,
          size: greySize,
          font: F.body,
          color: greyColor,
        });
      });
      rhythm.row(2, "kv-row", placed, LB.kvRow, padRow);
      ruleY = placed.nextRuleY;
    });
    bottom = ruleY;
  }
  // One closing rule ends the grid (mock: final border-top row).
  page.drawLine({
    start: { x: left, y: bottom },
    end: { x: right, y: bottom },
    thickness: STROKE.rowRule,
    color: TOKENS.neutral200,
  });
  return bottom;
}

/** §16 segment table — full bearing, distance, and sheet-1 disposition.
 * §21 row model at table density: 11px cells at body 1.6, space-1 pads. */
function drawSegmentTable(
  page: PDFPage,
  layout: SitePlanDrawingLayout,
  F: Fonts,
  startY: number,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  numbering?: SheetNumbering,
): number {
  if (layout.segmentTable.length === 0) return startY;
  if (!marks.once(2, "segment-table", "table")) return startY;
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const padCell = pt(SPACE.s1);
  const headRuleY = drawSectionHeading(page, 2, "SEGMENT TABLE — TAGS MOVED OFF THE DRAWING", startY, F, rhythm);

  const twoCol = layout.segmentTable.length > 6;
  const colSpan = twoCol ? (right - left - pt(24)) / 2 : right - left;
  const columns = twoCol
    ? [layout.segmentTable.slice(0, Math.ceil(layout.segmentTable.length / 2)), layout.segmentTable.slice(Math.ceil(layout.segmentTable.length / 2))]
    : [layout.segmentTable];

  const headSize = TYPE.tableHead;
  const cellSize = TYPE.tableCell;
  const dispositionText: Record<string, string> = {
    "distance only": "distance-only tag",
    "margin leader": "moved to margin leader",
    dropped: "dropped · this table governs",
  };
  let minY = headRuleY;
  columns.forEach((rows, ci) => {
    const colLeft = left + ci * (colSpan + pt(24));
    const segX = colLeft;
    const bearingX = colLeft + pt(44);
    const distX = colLeft + pt(150);
    const dispX = colLeft + pt(210);
    // Header row (no rule above; a neutral-300 rule closes it).
    const head = placeRowBelowRule(headRuleY, LB.tableHead, { padTop: padCell, padBottom: padCell });
    for (const [text, x] of [
      ["SEG", segX],
      ["BEARING", bearingX],
      ["DIST.", distX],
      [`ON SHEET ${sheetLabel(1, numbering).no}`, dispX],
    ] as [string, number][]) {
      drawTrackedText(page, text, {
        x,
        y: head.baselines[0]!,
        size: headSize,
        font: F.displayMedium,
        color: TOKENS.neutral600,
        trackingEm: TRACKING.tableHead,
      });
    }
    if (ci === 0) rhythm.row(2, "segment-head", head, LB.tableHead, padCell, { ruleDrawn: false });
    let ruleY = head.nextRuleY;
    page.drawLine({ start: { x: colLeft, y: ruleY }, end: { x: colLeft + colSpan, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });
    for (const row of rows) {
      const placed = placeRowBelowRule(ruleY, LB.tableRow, { padTop: padCell, padBottom: padCell });
      const cy = placed.baselines[0]!;
      page.drawText(row.seg, { x: segX, y: cy, size: cellSize, font: F.body, color: TOKENS.neutral700 });
      page.drawText(row.bearing, { x: bearingX, y: cy, size: cellSize, font: F.body, color: INK });
      page.drawText(row.distance, { x: distX, y: cy, size: cellSize, font: F.body, color: INK });
      page.drawText(dispositionText[row.disposition] ?? row.disposition, {
        x: dispX,
        y: cy,
        size: cellSize,
        font: F.body,
        color: TOKENS.neutral600,
      });
      if (ci === 0) rhythm.row(2, "segment-row", placed, LB.tableRow, padCell);
      ruleY = placed.nextRuleY;
      page.drawLine({ start: { x: colLeft, y: ruleY }, end: { x: colLeft + colSpan, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
    }
    minY = Math.min(minY, ruleY);
  });
  return minY;
}

/** Provenance (§7/§13): three columns — layer · source · confidence enum.
 * §21 row model at table density; multi-line cells grow the row's line
 * boxes, the rule always clears the deepest cell. */
function drawProvenanceTable(
  page: PDFPage,
  model: SitePlanModel,
  F: Fonts,
  startY: number,
  rhythm: RhythmCapture,
): void {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const padCell = pt(SPACE.s1);
  const headRuleY = drawSectionHeading(page, 2, "PROVENANCE / CITATIONS", startY, F, rhythm);

  const layerX = left;
  const sourceX = left + pt(140);
  const confX = right - pt(150);
  const headSize = TYPE.tableHead;
  const head = placeRowBelowRule(headRuleY, LB.tableHead, { padTop: padCell, padBottom: padCell });
  for (const [text, x] of [
    ["LAYER", layerX],
    ["SOURCE", sourceX],
    ["CONFIDENCE", confX],
  ] as const) {
    drawTrackedText(page, text, {
      x,
      y: head.baselines[0]!,
      size: headSize,
      font: F.displayMedium,
      color: TOKENS.neutral600,
      trackingEm: TRACKING.tableHead,
    });
  }
  rhythm.row(2, "provenance-head", head, LB.tableHead, padCell, { ruleDrawn: false });
  let ruleY = head.nextRuleY;
  page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });

  const entries = buildProvenancePanelEntries(model);
  const cellSize = TYPE.tableCell;
  for (const entry of entries) {
    const layerLines = wrapTextToWidth(entry.layer, F.body, cellSize, sourceX - layerX - pt(8));
    const sourceLines = wrapTextToWidth(entry.source, F.body, cellSize, confX - sourceX - pt(8));
    const confLines = wrapTextToWidth(entry.confidence, F.body, cellSize, right - confX);
    const lines = Math.max(layerLines.length, sourceLines.length, confLines.length);
    const placed = placeRowBelowRule(ruleY, LB.tableRow, { padTop: padCell, padBottom: padCell, lines });
    for (let i = 0; i < lines; i++) {
      const ry = placed.baselines[i]!;
      if (layerLines[i]) page.drawText(layerLines[i]!, { x: layerX, y: ry, size: cellSize, font: F.body, color: TOKENS.neutral700 });
      if (sourceLines[i]) page.drawText(sourceLines[i]!, { x: sourceX, y: ry, size: cellSize, font: F.body, color: INK });
      if (confLines[i]) page.drawText(confLines[i]!, { x: confX, y: ry, size: cellSize, font: F.body, color: TOKENS.neutral600 });
    }
    rhythm.row(2, "provenance-row", placed, LB.tableRow, padCell);
    ruleY = placed.nextRuleY;
    page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE 3 — AERIAL (§17–§20): natural-color Esri World Imagery backdrop
// (§20 v1.2 — no duotone tint), vector overlay from the SAME model
// coordinates, paper-coloured outlines behind type/ring, 4-cell imagery
// provenance strip, registration tolerance stat.
// ─────────────────────────────────────────────────────────────────────────
const AERIAL_PROPERTY_STROKE = 1.8; // heaviest on the aerial sheet

function aerialImageRect(ruleY: number, footerBandTop: number): PageRect {
  return {
    x: MARGIN_X,
    y: footerBandTop,
    width: PAGE_WIDTH - MARGIN_X * 2,
    height: ruleY - pt(18) - footerBandTop,
  };
}

function drawHaloedRing(page: PDFPage, ring: PageXY[], color: RGB, thickness: number, dashArray?: number[]): void {
  drawRing(page, ring, PAPER, thickness + RASTER_OUTLINE_PT * 1.6);
  drawRing(page, ring, color, thickness, dashArray);
}

function drawHaloedPolyline(page: PDFPage, points: PageXY[], color: RGB, thickness: number): void {
  drawPolyline(page, points, PAPER, thickness + RASTER_OUTLINE_PT * 1.6);
  drawPolyline(page, points, color, thickness);
}

/** §20: paint-order emulation — paper-coloured underdraw in 8 directions, then ink. */
function drawHaloedText(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; size: number; font: PDFFont; color: RGB; rotationDeg?: number },
): void {
  const r = RASTER_OUTLINE_PT;
  const rotate = opts.rotationDeg ? degrees(opts.rotationDeg) : undefined;
  for (const [dx, dy] of [
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
    [r * 0.7, r * 0.7],
    [-r * 0.7, r * 0.7],
    [r * 0.7, -r * 0.7],
    [-r * 0.7, -r * 0.7],
  ] as const) {
    page.drawText(text, { x: opts.x + dx, y: opts.y + dy, size: opts.size, font: opts.font, color: PAPER, ...(rotate ? { rotate } : {}) });
  }
  page.drawText(text, { x: opts.x, y: opts.y, size: opts.size, font: opts.font, color: opts.color, ...(rotate ? { rotate } : {}) });
}

function clipToRect(points: PageXY[], rect: PageRect): PageXY[][] {
  const tuples: Array<[number, number]> = points.map((p) => [p.x, p.y]);
  const parts = clipPolylineToAabb(tuples, {
    minX: rect.x,
    maxX: rect.x + rect.width,
    minY: rect.y,
    maxY: rect.y + rect.height,
  });
  return parts.filter((part) => part.length >= 2).map((part) => part.map(([x, y]) => ({ x, y })));
}

/**
 * §18: the registration tolerance is the REAL maximum deviation, across ring
 * vertices, between the exact ENU-inverse mapping the overlay uses and a
 * plain linear (equirectangular) map of the same mercator bbox onto the rect.
 * Returned in ground feet, or null when not computable — never a guess.
 */
export function computeRegistrationToleranceFeet(
  model: SitePlanModel,
  mercBbox: MercatorBbox,
  rect: PageRect,
): number | null {
  try {
    const exact = makeAerialOverlayTransform(mercBbox, rect, model.bboxWgs84);
    const R = 6378137;
    const mercToLat = (y: number): number => ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI;
    const mercToLng = (x: number): number => ((x / R) * 180) / Math.PI;
    const west = mercToLng(mercBbox.xmin);
    const east = mercToLng(mercBbox.xmax);
    const south = mercToLat(mercBbox.ymin);
    const north = mercToLat(mercBbox.ymax);
    if (![west, east, south, north].every(Number.isFinite) || east === west || north === south) return null;
    const ptsPerMeter = aerialPagePointsPerGroundMeter(mercBbox, rect, model.bboxWgs84);
    if (!Number.isFinite(ptsPerMeter) || ptsPerMeter <= 0) return null;
    let maxDev = 0;
    for (const p of model.ringLocal) {
      const wgs = localEnuToWgs84(p, model.bboxWgs84);
      const linear: PageXY = {
        x: rect.x + ((wgs.lng - west) / (east - west)) * rect.width,
        y: rect.y + ((wgs.lat - south) / (north - south)) * rect.height,
      };
      const ex = exact(p);
      const dev = Math.hypot(ex.x - linear.x, ex.y - linear.y);
      if (!Number.isFinite(dev)) return null;
      if (dev > maxDev) maxDev = dev;
    }
    const feet = maxDev / ptsPerMeter / 0.3048;
    if (!Number.isFinite(feet)) return null;
    return Math.max(0.1, Math.ceil(feet * 10) / 10);
  } catch {
    return null;
  }
}

function drawAerialOverlay(
  page: PDFPage,
  model: SitePlanModel,
  mercBbox: MercatorBbox,
  rect: PageRect,
  F: Fonts,
  marks: MarkRegistry,
): void {
  const toPage = makeAerialOverlayTransform(mercBbox, rect, model.bboxWgs84);

  // STREET centerlines (context), clipped to the imagery rect.
  if (!model.streets.honestAbsence) {
    model.streets.anchors.forEach((anchor, i) => {
      if (!marks.once(3, "street", `${anchor.name}:${i}`)) return;
      const projected = anchor.pointsLocal.map(toPage);
      for (const part of clipToRect(projected, rect)) {
        drawHaloedPolyline(page, part, STREET_COLOR, 1.1);
      }
    });
  }

  // BUILDABLE ENVELOPE ring — dashed accent, no fill (§20: imagery visible).
  // Skipped when degenerate or honest-absent (§15/§18: nothing fabricated).
  if (model.setback.offsetRingLocal && !model.setback.honestAbsence && !model.setback.degenerate) {
    if (marks.once(3, "setback-dash", "envelope")) {
      drawHaloedRing(page, model.setback.offsetRingLocal.map(toPage), SETBACK_DASH_COLOR, STROKE.setbackDash + 0.3, SETBACK_DASH);
    }
  }

  // PROPERTY LINE — heaviest stroke, paper outline behind it (§20).
  if (marks.once(3, "property-line", "ring")) {
    drawHaloedRing(page, model.ringLocal.map(toPage), PROPERTY_COLOR, AERIAL_PROPERTY_STROKE);
  }

  // §18: distances over imagery are DISTANCE-ONLY; full bearings stay on
  // sheet 1. One per segment, rotated, paper-outlined, drawn only where the
  // edge is long enough.
  model.propertySegments.forEach((segment, i) => {
    const a = toPage(segment.a);
    const b = toPage(segment.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const edgeLen = Math.hypot(dx, dy);
    const size = TYPE.drawingTag;
    const text = formatFeetPrime(segment.lengthFeet, 1);
    const width = F.body.widthOfTextAtSize(text, size);
    if (edgeLen < width * 1.2 || edgeLen < size * 3) return;
    if (!marks.once(3, "tag", `S${i + 1}`)) return;
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle <= -Math.PI / 2) angle += Math.PI;
    // Outward = away from the ring centroid.
    const cx = model.ringLocal.reduce((sum, p) => sum + p.x, 0) / model.ringLocal.length;
    const cy = model.ringLocal.reduce((sum, p) => sum + p.y, 0) / model.ringLocal.length;
    const centroidPage = toPage({ x: cx, y: cy });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nx = mid.x - centroidPage.x;
    let ny = mid.y - centroidPage.y;
    const nLen = Math.hypot(nx, ny) || 1;
    nx /= nLen;
    ny /= nLen;
    const off = size * 1.1;
    const center = { x: mid.x + nx * off, y: mid.y + ny * off };
    const u = { x: Math.cos(angle), y: Math.sin(angle) };
    const v = { x: -Math.sin(angle), y: Math.cos(angle) };
    const drawAt = {
      x: center.x - u.x * (width / 2) - v.x * (size / 3),
      y: center.y - u.y * (width / 2) - v.y * (size / 3),
    };
    // Keep inside the imagery rect.
    if (
      drawAt.x < rect.x ||
      drawAt.x > rect.x + rect.width ||
      drawAt.y < rect.y ||
      drawAt.y > rect.y + rect.height
    ) {
      return;
    }
    drawHaloedText(page, text, {
      x: drawAt.x,
      y: drawAt.y,
      size,
      font: F.body,
      color: INK,
      rotationDeg: (angle * 180) / Math.PI,
    });
  });

  // NORTH arrow, top-right inside the imagery, direction through the aerial
  // transform (never assumed). Halo disc so it reads over any tone.
  if (marks.once(3, "north-arrow", "north")) {
    const pOrigin = toPage(model.north.originLocal);
    const pTip = toPage({
      x: model.north.originLocal.x + model.north.directionLocal.x,
      y: model.north.originLocal.y + model.north.directionLocal.y,
    });
    let dx = pTip.x - pOrigin.x;
    let dy = pTip.y - pOrigin.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const arrowLen = Math.min(rect.width, rect.height) * 0.09;
    const inset = arrowLen + 10;
    const tip: PageXY = { x: rect.x + rect.width - inset, y: rect.y + rect.height - inset + arrowLen };
    const origin: PageXY = { x: tip.x - dx * arrowLen, y: tip.y - dy * arrowLen };
    page.drawCircle({ x: tip.x, y: tip.y - arrowLen * 0.35, size: arrowLen * 0.95, color: PAPER, opacity: 0.55 });
    drawNorthArrow(page, { origin, tip }, F.display);
  }
}

/** §20: the frame keeps its registration marks — corner ticks outside the rect. */
function drawRegistrationMarks(page: PDFPage, rect: PageRect): void {
  const len = pt(11);
  const gap = pt(5);
  const corners: Array<[number, number, number, number]> = [
    [rect.x - gap, rect.y - gap, 1, 1],
    [rect.x + rect.width + gap, rect.y - gap, -1, 1],
    [rect.x - gap, rect.y + rect.height + gap, 1, -1],
    [rect.x + rect.width + gap, rect.y + rect.height + gap, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + sx * len, y }, thickness: 0.7, color: TOKENS.neutral500 });
    page.drawLine({ start: { x, y }, end: { x, y: y + sy * len }, thickness: 0.7, color: TOKENS.neutral500 });
  }
}

interface ImageryStripCell {
  label: string;
  value?: string;
  qualifier?: string;
  chip?: boolean;
  chipReason?: string;
}

/** §19/§21 imagery strip height: space-3 pads around a label line box, a 2px
 * gap, and TWO value line boxes (chip reasons legitimately wrap — the §19
 * capture-date cell always carries one on the Esri basemap). */
function imageryStripHeight(): number {
  return pt(SPACE.s3) * 2 + LB.stripLabel.lineBoxHeight + pt(2) + 2 * LB.stripValue.lineBoxHeight;
}

/** §19: four cells, always all four — source · capture date · resolution · registration. */
function drawImageryStrip(
  page: PDFPage,
  cells: ImageryStripCell[],
  topY: number,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
): number {
  if (!marks.once(3, "imagery-strip", "strip")) return topY;
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const width = right - left;
  const cellW = width / 4;
  const stripH = imageryStripHeight();
  drawHairlineRule(page, left, topY, width, TOKENS.neutral300, 0.7);
  drawHairlineRule(page, left, topY - stripH, width, TOKENS.neutral300, 0.7);
  const labelBoxTop = topY - pt(SPACE.s3);
  const labelBaseline = labelBoxTop - LB.stripLabel.baselineFromBoxTop;
  const valueBoxTop = labelBoxTop - LB.stripLabel.lineBoxHeight - pt(2);
  const valueBaseline = valueBoxTop - LB.stripValue.baselineFromBoxTop;
  cells.forEach((cell, i) => {
    const x = left + i * cellW + (i === 0 ? 0 : pt(10));
    if (i > 0) {
      page.drawLine({
        start: { x: left + i * cellW, y: topY - stripH + pt(4) },
        end: { x: left + i * cellW, y: topY - pt(4) },
        thickness: STROKE.rowRule,
        color: TOKENS.neutral200,
      });
    }
    drawTrackedText(page, cell.label, {
      x,
      y: labelBaseline,
      size: TYPE.stripLabel,
      font: F.body,
      color: TOKENS.neutral600,
      trackingEm: TRACKING.statLabel,
    });
    if (cell.chip) {
      const chipEnd = drawChipOnLineBox(page, CHIP_UNAVAILABLE, x, valueBoxTop, LB.stripValue, "solid", F, pt(8.5));
      if (cell.chipReason) {
        const reasonLines = wrapTextToWidth(cell.chipReason, F.body, pt(8.5), cellW - (chipEnd - x) - pt(16));
        page.drawText(reasonLines[0]!, { x: chipEnd + pt(5), y: valueBaseline, size: pt(8.5), font: F.body, color: TOKENS.neutral600 });
        if (reasonLines[1]) {
          page.drawText(reasonLines[1]!, {
            x,
            y: valueBaseline - LB.stripValue.lineBoxHeight,
            size: pt(8.5),
            font: F.body,
            color: TOKENS.neutral600,
          });
        }
      }
    } else {
      page.drawText(cell.value ?? "", { x, y: valueBaseline, size: TYPE.stripValue, font: F.body, color: INK });
      if (cell.qualifier) {
        const vw = F.body.widthOfTextAtSize(cell.value ?? "", TYPE.stripValue);
        page.drawText(cell.qualifier, { x: x + vw + pt(5), y: valueBaseline, size: pt(9.5), font: F.body, color: TOKENS.neutral600 });
      }
    }
    const placed = placeRowBelowRule(topY, LB.stripLabel, { padTop: pt(SPACE.s3), padBottom: pt(2) });
    rhythm.row(3, "strip-cell", placed, LB.stripLabel, pt(SPACE.s3), { ruleDrawn: true });
  });
  return topY - stripH;
}

interface AerialLegendRow {
  label: string;
  swatch: "line-heavy" | "line-dashed" | "imagery" | "line-dotted";
  color: RGB;
  empty?: boolean;
}

function drawAerialFooter(
  page: PDFPage,
  model: SitePlanModel,
  mercBbox: MercatorBbox,
  rect: PageRect,
  imagery: AerialImageryResult,
  F: Fonts,
  ruleY: number,
  marks: MarkRegistry,
  finePrint: string,
  rhythm: RhythmCapture,
  numbering?: SheetNumbering,
): void {
  drawHairlineRule(page, MARGIN_X, ruleY, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);

  const s1 = sheetLabel(1, numbering).no;
  // Legend (§5 applied to this sheet): fixed rows, empty states inline.
  const drawsEnvelope =
    !!model.setback.offsetRingLocal && !model.setback.honestAbsence && !model.setback.degenerate;
  const rows: AerialLegendRow[] = [
    { label: `Property line — same geometry as sheet ${s1}`, swatch: "line-heavy", color: PROPERTY_COLOR },
    drawsEnvelope
      ? { label: "Buildable envelope", swatch: "line-dashed", color: SETBACK_DASH_COLOR }
      : {
          label: model.setback.degenerate
            ? "Buildable envelope — none drawn · setbacks exceed the lot"
            : "Buildable envelope — not drawn · no setback rule on file",
          swatch: "line-dashed",
          color: SUPPRESSED,
          empty: true,
        },
    imagery.ok
      ? { label: "Aerial imagery — backdrop only, not a measurement source", swatch: "imagery", color: SUPPRESSED, empty: true }
      : { label: "Aerial imagery — unavailable · overlay on paper ground", swatch: "imagery", color: SUPPRESSED, empty: true },
    { label: `Contour — not shown here · see sheet ${s1}`, swatch: "line-dotted", color: SUPPRESSED, empty: true },
  ];
  if (marks.once(3, "legend", "legend")) {
    const perCol = Math.ceil(rows.length / 2);
    const swatchBand = pt(24) + pt(9);
    const pitch = LB.legendSmall.lineBoxHeight + pt(SPACE.s2);
    const col1Width =
      Math.max(...rows.slice(0, perCol).map((r) => F.body.widthOfTextAtSize(r.label, pt(10)))) + swatchBand;
    rows.forEach((row, i) => {
      const col = Math.floor(i / perCol);
      const line = i % perCol;
      const x = col === 0 ? MARGIN_X : MARGIN_X + col1Width + pt(18);
      const boxTop = ruleY - pt(SPACE.s2) - line * pitch;
      const y = boxTop - LB.legendSmall.baselineFromBoxTop;
      if (col === 0) {
        const placed = placeRowBelowRule(ruleY - line * pitch, LB.legendSmall, {
          padTop: pt(SPACE.s2),
          padBottom: pt(SPACE.s2),
        });
        rhythm.row(3, "legend-row", placed, LB.legendSmall, pt(SPACE.s2), { ruleDrawn: line === 0 });
      }
      const w = pt(24);
      const mid = y + pt(1);
      if (row.swatch === "imagery") {
        page.drawRectangle({ x, y: y - pt(3), width: w, height: pt(9), color: TOKENS.accent200, borderColor: TOKENS.neutral300, borderWidth: 0.5 });
      } else {
        const thickness = row.swatch === "line-heavy" ? 1.4 : 0.8;
        const dash = row.swatch === "line-dashed" ? [2.2, 1.6] : row.swatch === "line-dotted" ? [0.6, 2] : undefined;
        page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness, color: row.color, dashArray: dash });
      }
      page.drawText(row.label, {
        x: x + w + pt(9),
        y,
        size: pt(10),
        font: F.body,
        color: row.empty ? SUPPRESSED : TOKENS.neutral800,
      });
    });
  }

  // Ground-true scale bar (§9 form: unit on the last label) + meta line.
  if (marks.once(3, "scale-bar", "scale")) {
    const right = PAGE_WIDTH - MARGIN_X;
    const ptsPerMeter = aerialPagePointsPerGroundMeter(mercBbox, rect, model.bboxWgs84);
    const targetMeters = pt(120) / ptsPerMeter;
    let nice = 0;
    const exp = Math.floor(Math.log10(Math.max(targetMeters, 1)));
    outer: for (let e = exp; e >= exp - 3; e--) {
      for (const step of [5, 2, 1]) {
        const candidate = step * 10 ** e;
        if (candidate <= targetMeters) {
          nice = candidate;
          break outer;
        }
      }
    }
    if (nice <= 0) nice = Math.max(targetMeters, 1);
    const barWidth = nice * ptsPerMeter;
    const blockW = barWidth / 3;
    const barLeft = right - barWidth;
    const barTop = ruleY - pt(8);
    const blockColors = [INK, TOKENS.neutral300, INK];
    for (let i = 0; i < 3; i++) {
      page.drawRectangle({ x: barLeft + i * blockW, y: barTop, width: blockW, height: pt(5), color: blockColors[i]!, borderWidth: 0 });
    }
    const lengthFeet = feetFromMeters(nice);
    const labelY = barTop - pt(11);
    const midLabel = `${Math.round(lengthFeet / 2)}`;
    const maxLabel = `${Math.round(lengthFeet)} ft`;
    page.drawText("0", { x: barLeft, y: labelY, size: TYPE.scaleBarLabel, font: F.body, color: TOKENS.neutral700 });
    page.drawText(midLabel, {
      x: barLeft + barWidth / 2 - F.body.widthOfTextAtSize(midLabel, TYPE.scaleBarLabel) / 2,
      y: labelY,
      size: TYPE.scaleBarLabel,
      font: F.body,
      color: TOKENS.neutral700,
    });
    page.drawText(maxLabel, {
      x: right - F.body.widthOfTextAtSize(maxLabel, TYPE.scaleBarLabel),
      y: labelY,
      size: TYPE.scaleBarLabel,
      font: F.body,
      color: TOKENS.neutral700,
    });
    const feetPerInch = 72 / ptsPerMeter / 0.3048;
    const metaLine = `${formatScaleRatio(Math.round(feetPerInch))} · SP-${model.parcelNodeId.replace(/:/g, "-")} · generated ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")}Z`;
    page.drawText(metaLine, {
      x: right - F.body.widthOfTextAtSize(metaLine, TYPE.scaleRatioLine),
      y: labelY - pt(13),
      size: TYPE.scaleRatioLine,
      font: F.body,
      color: TOKENS.neutral600,
    });
  }

  drawFinePrint(page, 3, finePrint, F, marks);
}

function drawAerialPage(
  doc: PDFDocument,
  model: SitePlanModel,
  imagery: AerialImageryResult,
  png: PDFImage | undefined,
  mercBbox: MercatorBbox,
  rect: PageRect,
  F: Fonts,
  marks: MarkRegistry,
  rhythm: RhythmCapture,
  numbering?: SheetNumbering,
): void {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // §18 registration tolerance — computed, never guessed.
  const tolFeet = computeRegistrationToleranceFeet(model, mercBbox, rect);
  const registerStat: HeaderStat =
    tolFeet != null
      ? { label: "REGISTER", value: `±${tolFeet.toFixed(1)} FT`, color: ACCENT_TYPE }
      : { label: "REGISTER", chip: CHIP_UNAVAILABLE };
  const aerialLabel = sheetLabel(3, numbering);
  drawSheetHeader(
    page,
    model,
    F,
    `AERIAL · SHEET ${aerialLabel.no} OF ${aerialLabel.total}`,
    [{ label: "IMAGERY", value: "ESRI" }, { label: "CAPTURED", chip: CHIP_UNAVAILABLE }, registerStat],
    null,
  );

  if (imagery.ok && png) {
    if (marks.once(3, "imagery", "raster")) {
      page.drawImage(png, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
  } else {
    // §17 HONEST PATH: the page still ships — overlay on the paper ground,
    // UNAVAILABLE chip in the imagery strip. Never a dropped page.
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      borderColor: TOKENS.neutral300,
      borderWidth: 0.7,
      color: PAPER,
    });
  }

  // §18: overlay from the SAME model coordinates on both paths.
  drawAerialOverlay(page, model, mercBbox, rect, F, marks);

  // Frame + §20 registration marks.
  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    borderColor: TOKENS.neutral300,
    borderWidth: 0.7,
    color: undefined,
  });
  drawRegistrationMarks(page, rect);

  // §19 imagery provenance strip — four cells, always all four.
  const pxSize = aerialImagePixelSize(mercBbox);
  const meanLat = (model.bboxWgs84.southLat + model.bboxWgs84.northLat) / 2;
  const groundMetersPerPx = ((mercBbox.xmax - mercBbox.xmin) / pxSize.width) * Math.cos((meanLat * Math.PI) / 180);
  const cells: ImageryStripCell[] = [
    { label: "SOURCE", value: "Esri World Imagery" },
    { label: "CAPTURE DATE", chip: true, chipReason: REASON.noCaptureDate },
    imagery.ok
      ? { label: "RESOLUTION", value: `${groundMetersPerPx.toFixed(2)} m / pixel` }
      : { label: "RESOLUTION", chip: true, chipReason: REASON.imageryFetchFailed },
    tolFeet != null
      ? { label: "REGISTRATION", value: `±${tolFeet.toFixed(1)} ft`, qualifier: "— parcel ring to imagery" }
      : { label: "REGISTRATION", chip: true, chipReason: REASON.registrationNotComputable },
  ];
  const stripTop = rect.y - pt(6);
  const stripBottom = drawImageryStrip(page, cells, stripTop, F, marks, rhythm);

  const registrationSentence =
    tolFeet != null
      ? `Overlay registration to the imagery is approximate to ±${tolFeet.toFixed(1)} ft.`
      : "Overlay registration tolerance could not be computed for this export.";
  drawAerialFooter(
    page,
    model,
    mercBbox,
    rect,
    imagery,
    F,
    stripBottom - pt(8),
    marks,
    buildFinePrint(model, 3, {
      movedSegs: [],
      registrationSentence,
      imagery,
      // Esri's export publishes NO capture date — age is unknown, so the
      // §19 imagery-age disclosure never fires from an inferred date.
      imageryAgeMonths: null,
      numbering,
    }),
    rhythm,
    numbering,
  );
}

/**
 * Renders the PDF site-plan sheet from the SAME `SitePlanModel` the DXF/IFC
 * emitters read (WDLL 5) — sheet 1 drawing, sheet 2 summary + provenance,
 * sheet 3 natural-color aerial context. Governed by SHEET_STANDARD_v1.html.
 */
export async function emitPdfSitePlan(
  model: SitePlanModel,
  options: EmitPdfSitePlanOptions = {},
): Promise<PdfSitePlanResult> {
  const doc = await PDFDocument.create();
  // Embed Barlow (body) + Barlow Condensed (display) via fontkit.
  // subset:false embeds each weight ONCE as a full font shared by every draw;
  // subset:true would re-subset per glyph (tracked headings draw glyph-by-
  // glyph), exploding into hundreds of tiny font objects and breaking
  // ToUnicode text extraction.
  doc.registerFontkit(fontkit);
  const F: Fonts = {
    body: await doc.embedFont(loadFont("Barlow-Regular.ttf"), { subset: false }),
    bodyMedium: await doc.embedFont(loadFont("Barlow-Medium.ttf"), { subset: false }),
    display: await doc.embedFont(loadFont("BarlowCondensed-SemiBold.ttf"), { subset: false }),
    displayMedium: await doc.embedFont(loadFont("BarlowCondensed-Medium.ttf"), { subset: false }),
  };
  const marks = new MarkRegistry();
  const rhythm = new RhythmCapture();
  const numbering = options.numbering;
  const label1 = sheetLabel(1, numbering);
  const label2 = sheetLabel(2, numbering);

  // AERIAL (sheet 3) imagery fetch — started first so the bounded network
  // wait (default 8s cap) overlaps the vector rendering of sheets 1–2.
  // §21 footer stack, bottom up: fine print (6 lines) → legend band (space-3
  // gap + two small-legend line boxes with space-2 pads) → footer rule →
  // strip → imagery rect.
  const aerialLegendBand =
    pt(SPACE.s3) + pt(SPACE.s2) * 2 + 2 * LB.legendSmall.lineBoxHeight + pt(8);
  const aerialFooterBandTop =
    MARGIN_BOTTOM + LB.finePrint.lineBoxHeight * 6 + aerialLegendBand + imageryStripHeight() + pt(6);
  const aerialRect = aerialImageRect(headerRuleY(), aerialFooterBandTop);
  const mercBbox = computeAerialMercatorBbox(model.ringLocal, model.bboxWgs84, aerialRect.width / aerialRect.height);
  const aerialUrl = buildAerialExportUrl(mercBbox, aerialImagePixelSize(mercBbox));
  const aerialPromise = fetchAerialImagery(aerialUrl, {
    fetchImage: options.aerial?.fetchImage,
    timeoutMs: options.aerial?.timeoutMs,
  });

  // PAGE 1 — drawing.
  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const page1RuleY = drawSheetHeader(
    page1,
    model,
    F,
    `SITE PLAN · SHEET ${label1.no} OF ${label1.total}`,
    page1HeaderStats(model),
    null,
  );

  const footerBandTop = page1FooterRuleY() + pt(6);
  const drawingBox: DrawingBox = {
    x: MARGIN_X,
    y: footerBandTop,
    width: PAGE_WIDTH - MARGIN_X * 2,
    height: page1RuleY - pt(18) - footerBandTop,
  };
  // §3 (v1.2) drawing frame: the rect between the header rule and the
  // furniture band. The layout clips every context layer and confines every
  // label to this rect; the frame-clip gate asserts sheet-1 mark bboxes
  // against it via `result.page1Frame`.
  const page1Frame: MarkBbox = {
    minX: MARGIN_X,
    minY: footerBandTop,
    maxX: PAGE_WIDTH - MARGIN_X,
    maxY: page1RuleY - pt(4),
  };
  const layout = buildSitePlanDrawingLayout(model, drawingBox, {
    measureText: (text, size) => F.body.widthOfTextAtSize(text, size),
    sheetBounds: page1Frame,
  });
  drawSitePlanDrawing(page1, layout, F, marks);
  const movedSegs = layout.segmentTable.map((r) => r.seg);
  drawPage1Footer(page1, layout, model, F, marks, buildFinePrint(model, 1, { movedSegs, numbering }), rhythm, numbering);

  // PAGE 2 — summary.
  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const page2RuleY = drawSheetHeader(page2, model, F, `SUMMARY · SHEET ${label2.no} OF ${label2.total}`, null, [
    `SP-${model.parcelNodeId.replace(/:/g, "-")}`,
    model.parcelNodeId,
  ]);
  const afterSummaryY = drawSummaryTable(page2, model, F, page2RuleY, rhythm);
  const afterSegmentsY = drawSegmentTable(page2, layout, F, afterSummaryY, marks, rhythm, numbering);
  drawProvenanceTable(page2, model, F, afterSegmentsY, rhythm);
  drawFinePrint(page2, 2, buildFinePrint(model, 2, { movedSegs, numbering }), F, marks);

  // PAGE 3 — aerial context. The fetch is bounded and never throws; §20
  // (v1.2) embeds the orthophoto in NATURAL COLOR — no duotone tint, no
  // processing pass; legibility over full colour comes from the paper
  // outlines behind ring/type. A decode failure degrades to the honest §17
  // path, never a failed export.
  let imagery = await aerialPromise;
  let aerialPng: PDFImage | undefined;
  if (imagery.ok) {
    try {
      aerialPng = await doc.embedPng(imagery.bytes);
    } catch (error) {
      imagery = {
        ok: false,
        reason: `imagery decode failed: ${error instanceof Error ? error.message : String(error)}`,
        url: imagery.url,
      };
    }
  }
  drawAerialPage(doc, model, imagery, aerialPng, mercBbox, aerialRect, F, marks, rhythm, numbering);

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: doc.getPageCount(),
    fontNote: FONT_NOTE,
    aerial: imagery.ok
      ? { imageryEmbedded: true, sourceUrl: imagery.url }
      : { imageryEmbedded: false, sourceUrl: imagery.url, unavailableReason: imagery.reason },
    marks: marks.marks,
    rhythm: rhythm.rows,
    page1Frame,
  };
}

/** @internal exported for checklist tests (fine-print composition). */
export { buildFinePrint, headerRuleY };

/**
 * @internal shared sheet primitives for sibling assemblers in this directory
 * (the property-dossier assembler, dossier.ts). These are the Standard's
 * building blocks — tokens ride in template-tokens.ts; these are the drawing
 * and rhythm helpers that keep a sibling document in the SAME design
 * language instead of re-inventing it. Not part of the public package API.
 */
export {
  LB,
  METRICS,
  MarkRegistry,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  MARGIN_BOTTOM,
  MARGIN_TOP,
  MARGIN_X,
  drawChipOnLineBox,
  drawFinePrint,
  drawHairlineRule,
  drawHeaderStats,
  drawSectionHeading,
  drawTrackedText,
  drawRing,
  drawFilledRing,
  drawPolyline,
  drawNorthArrow,
  loadFont,
  streetOnly,
  cityFromAddress,
  trackedWidth,
  wrapTextToWidth,
  type Fonts,
  type HeaderStat,
};
