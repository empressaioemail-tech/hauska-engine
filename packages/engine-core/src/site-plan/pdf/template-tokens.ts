import { rgb, type RGB } from "pdf-lib";

/**
 * Industry design-system tokens, ported verbatim from ds-industry.css
 * (the operator's site-plan template). This is the single place the PDF
 * renderer resolves colour, spacing, and type from — never hard-code a hex,
 * font size, or letter-spacing that a token already carries (template rule
 * 10 · NEVER). When the design sheet is retuned, retune it here.
 *
 * Hex → pdf-lib rgb() (0..1). Kept as a flat map so a token lookup reads the
 * same as `var(--color-...)` in the source template.
 */

function hex(h: string): RGB {
  const clean = h.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/** Colour tokens (ds-industry.css :root). */
export const TOKENS = {
  // Ground + ink
  surface: hex("#e9e9ea"),
  neutral100: hex("#f5f5f8"), // sheet ground
  neutral200: hex("#e7e7ea"), // row rule (light)
  neutral300: hex("#d4d4d7"), // row rule / contour
  neutral400: hex("#b7b7ba"),
  neutral500: hex("#98989b"), // suppressed / empty layer, contour label
  neutral600: hex("#7a7a7d"), // muted label, fine print
  neutral700: hex("#5d5d60"), // dimension tag
  neutral800: hex("#424244"),
  neutral900: hex("#2b2b2d"),
  text: hex("#1d1f20"), // property line + type ink (heaviest)

  // Accent (steel — the ONE accent hue)
  accent: hex("#5980a6"),
  accent100: hex("#eef6ff"), // envelope fill
  accent200: hex("#d6ebff"),
  accent300: hex("#b5d9fd"),
  accent400: hex("#94bce3"),
  accent500: hex("#749dc4"), // setback dash
  accent600: hex("#597ea3"),
  accent700: hex("#416180"), // accent type, kickers, buildable value
  accent800: hex("#2c455d"),
  accent900: hex("#1d2d3d"),
} as const;

/**
 * Spacing scale (ds-industry.css --space-*), in px @96dpi. The template's
 * sheet is 816×1056 px (Letter @96dpi); the PDF is 612×792 pt (Letter @72dpi).
 * Multiply a template px by PX_TO_PT to land the same physical measure.
 */
export const PX_TO_PT = 72 / 96; // 0.75

export const SPACE = {
  s1: 3.4,
  s2: 6.8,
  s3: 10.2,
  s4: 13.6,
  s6: 20.4,
  s8: 27.2,
} as const;

/** Template px converted to PDF points. */
export function pt(px: number): number {
  return px * PX_TO_PT;
}

/**
 * Type sizes from the SHEET STANDARD v1.0 token map (px @96dpi) → PDF points.
 * Named for the role each occupies in the standard (§2, §7, §8, §9).
 */
export const TYPE = {
  // Header, every page (§2)
  eyebrow: pt(11), // accent kicker, 0.22em tracked, uppercase
  address: pt(30), // Barlow Condensed 600 uppercase
  subline: pt(13), // city · parcel · county
  statLabel: pt(10), // LOT / BUILDABLE / ZONING label, 0.14em
  statValue: pt(22), // Barlow Condensed 600
  sheetMeta: pt(11), // sheet-id / parcel, right of p2 header

  // Summary page 2 (§7)
  groupHeading: pt(10.5), // PARCEL / ZONING & BUILDABILITY ... 0.2em accent
  rowLabel: pt(11.5),
  rowValue: pt(13),
  rowQualifier: pt(11),
  tableHead: pt(11),
  tableCell: pt(11),

  // Sheet furniture / fine print (§8, §9)
  scaleBarLabel: pt(9.5),
  scaleRatioLine: pt(9.5),
  legend: pt(11),
  finePrint: pt(8.2),
  chip: pt(9.5),

  // Drawing type (SHEET STANDARD geometry table): the floor that matters is
  // the RENDERED one — no drawing type below 10 px on an 816×1056 sheet.
  // 11 px ≈ 8.25 pt (dimension tags), 10 px ≈ 7.5 pt (setback/contour/street).
  drawingTag: pt(11),
  drawingSetback: pt(10),
  drawingContour: pt(10),
  drawingStreet: pt(10),
  drawingLeader: pt(11),

  // Imagery provenance strip (§19)
  stripLabel: pt(10),
  stripValue: pt(11.5),
} as const;

/** §13 floor: no drawing string below 10 px (≈ 7.5 pt) on the sheet. */
export const MIN_DRAWING_TYPE_PT = pt(10);

/**
 * §21 · line-height ratios (CSS-equivalent). Body copy runs at the mock's
 * dominant 1.6; display (condensed headings / titles) at 1.1; fine print
 * keeps the template's 1.55. Consumed by line-box.ts via `lineBox()`.
 */
export const LINE_HEIGHT = {
  body: 1.6,
  display: 1.1,
  finePrint: 1.55,
} as const;

/**
 * Letter-spacing (tracking) in em, from the template. pdf-lib 1.17 drawText
 * has no characterSpacing option, so tracked runs are drawn glyph-by-glyph
 * with this advance (see drawTrackedText in render.ts).
 */
export const TRACKING = {
  eyebrow: 0.22,
  statLabel: 0.14,
  groupHeading: 0.2,
  tableHead: 0.08,
  chip: 0.08,
} as const;

/**
 * Drawing-unit stroke weights + type sizes (template token map 2d). The
 * template expresses these in "drawing units (feet) at viewBox scale —
 * multiply by px-per-foot at render". Here they are the *page-point* weights
 * the pdf-lib renderer draws with directly (the parcel-primary transform
 * already sizes the drawing to the box), tuned to read the same as the
 * gold reference at Letter.
 *
 * Rule 3 · LAYER ORDER & WEIGHT: the property line is the heaviest stroke on
 * the sheet; nothing may match or exceed it.
 */
export const STROKE = {
  property: 1.6, // heaviest on sheet
  setbackDash: 0.9,
  contour: 0.5,
  marginLeader: 0.5, // §16 · 0.13-unit neutral-500 margin leader (page pts)
  hairlineRule: 1, // full-ink header/footer rule
  rowRule: 0.6,
} as const;

/** Setback dash pattern (accent-500, dash 2.5 / 2 in template units). */
export const SETBACK_DASH: [number, number] = [3.5, 2.8];

/** §20 · paper-coloured outline behind type/ring over raster (page pts). */
export const RASTER_OUTLINE_PT = 1.0;
