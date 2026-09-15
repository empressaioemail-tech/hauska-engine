import { PDFFont, PDFPage } from "pdf-lib";

import { DEEP_LINK_HOST, FOOTER, MASTHEAD, PARKED_DEEP_LINK_HOST, PRINT, RUNHEAD } from "./report-chrome-tokens.js";
import { MARGIN_BOTTOM, MARGIN_TOP, MARGIN_X, PAGE_HEIGHT, PAGE_WIDTH } from "./page-geometry.js";
import { drawHairlineRule, drawTrackedText, trackedWidth, wrapTextToWidth, type Fonts } from "./render.js";
import { pt } from "./template-tokens.js";
import { SMART_SITE_LOCKUP, SMART_SITE_MARK, type BrandMark } from "./brand/smart-site-brand.js";

/**
 * Report CHROME — masthead, running header, footer. Option 1a "Rule",
 * `_design/report-chrome/README.md` on doc_repo main (P-228). Shared by
 * the three report assemblers (feasibility.ts / flood-drainage.ts /
 * dossier.ts) and by the site-plan sheet renderer (render.ts) so all three
 * report types — and every sheet inside a combined document — share ONE
 * frame. Scope is the frame only: nothing here draws sheet-body content
 * (drawing, legend, scale bar, tables, narrative).
 *
 * MASTHEAD vs RUNNING HEADER is decided by the caller on one rule: draw the
 * masthead iff the sheet's PRINTED (post-renumbering) number is 1; every
 * other printed sheet gets the running header. That single rule, applied at
 * every call site, is what makes a site-plan sheet embedded inside a
 * Feasibility report automatically pick up a running header (Feasibility's
 * own cover is document sheet 1) while the same sheet stays a masthead when
 * it ships standalone.
 */

/**
 * Fonts the chrome needs beyond the four already embedded for sheet bodies
 * (`Fonts` from render.ts: body/bodyMedium/display/displayMedium). `mono`
 * and `monoBold` name the ROLE (the spec's `ui-monospace, SF Mono, Menlo,
 * monospace` elements: subject meta, doc id value, running-header meta,
 * footer meta), not a literal monospace face.
 *
 * CORRECTION (superseding CP1's original choice): pdf-lib's built-in
 * StandardFonts (Courier/Courier-Bold) do NOT carry a ToUnicode CMap the way
 * a fontkit-embedded custom font does, because a reader is expected to
 * decode a standard font's WinAnsi codes itself. This whole PDF system's own
 * verification method — and the dispatch's own documented one — inflates
 * FlateDecode streams and remaps drawn text through each embedded font's
 * `beginbfchar` block; a StandardFont's text has none, so every "mono"
 * string silently DROPPED OUT of every decoded-text assertion (caught by
 * the real test suite, not a hunch). `mono`/`monoBold` are therefore just
 * `body`/`bodyMedium` (Barlow Regular/Medium, already fontkit-embedded and
 * already ToUnicode-mapped) passed under names that document their ROLE in
 * the frame. Real monospacing is sacrificed; correct, extractable PDF text
 * is not — see CP2.
 */
export interface ChromeFonts extends Fonts {
  mono: PDFFont;
  monoBold: PDFFont;
}

/** `body`/`bodyMedium` are already embedded by every caller before this
 * runs — this is a pure relabeling, not a second embed. */
export function chromeMonoFonts(body: PDFFont, bodyMedium: PDFFont): { mono: PDFFont; monoBold: PDFFont } {
  return { mono: body, monoBold: bodyMedium };
}

// ─────────────────────────────────────────────────────────────────────────
// SMART SITE ring mark — drawn from the CANONICAL brand asset.
//
// P-239. This used to be four hand-typed numbers per variant, eyeballed from
// `_design/report-chrome/logo-*.svg` on doc_repo — which were themselves a
// redrawing of the real asset that nobody compared against it. The measured
// result was not the brand: stroke 40-60% too thin, dot 34-47% too small,
// ring 21% too small for its box, and — because `outer = 76 - inner` mixed a
// 76-unit coordinate space into a 96-unit one while the source SVG's own
// translate(10,10) was dropped — the crosshair came out ASYMMETRIC, with the
// N/S/W ticks floating detached OUTSIDE the ring and the E tick 2.4x longer
// and crossing it. Nothing could have caught that, because nothing in the
// repo held the canonical numbers to compare against.
//
// Now every number comes from `brand/smart-site-brand.ts`, which parses the
// vendored canonical SVG. There are no geometry constants here to drift.
// `brand/PROVENANCE.json` records the source commit and a sha256 per file;
// `__tests__/brand-provenance.test.ts` fails if asset, inlined text or hash
// ever disagree.
//
// No SVG rasterization pipeline exists in this repo (no sharp/resvg/canvas),
// so the parsed primitives are replayed as pdf-lib draw calls. That is a
// faithful replay of a parsed asset, not a redrawing.
//
// PAPER SUBSTITUTIONS — colour only, never geometry, and every one justified
// by a measured contrast ratio against --ss-paper #FCFBF9:
//   ring stroke + "SMART"  #ffffff -> PRINT.ink       (#ffffff is 1.034:1 — invisible)
//   "SITE"                 #F5B95C -> PRINT.printGold (#F5B95C is 1.695:1 — fails even 3:1)
//   centre dot             #E8963B -> UNCHANGED       (a filled mark, not text)
// ─────────────────────────────────────────────────────────────────────────

/** Replays a parsed canonical mark at `origin` (bottom-left, PDF points),
 * scaled uniformly so its native viewBox height renders at `heightPt`. */
function drawRing(page: PDFPage, origin: { x: number; y: number }, heightPt: number, art: BrandMark): void {
  const scale = heightPt / art.nativeHeight;
  // SVG y is top-down; PDF y is bottom-up.
  const toPt = (nativeX: number, nativeY: number) => ({
    x: origin.x + nativeX * scale,
    y: origin.y + (art.nativeHeight - nativeY) * scale,
  });
  const center = toPt(art.centerX, art.centerY);
  const strokeWidth = art.ringStrokeWidth * scale;

  // Ring — stroked, no fill.
  page.drawCircle({
    x: center.x,
    y: center.y,
    size: art.ringRadius * scale,
    borderColor: PRINT.ink,
    borderWidth: strokeWidth,
    color: undefined,
  });

  // The four crosshair ticks, exactly as the canonical SVG places them — they
  // STRADDLE the ring edge, which is what makes the mark read as a crosshair.
  for (const t of art.ticks) {
    page.drawLine({ start: toPt(t.x1, t.y1), end: toPt(t.x2, t.y2), thickness: strokeWidth, color: PRINT.ink });
  }

  // Centre dot — filled, true --ss-gold. A mark, not text, so it keeps the
  // canonical colour even though everything else in the frame prints in ink
  // or ss-print-gold.
  page.drawCircle({ x: center.x, y: center.y, size: art.dotRadius * scale, color: PRINT.gold, borderWidth: 0 });
}

/** smart-site-mark-crosshair.svg — ring only, in the running header. */
export function drawRunningHeaderMark(page: PDFPage, x: number, y: number): void {
  drawRing(page, { x, y }, RUNHEAD.markSize, SMART_SITE_MARK);
}

/**
 * smart-site-lockup.svg — ring + "SMART SITE" wordmark on the masthead.
 *
 * Text position, size and tracking are the canonical SVG's own: the wordmark
 * starts at native x=86 on a baseline at native y=48, set at 34 units with
 * 0.5 units of letter-spacing, all scaled by the same factor as the ring.
 * "SMART" prints in ink and "SITE" in --ss-print-gold (the wordmark's own
 * two-tone ruling; the ring dot alone keeps true gold).
 *
 * FONT is the one substitution that is not colour. Barlow Condensed SemiBold
 * stands in for Oxygen Bold — Oxygen is not embedded in this repo, and the
 * canonical SVG's own stack (`Oxygen, sans-serif`) already degrades to a
 * system sans wherever Oxygen is absent, which is this repo's situation. It
 * is drawn as TEXT, not paths, so it stays selectable and searchable in the
 * PDF; because `F.display` is fontkit-embedded it carries a ToUnicode CMap
 * and decodes (a pdf-lib StandardFont would NOT — see the ChromeFonts note).
 *
 * Returns the lockup's rendered width in points.
 */
export function drawMastheadWordmark(page: PDFPage, x: number, y: number, F: ChromeFonts): number {
  const art = SMART_SITE_LOCKUP;
  const scale = MASTHEAD.logoHeight / art.nativeHeight;
  drawRing(page, { x, y }, MASTHEAD.logoHeight, art);

  const w = art.wordmark;
  if (!w) {
    // Fail closed: the lockup without its wordmark is not the lockup.
    throw new Error("report-chrome: canonical lockup carries no wordmark. Refusing to draw a partial masthead.");
  }

  const size = w.fontSize * scale;
  const trackingEm = w.letterSpacing / w.fontSize; // SVG letter-spacing is absolute; drawTrackedText wants em.
  const textX = x + w.x * scale;
  const textY = y + (art.nativeHeight - w.baselineY) * scale;

  // The canonical lead run is "SMART " — its trailing space is part of the gap
  // to "SITE", so it is drawn and measured as written, never re-synthesised.
  // drawTrackedText returns the ABSOLUTE right edge, not a width.
  const afterLead = drawTrackedText(page, w.leadText, {
    x: textX,
    y: textY,
    size,
    font: F.display,
    color: PRINT.ink,
    trackingEm,
  });
  const afterAccent = drawTrackedText(page, w.accentText, {
    x: afterLead,
    y: textY,
    size,
    font: F.display,
    color: PRINT.printGold,
    trackingEm,
  });

  return afterAccent - x;
}

// ─────────────────────────────────────────────────────────────────────────
// MASTHEAD — sheet 1 of the document only.
// ─────────────────────────────────────────────────────────────────────────
export interface MastheadContent {
  /** "Feasibility Study" / "Site Plan" / "Flood & Drainage" — sentence case
   * in source; CSS-equivalent uppercase transform happens here at draw time. */
  reportType: string;
  /** Verbatim county casing — printed AS GIVEN, never forced to uppercase
   * (report-chrome README: "the one thing read first... never title case"). */
  address: string;
  /** Pre-joined `CITY, ST ZIP · PARCEL id · COUNTY NAME (fips)` — joining
   * rule lives with the caller, since it already varies slightly (missing
   * city, missing fips) the same way the old header's meta line did. */
  subjectMeta: string;
  docIdLabel?: string; // defaults to "Document"
  docIdValue: string;
}

/** Wraps the masthead address to at most 2 lines (spec: "a long address
 * wraps to two lines... without pushing the hairline into the body" — a
 * FIXED two-line reservation, never open-ended growth). A third line's worth
 * of text is not expected on a real parcel address; if it ever occurs, the
 * second line is not further wrapped/clipped — same "wrap, never clip"
 * convention this codebase already uses for fine print. */
function wrapAddress(address: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines = wrapTextToWidth(address, font, size, maxWidth);
  if (lines.length <= 2) return lines;
  return [lines[0]!, lines.slice(1).join(" ")];
}

/** The address column leaves room for the right-aligned doc-id block —
 * same width `drawMasthead` wraps against, exported so a pre-draw sizing
 * pass (render.ts: the drawing frame must be sized before the masthead
 * actually draws) can compute the SAME line count `drawMasthead` will. */
export function mastheadAddressColumnWidth(): number {
  return PAGE_WIDTH - MARGIN_X * 2 - pt(160);
}

export function mastheadAddressLines(address: string, F: ChromeFonts): number {
  return wrapAddress(address, F.display, MASTHEAD.addressSize, mastheadAddressColumnWidth()).length;
}

/** Pure geometry: the masthead's closing-hairline y, given how many lines
 * the address wraps to. `drawMasthead` calls this directly (never
 * re-derives the arithmetic) so a pre-draw sizing pass and the real draw can
 * never disagree — see DEV_PROCESS 2.4 on paired implementations drifting. */
export function mastheadBottomY(addressLines: number): number {
  const top = PAGE_HEIGHT - MARGIN_TOP;
  const logoY = top - MASTHEAD.logoHeight;
  const ruleY = logoY - MASTHEAD.ruleGap;
  const addressTop = ruleY - MASTHEAD.ruleGap;
  const addressLineHeight = MASTHEAD.addressSize * MASTHEAD.addressLineHeight;
  const lastBaselineY = addressTop - 0.92 * MASTHEAD.addressSize - (addressLines - 1) * addressLineHeight;
  const metaBaseline = lastBaselineY - addressLineHeight * 0.62 - MASTHEAD.subjectGap;
  return metaBaseline - MASTHEAD.hairlineMarginTop;
}

/** Draws the masthead; returns the hairline's y (the top of the body slot —
 * callers add their own bodyStart pad per MASTHEAD.bodyStart). */
export function drawMasthead(page: PDFPage, content: MastheadContent, F: ChromeFonts): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const top = PAGE_HEIGHT - MARGIN_TOP;

  // Top row: wordmark flush left, report type flush right, baseline-aligned
  // to the wordmark (3px bottom padding).
  const logoY = top - MASTHEAD.logoHeight;
  drawMastheadWordmark(page, left, logoY, F);
  const doctype = content.reportType.toUpperCase();
  const doctypeW = trackedWidth(F.display, doctype, MASTHEAD.doctypeSize, MASTHEAD.doctypeTracking);
  drawTrackedText(page, doctype, {
    x: right - doctypeW,
    y: logoY + MASTHEAD.doctypePaddingBottom,
    size: MASTHEAD.doctypeSize,
    font: F.display,
    color: PRINT.ink,
    trackingEm: MASTHEAD.doctypeTracking,
  });

  // Structural rule.
  const ruleY = logoY - MASTHEAD.ruleGap;
  drawHairlineRule(page, left, ruleY, right - left, PRINT.ink, MASTHEAD.ruleWeight);

  // Address (wraps to at most 2 lines) + subject meta (left); document id
  // (right), baseline-aligned to the address's FIRST line (2px padding, per
  // .ss-docid { padding-bottom: 2px }).
  const addressTop = ruleY - MASTHEAD.ruleGap;
  const addressLines = wrapAddress(content.address, F.display, MASTHEAD.addressSize, mastheadAddressColumnWidth());
  const addressLineHeight = MASTHEAD.addressSize * MASTHEAD.addressLineHeight;
  const firstBaseline = addressTop - 0.92 * MASTHEAD.addressSize;
  addressLines.forEach((line, i) => {
    page.drawText(line, { x: left, y: firstBaseline - i * addressLineHeight, size: MASTHEAD.addressSize, font: F.display, color: PRINT.ink });
  });
  // Single source of truth for the final hairline y: mastheadBottomY (used
  // by callers to size the drawing frame BEFORE this function ever runs) and
  // this draw call must never disagree, so metaBaseline is derived FROM it
  // rather than re-walking the same arithmetic a second time.
  const hairlineY = mastheadBottomY(addressLines.length);
  const metaBaseline = hairlineY + MASTHEAD.hairlineMarginTop;
  page.drawText(content.subjectMeta, { x: left, y: metaBaseline, size: MASTHEAD.subjectMetaSize, font: F.mono, color: PRINT.meta });

  const docIdLabel = (content.docIdLabel ?? "Document").toUpperCase();
  const labelW = trackedWidth(F.display, docIdLabel, MASTHEAD.docidLabelSize, MASTHEAD.docidLabelTracking);
  drawTrackedText(page, docIdLabel, {
    x: right - labelW,
    y: firstBaseline + pt(2),
    size: MASTHEAD.docidLabelSize,
    font: F.display,
    color: PRINT.label,
    trackingEm: MASTHEAD.docidLabelTracking,
  });
  const valueY = firstBaseline + pt(2) - MASTHEAD.docidLabelSize - MASTHEAD.docidGap;
  const valueW = F.mono.widthOfTextAtSize(content.docIdValue, MASTHEAD.docidValueSize);
  page.drawText(content.docIdValue, { x: right - valueW, y: valueY, size: MASTHEAD.docidValueSize, font: F.mono, color: PRINT.ink });

  // Hairline closes the masthead.
  drawHairlineRule(page, left, hairlineY, right - left, PRINT.line, MASTHEAD.hairlineWeight);
  return hairlineY;
}

// ─────────────────────────────────────────────────────────────────────────
// RUNNING HEADER — every other sheet.
// ─────────────────────────────────────────────────────────────────────────
export interface RunningHeaderContent {
  reportType: string;
  /** e.g. "Narrative" -> printed "REPORT TYPE · NARRATIVE". Omit for none. */
  sectionQualifier?: string;
  /** Pre-joined right meta, e.g. "1109 PECAN ST · 48021:34049". Truncates
   * (never wraps) if it would collide with the left side — see truncateMeta. */
  rightMeta: string;
}

/** Pure geometry: the running header's closing-rule y. Constant (no
 * content-dependent wrapping, unlike the masthead), but exported as a
 * function rather than a bare constant so callers read intent, not a magic
 * number, and so it stays next to `mastheadBottomY` as the pair a pre-draw
 * sizing pass chooses between. */
export function runningHeaderBottomY(): number {
  return PAGE_HEIGHT - MARGIN_TOP - RUNHEAD.markSize - RUNHEAD.ruleGapBelow;
}

export function drawRunningHeader(page: PDFPage, content: RunningHeaderContent, F: ChromeFonts): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const top = PAGE_HEIGHT - MARGIN_TOP;
  const rowH = RUNHEAD.markSize;
  const rowMidY = top - rowH / 2;

  drawRunningHeaderMark(page, left, top - rowH);

  const doctype = content.sectionQualifier
    ? `${content.reportType} · ${content.sectionQualifier}`.toUpperCase()
    : content.reportType.toUpperCase();
  const doctypeX = left + RUNHEAD.markSize + RUNHEAD.markGap;
  const doctypeBaseline = rowMidY - RUNHEAD.doctypeSize * 0.36;
  const rawWidth = trackedWidth(F.display, doctype, RUNHEAD.doctypeSize, RUNHEAD.doctypeTracking);
  const maxRightMetaWidth = right - (doctypeX + rawWidth) - pt(24);
  const rightMeta = truncateToWidth(content.rightMeta, F.mono, RUNHEAD.metaSize, RUNHEAD.metaTracking, Math.max(pt(60), maxRightMetaWidth));

  drawTrackedText(page, doctype, {
    x: doctypeX,
    y: doctypeBaseline,
    size: RUNHEAD.doctypeSize,
    font: F.display,
    color: PRINT.ink,
    trackingEm: RUNHEAD.doctypeTracking,
  });

  const metaW = trackedWidth(F.mono, rightMeta, RUNHEAD.metaSize, RUNHEAD.metaTracking);
  drawTrackedText(page, rightMeta, {
    x: right - metaW,
    y: rowMidY - RUNHEAD.metaSize * 0.36,
    size: RUNHEAD.metaSize,
    font: F.mono,
    color: PRINT.meta,
    trackingEm: RUNHEAD.metaTracking,
  });

  const ruleY = runningHeaderBottomY();
  drawHairlineRule(page, left, ruleY, right - left, PRINT.ink, MASTHEAD.ruleWeight);
  return ruleY;
}

/** Running-header meta truncates (never wraps) per spec. Appends an
 * ellipsis only when truncation actually happened. */
function truncateToWidth(text: string, font: PDFFont, size: number, trackingEm: number, maxWidth: number): string {
  if (trackedWidth(font, text, size, trackingEm) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && trackedWidth(font, `${out}…`, size, trackingEm) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

// ─────────────────────────────────────────────────────────────────────────
// FOOTER — every sheet. Fixed position off MARGIN_BOTTOM (report-chrome.css
// pins it with `margin-top: auto`; this codebase's sheets already reserve a
// fixed-height band above MARGIN_BOTTOM rather than measuring flex layout,
// so a fixed band here is the direct, established equivalent — see CP1).
// ─────────────────────────────────────────────────────────────────────────
export interface FooterContent {
  /** The report type's disclaimer, or the sheet's own overriding caveat —
   * EITHER WAY ending in a sheet pointer is the caller's job (the pointer is
   * drawn separately here as the right-side sheet counter, per spec, so
   * callers should NOT append "· Sheet N of M" themselves any more). */
  legalText: string;
  generatedAtIso: string;
  /** Caller-supplied deep link (share tokens etc.) — printed verbatim except
   * for a parked-host correction. Omit to get the parcelNodeId fallback. */
  liveViewUrl?: string;
  parcelNodeId: string;
  sheetNo: number;
  sheetTotal: number;
}

/** Corrects a caller-supplied link off the confirmed-parked host, or builds
 * the absolute parcelNodeId fallback when no link was supplied at all. Made
 * explicit per report-chrome README integration note 3: this frame always
 * prints an ABSOLUTE `https://smartsite.cloud/...` link, never a relative
 * one, and never the parked `smartsite.app` host either way. */
export function resolveFooterDeepLink(liveViewUrl: string | undefined, parcelNodeId: string): string {
  if (liveViewUrl && liveViewUrl.length > 0) {
    return liveViewUrl.includes(PARKED_DEEP_LINK_HOST) ? liveViewUrl.replace(PARKED_DEEP_LINK_HOST, DEEP_LINK_HOST) : liveViewUrl;
  }
  return `https://${DEEP_LINK_HOST}/?parcelNodeId=${parcelNodeId}`;
}

/** How many lines `content.legalText` will wrap to — the input `footerBandHeight`
 * needs for a pre-draw sizing pass. Uses the SAME font/size/width `drawFooter`
 * wraps with, so the two can never disagree. */
export function footerLegalLineCount(legalText: string, F: ChromeFonts): number {
  return wrapTextToWidth(legalText, F.body, FOOTER.legalSize, FOOTER.legalMaxWidth).length;
}

export function drawFooter(page: PDFPage, content: FooterContent, F: ChromeFonts): void {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const bottom = MARGIN_BOTTOM;

  const legalLines = wrapTextToWidth(content.legalText, F.body, FOOTER.legalSize, FOOTER.legalMaxWidth);
  const rowHeight = FOOTER.legalSize * FOOTER.legalLineHeight;
  const rowBottom = bottom;
  const rowTop = rowBottom + Math.max(0, legalLines.length - 1) * rowHeight;

  let ly = rowTop;
  for (const line of legalLines) {
    page.drawText(line, { x: left, y: ly - FOOTER.legalSize * 0.85, size: FOOTER.legalSize, font: F.body, color: PRINT.meta });
    ly -= rowHeight;
  }

  const timestamp = content.generatedAtIso.slice(0, 16).replace("T", " ") + "Z";
  const deepLink = resolveFooterDeepLink(content.liveViewUrl, content.parcelNodeId);
  const sheetCounter = `SHEET ${String(content.sheetNo).padStart(2, "0")} / ${content.sheetTotal}`;

  const metaY = rowTop - FOOTER.metaSize * 0.85;
  const counterW = trackedWidth(F.monoBold, sheetCounter, FOOTER.metaSize, FOOTER.metaTracking);
  const linkW = trackedWidth(F.mono, deepLink, FOOTER.metaSize, FOOTER.metaTracking);
  const tsW = trackedWidth(F.mono, timestamp, FOOTER.metaSize, FOOTER.metaTracking);

  let cx = right - counterW;
  drawTrackedText(page, sheetCounter, { x: cx, y: metaY, size: FOOTER.metaSize, font: F.monoBold, color: PRINT.ink, trackingEm: FOOTER.metaTracking });
  cx -= FOOTER.metaGap + linkW;
  drawTrackedText(page, deepLink, { x: cx, y: metaY, size: FOOTER.metaSize, font: F.mono, color: PRINT.blue, trackingEm: FOOTER.metaTracking });
  cx -= FOOTER.metaGap + tsW;
  drawTrackedText(page, timestamp, { x: cx, y: metaY, size: FOOTER.metaSize, font: F.mono, color: PRINT.meta, trackingEm: FOOTER.metaTracking });

  const hairlineY = rowTop + FOOTER.legalSize * 0.3 + FOOTER.hairlineGap;
  drawHairlineRule(page, left, hairlineY, right - left, PRINT.line, pt(1));
}

/** The footer's fixed total height (hairline through the bottom margin),
 * given how many lines the legal text wraps to — callers that need to
 * reserve body space above the footer (the site-plan sheet's legend/scale
 * bar) read this rather than re-deriving the same arithmetic. */
export function footerBandHeight(legalLineCount: number): number {
  const rowHeight = FOOTER.legalSize * FOOTER.legalLineHeight;
  const rowTop = MARGIN_BOTTOM + Math.max(0, legalLineCount - 1) * rowHeight;
  return rowTop + FOOTER.legalSize * 0.3 + FOOTER.hairlineGap;
}
