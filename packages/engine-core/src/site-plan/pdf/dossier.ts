import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFPage } from "pdf-lib";

import type { SitePlanModel } from "../site-model.js";
import { CHIP_UNAVAILABLE, countyDisplayName } from "./format.js";
import {
  RhythmCapture,
  placeRowBelowRule,
  type RhythmRow,
} from "./line-box.js";
import { SITE_PLAN_HONESTY_LINE } from "./provenance.js";
import {
  LB,
  MARGIN_BOTTOM,
  MARGIN_TOP,
  MARGIN_X,
  MarkRegistry,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  TOTAL_SHEETS,
  cityFromAddress,
  drawChipOnLineBox,
  drawFinePrint,
  drawHairlineRule,
  drawSectionHeading,
  drawTrackedText,
  emitPdfSitePlan,
  headerRuleY,
  loadFont,
  streetOnly,
  trackedWidth,
  wrapTextToWidth,
  type EmitPdfSitePlanOptions,
  type Fonts,
  type PdfSitePlanResult,
  type SheetMark,
} from "./render.js";
import { SPACE, STROKE, TOKENS, TRACKING, TYPE, pt } from "./template-tokens.js";

/**
 * PROPERTY DOSSIER assembler (2026-07-29) — ONE hand-to-client PDF, governed
 * by the same binding SHEET_STANDARD_v1.html as the site-plan renderer it
 * sits beside: tokens (template-tokens.ts), Barlow faces, §21 line-box
 * rhythm, §6 chips, §12 number form, §8 fine print. It composes:
 *
 *   1. DOSSIER COVER — verdict line (labeled as the requesting application's
 *      deterministic verdict, rendered verbatim), contents manifest,
 *      generated stamp, fine print.
 *   2. BRIEF FACTS — the request's cited facts in the summary-sheet grid
 *      language (label / value / per-fact source · vintage), grouped by
 *      section; honest UNAVAILABLE chips for absent values. NOTHING is
 *      fabricated: the sheet renders exactly what the request carries.
 *   3. AI RESEARCH SUMMARY (when present) — user-saved AI content, visually
 *      distinct via a muted rule + suppressed label; no new colors.
 *   4. OWNER NOTES (when present) — plain wrapped text.
 *   5. APPENDED SITE-PLAN SHEETS — the SAME 3-sheet site plan
 *      `emitPdfSitePlan` produces, renumbered "Sheet N of TOTAL" across the
 *      whole document via the render.ts numbering seam. A missing site-plan
 *      capability NEVER fails the export — the dossier pages still emit with
 *      an honest note.
 *
 * All user-supplied text is sanitized server-side (control characters
 * stripped, lengths capped, glyphs outside the embedded Barlow coverage
 * dropped) — see `sanitizeDossierContent`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Request-shaped content (mirrors the dossier-export route contract).
// ─────────────────────────────────────────────────────────────────────────
export interface DossierBriefFactInput {
  label: string;
  value?: string;
  source?: string;
  vintage?: string;
}

export interface DossierBriefSectionInput {
  id: string;
  title: string;
  facts: DossierBriefFactInput[];
}

export interface DossierContentInput {
  parcelNodeId: string;
  address?: string;
  countyName?: string;
  /** The requesting app's deterministic verdict — rendered VERBATIM, labeled. */
  verdictLine?: string;
  brief?: { sections: DossierBriefSectionInput[] };
  chatSummary?: { summary: string; savedAt: string; disclaimer?: string };
  notes?: string;
}

/** Server-side caps (the route's zod schema caps requests earlier; these hold
 * even for direct in-process callers). */
export const DOSSIER_CAPS = {
  address: 200,
  countyName: 120,
  verdictLine: 400,
  sectionId: 64,
  sectionTitle: 160,
  factLabel: 160,
  factValue: 400,
  factSource: 240,
  factVintage: 80,
  chatSummary: 12000,
  chatSavedAt: 64,
  chatDisclaimer: 600,
  notes: 4000,
  maxSections: 16,
  maxFactsPerSection: 60,
} as const;

// Standing dossier lines (§8 family). One spelling each, everywhere.
export const DOSSIER_KICKER = "PROPERTY DOSSIER";
export const DOSSIER_VERDICT_HEADING = "VERDICT";
export const DOSSIER_VERDICT_QUALIFIER =
  "The requesting application's deterministic verdict, rendered verbatim.";
export const DOSSIER_VERDICT_ABSENT_REASON = "No verdict line was supplied for this export.";
export const DOSSIER_FACT_VALUE_ABSENT_REASON = "No value carried in the brief for this fact.";
export const DOSSIER_NOT_LEGAL_ADVICE =
  "Informational summary only; not legal, survey, or engineering advice.";
export const DOSSIER_USER_CONTENT_DISCLOSURE =
  "AI summary and notes are user-supplied content, rendered verbatim and not verified by the engine.";
export const DOSSIER_COMPILATION_LINE =
  "Compiled from the property record carried by the requesting application; each brief fact carries its own source and vintage.";
export const DOSSIER_AI_CONTENT_LABEL = "AI-GENERATED CONTENT · SAVED BY THE USER · NOT VERIFIED";
export const DOSSIER_NOTES_HEADING = "OWNER NOTES";
export const DOSSIER_SITE_PLAN_ABSENT_NOTE = "Site-plan sheets are not appended";

// ─────────────────────────────────────────────────────────────────────────
// Sanitization: control characters stripped, glyphs outside the vendored
// Barlow coverage dropped, lengths capped with a visible ellipsis. Never
// throws; never invents content.
// ─────────────────────────────────────────────────────────────────────────
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Conservative glyph-safe charset for the embedded Barlow faces: ASCII,
// Latin-1/Latin-A, general punctuation, common signs. Everything else
// (emoji, surrogates, exotic scripts) is dropped rather than crashing the
// font encoder or drawing tofu.
const GLYPH_UNSAFE_RE = /[^\u0020-\u007E\u00A0-\u017F\u2010-\u2027\u2030-\u203E\u20AC\n]/g;

export function sanitizeDossierText(
  raw: string | undefined,
  maxLen: number,
  opts: { multiline?: boolean } = {},
): string | undefined {
  if (raw == null) return undefined;
  let s = raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  if (!opts.multiline) s = s.replace(/\n/g, " ");
  s = s.replace(CONTROL_CHARS_RE, "").replace(GLYPH_UNSAFE_RE, "");
  if (opts.multiline) {
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s
      .split("\n")
      .map((line) => line.replace(/[ ]{2,}/g, " ").trimEnd())
      .join("\n")
      .trim();
  } else {
    s = s.replace(/\s{2,}/g, " ").trim();
  }
  if (s.length > maxLen) s = `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  return s.length > 0 ? s : undefined;
}

/** The sanitized, capped dossier content the assembler actually renders. */
export interface DossierContent {
  parcelNodeId: string;
  address?: string;
  countyName?: string;
  verdictLine?: string;
  sections: Array<{ id: string; title: string; facts: Array<Required<Pick<DossierBriefFactInput, "label">> & Omit<DossierBriefFactInput, "label">> }>;
  chatSummary?: { summary: string; savedAt: string; disclaimer?: string };
  notes?: string;
}

export function sanitizeDossierContent(input: DossierContentInput): DossierContent {
  const C = DOSSIER_CAPS;
  const sections = (input.brief?.sections ?? [])
    .slice(0, C.maxSections)
    .map((section, si) => ({
      id: sanitizeDossierText(section.id, C.sectionId) ?? `section-${si + 1}`,
      title: sanitizeDossierText(section.title, C.sectionTitle) ?? `SECTION ${si + 1}`,
      facts: (section.facts ?? [])
        .slice(0, C.maxFactsPerSection)
        .map((fact) => ({
          label: sanitizeDossierText(fact.label, C.factLabel) ?? "(unlabeled fact)",
          value: sanitizeDossierText(fact.value, C.factValue),
          source: sanitizeDossierText(fact.source, C.factSource),
          vintage: sanitizeDossierText(fact.vintage, C.factVintage),
        })),
    }))
    .filter((section) => section.facts.length > 0);

  const chatSummaryText = sanitizeDossierText(input.chatSummary?.summary, C.chatSummary, {
    multiline: true,
  });
  const notes = sanitizeDossierText(input.notes, C.notes, { multiline: true });

  return {
    parcelNodeId: input.parcelNodeId,
    address: sanitizeDossierText(input.address, C.address),
    countyName: sanitizeDossierText(input.countyName, C.countyName),
    verdictLine: sanitizeDossierText(input.verdictLine, C.verdictLine),
    sections,
    chatSummary:
      input.chatSummary && chatSummaryText
        ? {
            summary: chatSummaryText,
            savedAt: sanitizeDossierText(input.chatSummary.savedAt, C.chatSavedAt) ?? "",
            disclaimer: sanitizeDossierText(input.chatSummary.disclaimer, C.chatDisclaimer),
          }
        : undefined,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Emit options + result.
// ─────────────────────────────────────────────────────────────────────────
export interface EmitPdfDossierOptions {
  /** The parcel's site-plan model (same composition path as the site-plan
   * export). When present, the 3 site-plan sheets are appended and the whole
   * document renumbers. */
  sitePlan?: { model: SitePlanModel; aerial?: EmitPdfSitePlanOptions["aerial"] };
  /** Honest reason the site plan could not be authored (rendered on the
   * cover fine print). Ignored when `sitePlan` is present. */
  sitePlanUnavailableReason?: string;
  /** Test seam for a stable generated stamp. Defaults to now. */
  generatedAtIso?: string;
}

export interface PdfDossierResult {
  bytes: Uint8Array;
  /** Total pages of the assembled document (dossier pages + appended sheets). */
  pageCount: number;
  /** Dossier-authored pages (cover + brief + chat + notes), excluding appended sheets. */
  dossierPageCount: number;
  sitePlanAppended: boolean;
  sitePlanUnavailableReason?: string;
  verdictIncluded: boolean;
  briefSectionCount: number;
  briefFactCount: number;
  chatSummaryIncluded: boolean;
  notesIncluded: boolean;
  fontNote: string;
  /** §14/§21 capture seams for the DOSSIER pages (absolute page numbers). */
  marks: ReadonlyArray<SheetMark>;
  rhythm: ReadonlyArray<RhythmRow>;
  /** The appended site plan's own capture seams (local sheet space 1–3). */
  sitePlan?: Omit<PdfSitePlanResult, "bytes">;
}

// ─────────────────────────────────────────────────────────────────────────
// Page plan (measure pass): totals must be known before any fine print or
// "SHEET N OF TOTAL" eyebrow is drawn, so pagination is computed first with
// the same wrap + line-box math the draw pass uses.
// ─────────────────────────────────────────────────────────────────────────
interface PlannedFactRow {
  label: string;
  valueLines: string[];
  greyLines: string[];
  chip: boolean;
}

interface PlannedGroup {
  heading: string;
  rows: PlannedFactRow[];
}

type PlannedPage =
  | { kind: "cover" }
  | { kind: "brief"; groups: PlannedGroup[] }
  | { kind: "chat"; lines: string[]; first: boolean }
  | { kind: "notes"; lines: string[]; first: boolean };

const LABEL_COL = pt(200);
/** Fine-print reserve: 9 wrapped lines + a space-4 gap. Dossier fine print
 * can carry a user disclaimer (≤600 chars) on top of the standing lines, so
 * the reserve is deeper than the site plan's 6-line band. */
function contentFloorY(): number {
  return MARGIN_BOTTOM + LB.finePrint.lineBoxHeight * 9 + pt(SPACE.s4);
}

function sectionHeadingCost(): number {
  return pt(SPACE.s6) + LB.groupHeading.lineBoxHeight + pt(SPACE.s2);
}

function rowCost(lines: number): number {
  return pt(SPACE.s2) + lines * LB.kvRow.lineBoxHeight + pt(SPACE.s2);
}

function planFactRow(fact: DossierContent["sections"][number]["facts"][number], F: Fonts): PlannedFactRow {
  const right = PAGE_WIDTH - MARGIN_X;
  const valueX = MARGIN_X + LABEL_COL;
  const greyText = [fact.source, fact.vintage].filter((p): p is string => !!p).join(" · ");
  if (!fact.value) {
    const chipW =
      trackedWidth(F.displayMedium, CHIP_UNAVAILABLE, TYPE.chip, TRACKING.chip) + pt(14) + pt(8);
    const reason = greyText
      ? `${DOSSIER_FACT_VALUE_ABSENT_REASON} ${greyText}`
      : DOSSIER_FACT_VALUE_ABSENT_REASON;
    return {
      label: fact.label,
      valueLines: [],
      greyLines: wrapTextToWidth(reason, F.body, pt(12), Math.max(right - valueX - chipW, pt(120))),
      chip: true,
    };
  }
  const valueLines = wrapTextToWidth(fact.value, F.body, TYPE.rowValue, right - valueX);
  const greyLines = greyText
    ? wrapTextToWidth(greyText, F.body, TYPE.rowQualifier, right - valueX)
    : [];
  return { label: fact.label, valueLines, greyLines, chip: false };
}

function planBriefPages(content: DossierContent, F: Fonts): PlannedPage[] {
  if (content.sections.length === 0) return [];
  const pages: PlannedPage[] = [];
  const floor = contentFloorY();
  let groups: PlannedGroup[] = [];
  let current: PlannedGroup | null = null;
  let cursor = headerRuleY();

  const flushPage = () => {
    if (current && current.rows.length > 0) groups.push(current);
    if (groups.length > 0) pages.push({ kind: "brief", groups });
    groups = [];
    current = null;
    cursor = headerRuleY();
  };

  for (const section of content.sections) {
    let heading = section.title.toUpperCase();
    if (cursor - sectionHeadingCost() - rowCost(1) < floor) flushPage();
    current = { heading, rows: [] };
    cursor -= sectionHeadingCost();
    for (const fact of section.facts) {
      const row = planFactRow(fact, F);
      const lines = Math.max(1, row.valueLines.length + row.greyLines.length, row.chip ? Math.max(1, row.greyLines.length) : 0);
      if (cursor - rowCost(lines) < floor) {
        // Page break mid-section: close this page, reopen the section as CONTINUED.
        groups.push(current);
        pages.push({ kind: "brief", groups });
        groups = [];
        heading = `${section.title.toUpperCase()} · CONTINUED`;
        current = { heading, rows: [] };
        cursor = headerRuleY() - sectionHeadingCost();
      }
      current.rows.push(row);
      cursor -= rowCost(lines);
    }
    groups.push(current);
    current = null;
  }
  if (groups.length > 0) pages.push({ kind: "brief", groups });
  return pages;
}

/** Wrap a multi-paragraph user text into drawable lines (blank line between
 * paragraphs preserved as an empty string). */
function wrapUserText(text: string, F: Fonts): string[] {
  const width = PAGE_WIDTH - MARGIN_X * 2;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim().length === 0) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(...wrapTextToWidth(para, F.body, TYPE.rowValue, width));
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function planTextPages(kind: "chat" | "notes", lines: string[]): PlannedPage[] {
  const floor = contentFloorY();
  // Heading + (for chat) AI label + muted rule sit above the text block.
  const chromeCost = sectionHeadingCost() + (kind === "chat" ? LB.subline.lineBoxHeight + pt(SPACE.s3) : 0);
  const firstCapacity = Math.floor((headerRuleY() - chromeCost - pt(SPACE.s2) - floor) / LB.kvRow.lineBoxHeight);
  const contCapacity = firstCapacity;
  const pages: PlannedPage[] = [];
  let rest = lines;
  let first = true;
  while (rest.length > 0 || first) {
    const cap = Math.max(1, first ? firstCapacity : contCapacity);
    pages.push({ kind, lines: rest.slice(0, cap), first });
    rest = rest.slice(cap);
    first = false;
    if (rest.length === 0) break;
  }
  return pages;
}

// ─────────────────────────────────────────────────────────────────────────
// Draw helpers (Standard §2 header adapted to request-carried descriptors —
// the dossier has no SitePlanModel for its own pages; absent fields take the
// honest §2 treatment, never a placeholder).
// ─────────────────────────────────────────────────────────────────────────
const INK = TOKENS.text;
const ACCENT = TOKENS.accent;

function drawDossierHeader(
  page: PDFPage,
  content: DossierContent,
  F: Fonts,
  eyebrow: string,
  rightMeta: string[],
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const top = PAGE_HEIGHT - MARGIN_TOP;

  drawTrackedText(page, eyebrow, {
    x: left,
    y: top - LB.eyebrow.baselineFromBoxTop,
    size: TYPE.eyebrow,
    font: F.display,
    color: ACCENT,
    trackingEm: TRACKING.eyebrow,
  });

  const titleBoxTop = top - LB.eyebrow.lineBoxHeight - pt(2);
  const street = streetOnly(content.address);
  const big = (street ?? `PARCEL ${content.parcelNodeId}`).toUpperCase();
  page.drawText(big, {
    x: left,
    y: titleBoxTop - LB.address.baselineFromBoxTop,
    size: TYPE.address,
    font: F.display,
    color: INK,
  });
  if (!street) {
    const bigW = F.display.widthOfTextAtSize(big, TYPE.address);
    drawChipOnLineBox(page, "NO ADDRESS", left + bigW + pt(10), titleBoxTop, LB.address, "solid", F);
  }

  const metaBoxTop = titleBoxTop - LB.address.lineBoxHeight - pt(2);
  const metaParts = [
    cityFromAddress(content.address),
    `Parcel ${content.parcelNodeId}`,
    countyDisplayName(content.countyName),
  ].filter((p): p is string => !!p);
  page.drawText(metaParts.join("  ·  "), {
    x: left,
    y: metaBoxTop - LB.subline.baselineFromBoxTop,
    size: TYPE.subline,
    font: F.body,
    color: TOKENS.neutral700,
  });

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

  const ruleY = headerRuleY();
  drawHairlineRule(page, left, ruleY, right - left);
  return ruleY;
}

function drawKvRow(
  page: PDFPage,
  pageNo: number,
  row: { label: string; value?: string; chip?: boolean; grey?: string },
  ruleY: number,
  F: Fonts,
  rhythm: RhythmCapture,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const valueX = left + LABEL_COL;
  let vx = valueX;
  if (row.chip) {
    vx += trackedWidth(F.displayMedium, CHIP_UNAVAILABLE, TYPE.chip, TRACKING.chip) + pt(14) + pt(8);
  }
  if (row.value) vx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
  const greySize = row.chip ? pt(12) : TYPE.rowQualifier;
  const greyLines = row.grey
    ? wrapTextToWidth(row.grey, F.body, greySize, Math.max(right - vx, pt(120)))
    : [];
  const lines = Math.max(1, greyLines.length);
  const placed = placeRowBelowRule(ruleY, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2), lines });
  page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  page.drawText(row.label, { x: left, y: placed.baselines[0]!, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
  let dx = valueX;
  if (row.chip) {
    dx = drawChipOnLineBox(page, CHIP_UNAVAILABLE, dx, placed.boxTopY, LB.kvRow, "solid", F) + pt(8);
  }
  if (row.value) {
    page.drawText(row.value, { x: dx, y: placed.baselines[0]!, size: TYPE.rowValue, font: F.body, color: INK });
    dx += F.body.widthOfTextAtSize(row.value, TYPE.rowValue) + pt(8);
  }
  greyLines.forEach((line, li) => {
    page.drawText(line, {
      x: li === 0 ? dx : valueX,
      y: placed.baselines[li]!,
      size: greySize,
      font: F.body,
      color: row.chip ? TOKENS.neutral700 : TOKENS.neutral600,
    });
  });
  rhythm.row(pageNo, "kv-row", placed, LB.kvRow, pt(SPACE.s2));
  return placed.nextRuleY;
}

function drawBriefFactRow(
  page: PDFPage,
  pageNo: number,
  row: PlannedFactRow,
  ruleY: number,
  F: Fonts,
  rhythm: RhythmCapture,
): number {
  const left = MARGIN_X;
  const right = PAGE_WIDTH - MARGIN_X;
  const valueX = left + LABEL_COL;
  const lines = Math.max(1, row.valueLines.length + row.greyLines.length, row.chip ? Math.max(1, row.greyLines.length) : 0);
  const placed = placeRowBelowRule(ruleY, LB.kvRow, { padTop: pt(SPACE.s2), padBottom: pt(SPACE.s2), lines });
  page.drawLine({ start: { x: left, y: ruleY }, end: { x: right, y: ruleY }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
  page.drawText(row.label, { x: left, y: placed.baselines[0]!, size: TYPE.rowLabel, font: F.body, color: TOKENS.neutral600 });
  if (row.chip) {
    const chipEnd = drawChipOnLineBox(page, CHIP_UNAVAILABLE, valueX, placed.boxTopY, LB.kvRow, "solid", F) + pt(8);
    row.greyLines.forEach((line, li) => {
      page.drawText(line, {
        x: li === 0 ? chipEnd : valueX,
        y: placed.baselines[li]!,
        size: pt(12),
        font: F.body,
        color: TOKENS.neutral700,
      });
    });
  } else {
    row.valueLines.forEach((line, li) => {
      page.drawText(line, { x: valueX, y: placed.baselines[li]!, size: TYPE.rowValue, font: F.body, color: INK });
    });
    row.greyLines.forEach((line, li) => {
      page.drawText(line, {
        x: valueX,
        y: placed.baselines[row.valueLines.length + li]!,
        size: TYPE.rowQualifier,
        font: F.body,
        color: TOKENS.neutral600,
      });
    });
  }
  rhythm.row(pageNo, "kv-row", placed, LB.kvRow, pt(SPACE.s2));
  return placed.nextRuleY;
}

// ─────────────────────────────────────────────────────────────────────────
// Fine print (§8, dossier family).
// ─────────────────────────────────────────────────────────────────────────
interface DossierFlags {
  verdictIncluded: boolean;
  userContent: boolean;
  sitePlanAppended: boolean;
  sitePlanUnavailableReason?: string;
}

function dossierFinePrint(
  pageKind: PlannedPage["kind"],
  sheetNo: number,
  total: number,
  flags: DossierFlags,
  chatDisclaimer?: string,
): string {
  const sentences: string[] = [DOSSIER_COMPILATION_LINE, SITE_PLAN_HONESTY_LINE, DOSSIER_NOT_LEGAL_ADVICE];
  if (pageKind === "cover" && flags.verdictIncluded) {
    sentences.push(DOSSIER_VERDICT_QUALIFIER);
  }
  if (flags.userContent && (pageKind === "cover" || pageKind === "chat" || pageKind === "notes")) {
    sentences.push(DOSSIER_USER_CONTENT_DISCLOSURE);
  }
  if (pageKind === "chat" && chatDisclaimer) {
    sentences.push(chatDisclaimer.endsWith(".") ? chatDisclaimer : `${chatDisclaimer}.`);
  }
  if (pageKind === "cover" && !flags.sitePlanAppended) {
    sentences.push(
      `${DOSSIER_SITE_PLAN_ABSENT_NOTE}: ${flags.sitePlanUnavailableReason ?? "site-plan authoring was unavailable for this parcel"}.`,
    );
  }
  sentences.push(`· Sheet ${sheetNo} of ${total}`);
  return sentences.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────
// The assembler.
// ─────────────────────────────────────────────────────────────────────────
export async function emitPdfDossier(
  input: DossierContentInput,
  options: EmitPdfDossierOptions = {},
): Promise<PdfDossierResult> {
  const content = sanitizeDossierContent(input);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const F: Fonts = {
    body: await doc.embedFont(loadFont("Barlow-Regular.ttf"), { subset: false }),
    bodyMedium: await doc.embedFont(loadFont("Barlow-Medium.ttf"), { subset: false }),
    display: await doc.embedFont(loadFont("BarlowCondensed-SemiBold.ttf"), { subset: false }),
    displayMedium: await doc.embedFont(loadFont("BarlowCondensed-Medium.ttf"), { subset: false }),
  };

  const factCount = content.sections.reduce((n, s) => n + s.facts.length, 0);

  // Measure pass: plan the dossier pages. Totals must be known before any
  // eyebrow or fine print draws, and before the appended site plan renders
  // (its renumbering seam needs startAt/total).
  const plannedPages: PlannedPage[] = [{ kind: "cover" }];
  plannedPages.push(...planBriefPages(content, F));
  const chatLines = content.chatSummary ? wrapUserText(content.chatSummary.summary, F) : [];
  if (content.chatSummary && chatLines.length > 0) {
    plannedPages.push(...planTextPages("chat", chatLines));
  }
  const notesLines = content.notes ? wrapUserText(content.notes, F) : [];
  if (content.notes && notesLines.length > 0) {
    plannedPages.push(...planTextPages("notes", notesLines));
  }
  const dossierPageCount = plannedPages.length;
  const sitePlanSheets = options.sitePlan ? TOTAL_SHEETS : 0;
  const total = dossierPageCount + sitePlanSheets;

  // Kick off the appended site plan (renumbered) now that totals are known.
  const sitePlanRender: Promise<PdfSitePlanResult> | null = options.sitePlan
    ? emitPdfSitePlan(options.sitePlan.model, {
        aerial: options.sitePlan.aerial,
        numbering: { startAt: dossierPageCount + 1, total },
      })
    : null;

  const flags: DossierFlags = {
    verdictIncluded: !!content.verdictLine,
    userContent: !!content.chatSummary || !!content.notes,
    sitePlanAppended: !!options.sitePlan,
    sitePlanUnavailableReason: options.sitePlan ? undefined : options.sitePlanUnavailableReason,
  };

  const marks = new MarkRegistry();
  const rhythm = new RhythmCapture();
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const stamp = `generated ${generatedAt.slice(0, 16).replace("T", " ")}Z`;
  const docId = `PD-${content.parcelNodeId.replace(/:/g, "-")}`;
  const rightMeta = [docId, content.parcelNodeId];

  const chatPages = plannedPages.filter((p) => p.kind === "chat").length;
  const notesPages = plannedPages.filter((p) => p.kind === "notes").length;
  const briefPages = plannedPages.filter((p) => p.kind === "brief").length;

  plannedPages.forEach((planned, i) => {
    const pageNo = i + 1;
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    const eyebrowByKind: Record<PlannedPage["kind"], string> = {
      cover: DOSSIER_KICKER,
      brief: "BRIEF FACTS",
      chat: "AI RESEARCH SUMMARY",
      notes: DOSSIER_NOTES_HEADING,
    };
    const ruleY = drawDossierHeader(
      page,
      content,
      F,
      `${eyebrowByKind[planned.kind]} · SHEET ${pageNo} OF ${total}`,
      rightMeta,
    );
    marks.once(pageNo, "dossier-header", planned.kind);

    if (planned.kind === "cover") {
      // VERDICT — prominent, labeled, verbatim (§2 stat-value voice).
      let cursor = drawSectionHeading(page, pageNo, DOSSIER_VERDICT_HEADING, ruleY, F, rhythm);
      if (content.verdictLine) {
        const verdictWidth = PAGE_WIDTH - MARGIN_X * 2;
        const verdictLines = wrapTextToWidth(content.verdictLine, F.display, TYPE.statValue, verdictWidth);
        const placed = placeRowBelowRule(cursor, LB.statValue, {
          padTop: pt(SPACE.s2),
          padBottom: pt(SPACE.s2),
          lines: verdictLines.length,
        });
        page.drawLine({ start: { x: MARGIN_X, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_X, y: cursor }, thickness: STROKE.rowRule, color: TOKENS.neutral300 });
        verdictLines.forEach((line, li) => {
          page.drawText(line, {
            x: MARGIN_X,
            y: placed.baselines[li]!,
            size: TYPE.statValue,
            font: F.display,
            color: TOKENS.accent700,
          });
        });
        rhythm.row(pageNo, "verdict-line", placed, LB.statValue, pt(SPACE.s2));
        marks.once(pageNo, "verdict", "line");
        cursor = placed.nextRuleY;
        // One grey qualifier under the verdict (§7 one-qualifier rule).
        const qual = placeRowBelowRule(cursor, LB.subline, { padTop: pt(SPACE.s1), padBottom: pt(SPACE.s2) });
        page.drawText(DOSSIER_VERDICT_QUALIFIER, {
          x: MARGIN_X,
          y: qual.baselines[0]!,
          size: TYPE.rowQualifier,
          font: F.body,
          color: TOKENS.neutral600,
        });
        rhythm.row(pageNo, "verdict-qualifier", qual, LB.subline, pt(SPACE.s1), { ruleDrawn: false });
        cursor = qual.nextRuleY;
      } else {
        cursor = drawKvRow(
          page,
          pageNo,
          { label: "Verdict", chip: true, grey: DOSSIER_VERDICT_ABSENT_REASON },
          cursor,
          F,
          rhythm,
        );
        marks.once(pageNo, "verdict", "unavailable");
      }

      // CONTENTS manifest — honest per part.
      let contentsRule = drawSectionHeading(page, pageNo, "CONTENTS", cursor, F, rhythm);
      contentsRule = drawKvRow(
        page,
        pageNo,
        content.sections.length > 0
          ? {
              label: "Brief facts",
              value: `${factCount} fact${factCount === 1 ? "" : "s"} in ${content.sections.length} section${content.sections.length === 1 ? "" : "s"}`,
              grey: briefPages === 1 ? "sheet 2" : `sheets 2–${1 + briefPages}`,
            }
          : { label: "Brief facts", chip: true, grey: "No brief facts were carried in the request." },
        contentsRule,
        F,
        rhythm,
      );
      contentsRule = drawKvRow(
        page,
        pageNo,
        content.chatSummary
          ? {
              label: "AI research summary",
              value: content.chatSummary.savedAt ? `saved ${content.chatSummary.savedAt.slice(0, 10)}` : "included",
              grey: "user-saved AI content, rendered verbatim",
            }
          : { label: "AI research summary", chip: true, grey: "No saved AI summary was carried in the request." },
        contentsRule,
        F,
        rhythm,
      );
      contentsRule = drawKvRow(
        page,
        pageNo,
        content.notes
          ? { label: "Owner notes", value: "included", grey: "user-supplied text, rendered verbatim" }
          : { label: "Owner notes", chip: true, grey: "No owner notes were carried in the request." },
        contentsRule,
        F,
        rhythm,
      );
      contentsRule = drawKvRow(
        page,
        pageNo,
        options.sitePlan
          ? {
              label: "Site-plan sheets",
              value: `sheets ${dossierPageCount + 1}–${total} appended`,
              grey: "drawing · summary · aerial context",
            }
          : {
              label: "Site-plan sheets",
              chip: true,
              grey: "Not appended; see the fine print for the reason.",
            },
        contentsRule,
        F,
        rhythm,
      );
      page.drawLine({ start: { x: MARGIN_X, y: contentsRule }, end: { x: PAGE_WIDTH - MARGIN_X, y: contentsRule }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });

      // Generated stamp above the fine print, right-aligned (§9 voice).
      const stampLine = `${docId} · ${stamp}`;
      page.drawText(stampLine, {
        x: PAGE_WIDTH - MARGIN_X - F.body.widthOfTextAtSize(stampLine, TYPE.scaleRatioLine),
        y: contentFloorY() + pt(4),
        size: TYPE.scaleRatioLine,
        font: F.body,
        color: TOKENS.neutral600,
      });
      marks.once(pageNo, "generated-stamp", "stamp");
    }

    if (planned.kind === "brief") {
      let cursor = ruleY;
      for (const group of planned.groups) {
        let rowRule = drawSectionHeading(page, pageNo, group.heading, cursor, F, rhythm);
        for (const row of group.rows) {
          rowRule = drawBriefFactRow(page, pageNo, row, rowRule, F, rhythm);
        }
        page.drawLine({ start: { x: MARGIN_X, y: rowRule }, end: { x: PAGE_WIDTH - MARGIN_X, y: rowRule }, thickness: STROKE.rowRule, color: TOKENS.neutral200 });
        cursor = rowRule;
      }
    }

    if (planned.kind === "chat" || planned.kind === "notes") {
      const heading =
        planned.kind === "chat"
          ? `AI RESEARCH SUMMARY · SAVED ${(content.chatSummary?.savedAt ?? "").slice(0, 10) || "DATE UNAVAILABLE"}${planned.first ? "" : " · CONTINUED"}`
          : `${DOSSIER_NOTES_HEADING}${planned.first ? "" : " · CONTINUED"}`;
      let cursor = drawSectionHeading(page, pageNo, heading, ruleY, F, rhythm);
      if (planned.kind === "chat") {
        // Visually distinct AI content: suppressed tracked label + muted rule
        // (no new colors — §6/§20 vocabulary only).
        const labelPlaced = placeRowBelowRule(cursor, LB.subline, { padTop: pt(SPACE.s1), padBottom: pt(SPACE.s1) });
        drawTrackedText(page, DOSSIER_AI_CONTENT_LABEL, {
          x: MARGIN_X,
          y: labelPlaced.baselines[0]!,
          size: TYPE.statLabel,
          font: F.body,
          color: TOKENS.neutral500,
          trackingEm: TRACKING.statLabel,
        });
        rhythm.row(pageNo, "ai-content-label", labelPlaced, LB.subline, pt(SPACE.s1), { ruleDrawn: false });
        cursor = labelPlaced.nextRuleY;
        drawHairlineRule(page, MARGIN_X, cursor, PAGE_WIDTH - MARGIN_X * 2, TOKENS.neutral300, 0.7);
        marks.once(pageNo, "ai-muted-rule", "rule");
      }
      const textPlaced = placeRowBelowRule(cursor, LB.kvRow, {
        padTop: pt(SPACE.s2),
        padBottom: pt(SPACE.s2),
        lines: Math.max(1, planned.lines.length),
      });
      planned.lines.forEach((line, li) => {
        if (line.length === 0) return; // paragraph gap keeps its line box
        page.drawText(line, {
          x: MARGIN_X,
          y: textPlaced.baselines[li]!,
          size: TYPE.rowValue,
          font: F.body,
          color: planned.kind === "chat" ? TOKENS.neutral800 : INK,
        });
      });
      rhythm.row(pageNo, planned.kind === "chat" ? "chat-text" : "notes-text", textPlaced, LB.kvRow, pt(SPACE.s2), {
        ruleDrawn: planned.kind === "chat",
      });
    }

    drawFinePrint(
      page,
      pageNo,
      dossierFinePrint(planned.kind, pageNo, total, flags, planned.kind === "chat" ? content.chatSummary?.disclaimer : undefined),
      F,
      marks,
    );
  });

  // Append the site-plan sheets (renumbered by the render-side seam).
  let sitePlanResult: PdfSitePlanResult | undefined;
  if (sitePlanRender) {
    sitePlanResult = await sitePlanRender;
    const spDoc = await PDFDocument.load(sitePlanResult.bytes);
    const copied = await doc.copyPages(spDoc, spDoc.getPageIndices());
    for (const p of copied) doc.addPage(p);
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    pageCount: doc.getPageCount(),
    dossierPageCount,
    sitePlanAppended: !!sitePlanResult,
    sitePlanUnavailableReason: flags.sitePlanUnavailableReason,
    verdictIncluded: flags.verdictIncluded,
    briefSectionCount: content.sections.length,
    briefFactCount: factCount,
    chatSummaryIncluded: !!content.chatSummary && chatPages > 0,
    notesIncluded: !!content.notes && notesPages > 0,
    fontNote: "Rendered with embedded Barlow (Regular/Medium) and Barlow Condensed (Medium/SemiBold), OFL.",
    marks: marks.marks,
    rhythm: rhythm.rows,
    ...(sitePlanResult
      ? {
          sitePlan: {
            pageCount: sitePlanResult.pageCount,
            fontNote: sitePlanResult.fontNote,
            aerial: sitePlanResult.aerial,
            marks: sitePlanResult.marks,
            rhythm: sitePlanResult.rhythm,
            page1Frame: sitePlanResult.page1Frame,
          },
        }
      : {}),
  };
}
