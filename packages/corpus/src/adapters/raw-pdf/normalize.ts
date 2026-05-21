/**
 * Raw-PDF NormalizedBlock walker — text-pattern-driven heading
 * inference.
 *
 * Born-digital PDFs (and OCR outputs alike) lack the explicit DOM
 * structure that Stream 1A's HTML adapters get from cheerio. The
 * structural signal lives in the body text itself: municipal codes use
 * highly conventional heading lines — CHAPTER N:, ARTICLE N.M, SEC.
 * N.M.NNN — that this walker recognizes and promotes to NormalizedBlock
 * heading entries.
 *
 * Patterns chosen to match the Bastrop Building Block (B3) Code (the
 * first raw-PDF jurisdiction onboarded per 51 §Stream 1A) and the
 * substrate of cities that adopt the same labeling convention. Each
 * pattern is anchored to start-of-line so accidental occurrences inside
 * body prose ("see Sec. 5.04 above") stay as paragraph cross-references.
 */

import type {
  NormalizedBlock,
} from "../types.js";
import type { PdfPageText } from "./pdfjs-extractor.js";

const CHAPTER_RE = /^CHAPTER\s+([\w.-]+)\s*[:\-—–]?\s*(.*?)\s*$/i;
const ARTICLE_RE = /^ARTICLE\s+([\w.-]+)(?:\s+(.*?))?\s*$/i;
// Title may be omitted when the source typesets it on the next line
// (Bastrop County Subdivision Regulations: bare "SECTION X" followed by
// the title line). The multi-line continuation merge below recovers
// the title from the next typeset line.
const SECTION_RE = /^(?:SEC\.?|SECTION)\s+([\w.-]+)(?:\s+(.*?))?\s*$/i;
// Alpha-only top-level subsection — "(a)", "(b)", "(z)". Numeric-only
// nested subsections fall through to NESTED_SUBSECTION_RE.
const SUBSECTION_RE = /^\(([a-z]+)\)\s+(.+)$/i;
const NESTED_SUBSECTION_RE = /^\((\d+)\)\s+(.+)$/;

/** Strip trailing punctuation from a captured cross-reference label. */
function trimRefLabel(s: string): string {
  return s.replace(/[.,;:!?]+$/, "");
}

// Cross-reference patterns common in B3 + Municode prose. SECTION_REF_RE
// captures "Sec. 5.4.001", "Section 5.4.001", "§ 5.04(b)". ARTICLE_REF_RE
// captures "Article 4.2". CHAPTER_REF_RE captures "Chapter 6". Labels
// must start with a digit so prose like "this Article shall" doesn't
// false-match as a reference to a section named "shall".
const SECTION_REF_RE = /(?:§|Sec(?:tion)?\.?)\s*(\d[\w.()-]*)/gi;
const ARTICLE_REF_RE = /\bArticle\s+(\d[\w.-]*)/gi;
const CHAPTER_REF_RE = /\bChapter\s+(\d[\w.-]*)/gi;

const REFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
}> = [
  { pattern: /\bnotwithstanding\b/i, referenceType: "notwithstanding" },
  { pattern: /\bsubject to\b/i, referenceType: "subject-to" },
  { pattern: /\bas defined in\b/i, referenceType: "as-defined-in" },
  { pattern: /\bamends?\b/i, referenceType: "amends" },
  { pattern: /\bsupersedes?\b/i, referenceType: "supersedes" },
  { pattern: /\bsee\b/i, referenceType: "see" },
];

function inferReferenceType(text: string): "see" | "notwithstanding" | "subject-to" | "as-defined-in" | "amends" | "supersedes" | "unknown" {
  for (const { pattern, referenceType } of REFERENCE_PATTERNS) {
    if (pattern.test(text)) return referenceType;
  }
  return "unknown";
}

export interface PdfNormalizeOptions {
  /**
   * Lines matching this RegExp are skipped (header/footer noise like
   * page numbers, running titles). Caller supplies; the adapter's
   * default suppresses common B3 boilerplate.
   */
  ignoreLineRegex?: RegExp;
  /**
   * Heading-recognition convention.
   *
   *   - `"caps-prefixed"` (default): all-caps `CHAPTER N` / `ARTICLE N`
   *     / `SEC. N` labeling — the Bastrop Building Block (B3) Code and
   *     Bastrop County Subdivision Regulations.
   *   - `"decimal-numbered"`: decimal-dotted, mixed-case section numbers
   *     (`10.101`, `10.303.2`, `10.1002.4`) with the chapter label
   *     carried in a per-page running header rather than a standalone
   *     heading line — the Hutto Unified Development Code (Chapter 16
   *     of the Hutto Code of Ordinances, internally numbered `10.NNN`).
   *   - `"chapter-decimal"`: standalone all-caps `CHAPTER N - TITLE`
   *     headings combined with chapter-scoped decimal section numbers
   *     whose first component IS the chapter number (`1.1`, `4.2.3`,
   *     `5.10`, `1.9.1.1`) and which carry no `SEC.` prefix — the City
   *     of Taylor "Taylor Made" Land Development Code. Distinct from
   *     `decimal-numbered`: the chapter signal is a typeset heading line
   *     (not a running-header tail) and the section root is the chapter
   *     index rather than a fixed `10.` namespace.
   *
   * Per 49 §B.2, per-source labeling quirks land as targeted normalizer
   * conventions here, not as branches inside the extractor.
   */
  headingConvention?: "caps-prefixed" | "decimal-numbered" | "chapter-decimal";
}

const DEFAULT_IGNORE = /^(?:\s*\d+\s+of\s+\d+\s*$|INTRODUCTION\s*$)/i;

const PAGE_MARKER_RE = /^\s*\d+\s+of\s+\d+\s*$/;
// TOC entry lines end with a trailing space + page-reference number,
// e.g. "SEC. 1.1.002 DORMANTFINAL SUBDIVISION PLATS 25". Body-page
// headings never carry a trailing page number on the same line.
const TOC_TAIL_RE = /\s\d{1,4}$/;

/**
 * Walk extracted PDF page text and emit a NormalizedBlock stream that
 * Stream 1B's extractor can chew (same contract as Municode HTML).
 */
export function pdfPagesToBlocks(
  pages: ReadonlyArray<PdfPageText>,
  options: PdfNormalizeOptions = {},
): NormalizedBlock[] {
  if (options.headingConvention === "decimal-numbered") {
    return decimalNumberedPagesToBlocks(pages, options);
  }
  if (options.headingConvention === "chapter-decimal") {
    return chapterDecimalPagesToBlocks(pages, options);
  }
  const ignoreLine = options.ignoreLineRegex ?? DEFAULT_IGNORE;
  const blocks: NormalizedBlock[] = [];
  // Track the section we're currently inside so subsection paragraph
  // blocks carry the correct subsectionLabel.
  let currentSubsectionLabel: string | undefined;
  // The chapter heading appears as a running-header at the top of
  // every body page (e.g., "CHAPTER 1: SUBDIVISIONS" on every page of
  // Chapter 1). We emit the heading only the first time we see each
  // distinct chapter label so the structural tree gets one chapter
  // container, not one per page.
  const emittedChapterLabels = new Set<string>();
  // Same idea for articles — running-header artifacts in some PDFs
  // restate the article on continuation pages.
  const emittedArticleLabels = new Set<string>();

  for (const page of pages) {
    const rawLines = page.text.split(/\n+/);
    // Trim leading running-header noise: a heading line followed by a
    // page marker like "25 of 265" is a body-page running header, not
    // a real new heading. Drop both lines before walking.
    while (rawLines.length >= 2) {
      const firstTrim = (rawLines[0] ?? "").trim();
      const secondTrim = (rawLines[1] ?? "").trim();
      const firstIsHeadingLike =
        CHAPTER_RE.test(firstTrim) ||
        ARTICLE_RE.test(firstTrim) ||
        SECTION_RE.test(firstTrim);
      if (firstIsHeadingLike && PAGE_MARKER_RE.test(secondTrim)) {
        rawLines.shift();
        rawLines.shift();
      } else {
        break;
      }
    }
    for (let i = 0; i < rawLines.length; i++) {
      const line = (rawLines[i] ?? "").trim();
      if (!line) continue;
      if (ignoreLine.test(line)) continue;

      // TOC entries (heading-like text + trailing page reference) get
      // filtered before structural promotion. They survive the running-
      // header strip because they appear in the BODY of the TOC pages,
      // not as page headers.
      const looksLikeHeadingPrefix =
        CHAPTER_RE.test(line) ||
        ARTICLE_RE.test(line) ||
        SECTION_RE.test(line);
      if (looksLikeHeadingPrefix && TOC_TAIL_RE.test(line)) {
        continue;
      }

      const chapterMatch = line.match(CHAPTER_RE);
      if (chapterMatch && isAllCapsLine(line)) {
        const label = chapterMatch[1] ?? "";
        if (emittedChapterLabels.has(label)) {
          // Running-header on a body page; the chapter is already open.
          currentSubsectionLabel = undefined;
          continue;
        }
        emittedChapterLabels.add(label);
        const title = (chapterMatch[2] ?? "").trim();
        // No `label` set — extractor parses `splitHeadingLabel(block.text)`
        // which handles "Chapter N: Title" via its abbrev regex. Setting
        // a bare-number label would shortcut splitHeadingLabel into an
        // empty-section-number atom (it expects "Prefix N Title" shape).
        blocks.push({
          kind: "heading",
          depth: 1,
          text: `Chapter ${label}${title ? ` ${title}` : ""}`,
          sourceAnchor: `#p${page.pageNumber}-chapter-${slug(label)}`,
        });
        currentSubsectionLabel = undefined;
        continue;
      }

      const articleMatch = line.match(ARTICLE_RE);
      if (articleMatch && isMostlyCapsLine(line)) {
        const label = articleMatch[1] ?? "";
        let title = (articleMatch[2] ?? "").trim();
        // Long article titles wrap across two lines in the source. If
        // the next line is all-caps and doesn't match any heading
        // regex, treat it as title continuation.
        const nextRaw = (rawLines[i + 1] ?? "").trim();
        const isContinuation =
          nextRaw &&
          isMostlyCapsLine(nextRaw) &&
          !CHAPTER_RE.test(nextRaw) &&
          !ARTICLE_RE.test(nextRaw) &&
          !SECTION_RE.test(nextRaw) &&
          !PAGE_MARKER_RE.test(nextRaw) &&
          !SUBSECTION_RE.test(nextRaw) &&
          !NESTED_SUBSECTION_RE.test(nextRaw);
        if (isContinuation && TOC_TAIL_RE.test(nextRaw)) {
          // TOC entry that wraps; the line above is `ARTICLE 1.4
          // <START>` and the continuation `<END> 38` is the TOC tail.
          // Skip both lines; do not emit a phantom article.
          i++;
          continue;
        }
        if (emittedArticleLabels.has(label)) {
          currentSubsectionLabel = undefined;
          continue;
        }
        emittedArticleLabels.add(label);
        if (isContinuation) {
          title = title ? `${title} ${nextRaw}` : nextRaw;
          i++;
        }
        blocks.push({
          kind: "heading",
          depth: 2,
          text: `Article ${label} ${title}`,
          sourceAnchor: `#p${page.pageNumber}-article-${slug(label)}`,
        });
        currentSubsectionLabel = undefined;
        continue;
      }

      const sectionMatch = line.match(SECTION_RE);
      if (sectionMatch && isMostlyCapsLine(line)) {
        const label = sectionMatch[1] ?? "";
        let title = (sectionMatch[2] ?? "").trim();
        // Section title continuation across lines (same pattern as
        // article titles).
        const nextRaw = (rawLines[i + 1] ?? "").trim();
        const isContinuation =
          nextRaw &&
          isMostlyCapsLine(nextRaw) &&
          !CHAPTER_RE.test(nextRaw) &&
          !ARTICLE_RE.test(nextRaw) &&
          !SECTION_RE.test(nextRaw) &&
          !PAGE_MARKER_RE.test(nextRaw) &&
          !SUBSECTION_RE.test(nextRaw) &&
          !NESTED_SUBSECTION_RE.test(nextRaw);
        if (isContinuation && TOC_TAIL_RE.test(nextRaw)) {
          // TOC entry that wraps across two lines; the continuation
          // carries the trailing page reference. Skip both lines.
          i++;
          continue;
        }
        if (isContinuation) {
          title = title ? `${title} ${nextRaw}` : nextRaw;
          i++;
        }
        blocks.push({
          kind: "heading",
          depth: 3,
          text: `Sec. ${label} ${title}`,
          sourceAnchor: `#p${page.pageNumber}-section-${slug(label)}`,
        });
        currentSubsectionLabel = undefined;
        continue;
      }

      const subsectionMatch = line.match(SUBSECTION_RE);
      if (subsectionMatch) {
        currentSubsectionLabel = `(${subsectionMatch[1]})`;
        const body = subsectionMatch[2] ?? "";
        emitParagraph(blocks, body, currentSubsectionLabel);
        continue;
      }
      const nestedMatch = line.match(NESTED_SUBSECTION_RE);
      if (nestedMatch) {
        const nestedLabel = currentSubsectionLabel
          ? `${currentSubsectionLabel}(${nestedMatch[1]})`
          : `(${nestedMatch[1]})`;
        emitParagraph(blocks, nestedMatch[2] ?? "", nestedLabel);
        continue;
      }

      emitParagraph(blocks, line, currentSubsectionLabel);
    }
  }
  return blocks;
}

// --- Decimal-numbered convention (Hutto UDC) --------------------------

// Decimal-dotted section labels: "10.101", "10.303.2", "10.1002.4.1".
// The Hutto UDC is Chapter 16 of the Code of Ordinances, numbered in
// the `10.NNN` namespace: a literal `10.` root, a 3+-digit second group
// (the floor rejects line-leading measurements like "10.50 feet" and
// stray decimals), then any number of further `.N` groups for the
// 4-to-6-level-deep nested provisions. A future decimal-numbered city
// in a different namespace would parameterize this root.
const DECIMAL_SECTION_RE = /^§?\s*(10\.\d{3,}(?:\.\d+)*)\s+(\S.*)$/;
// Per-page running header on body pages, e.g.
// "Chapter 1 Introduction §10.101 Title". Carries the chapter label;
// the section-ref tail (`§10.101 ...`) is incidental and dropped.
const DECIMAL_RUNNING_HEADER_RE = /^Chapter\s+(\d+)\s+(.+?)\s+§\s*\d/i;
// Front-matter / running-header boilerplate suppressed on every page.
const DECIMAL_IGNORE_RE =
  /^(?:City of Hutto\b.*|Revised\s+[A-Za-z]+\s+\d{4}|Unified Development Code Ordinance Amendments|Contents|\d{1,4})$/i;

/**
 * Walk extracted PDF page text for a code that numbers sections with a
 * decimal-dotted, mixed-case convention (the Hutto UDC). Two structural
 * signals differ from the caps-prefixed walker:
 *
 *   - The chapter label lives only in the per-page running header
 *     ("Chapter 3 Zoning §10.301 ..."), not as a standalone heading.
 *     We open one chapter container each time the running-header
 *     chapter number changes.
 *   - Section headings carry no "SEC." prefix and are mixed case
 *     ("10.303.2 SF-R residential: single household rural estate"), so
 *     the all-caps gate does not apply.
 *
 * Front matter (cover, ordinance-amendment table, table of contents)
 * precedes the body. TOC entries match the section pattern but carry a
 * trailing page-reference number; the first body heading does not. The
 * `bodyStarted` latch flips on the running header or the first
 * non-TOC-tail section line, so front matter is skipped without
 * hard-coding a page range.
 */
function decimalNumberedPagesToBlocks(
  pages: ReadonlyArray<PdfPageText>,
  options: PdfNormalizeOptions,
): NormalizedBlock[] {
  const ignoreLine = options.ignoreLineRegex ?? DECIMAL_IGNORE_RE;
  const blocks: NormalizedBlock[] = [];
  let bodyStarted = false;
  let currentChapter: string | null = null;

  for (const page of pages) {
    const rawLines = page.text.split(/\n+/).map((l) => l.trim());
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i] ?? "";
      if (!line) continue;

      // Running header — open a chapter container on change, drop line.
      const headerMatch = line.match(DECIMAL_RUNNING_HEADER_RE);
      if (headerMatch) {
        bodyStarted = true;
        const chapterLabel = headerMatch[1] ?? "";
        const chapterTitle = (headerMatch[2] ?? "").trim();
        if (chapterLabel && chapterLabel !== currentChapter) {
          currentChapter = chapterLabel;
          blocks.push({
            kind: "heading",
            depth: 1,
            text: `Chapter ${chapterLabel}${chapterTitle ? ` ${chapterTitle}` : ""}`,
            sourceAnchor: `#p${page.pageNumber}-chapter-${slug(chapterLabel)}`,
          });
        }
        continue;
      }

      const sectionMatch = line.match(DECIMAL_SECTION_RE);
      // Body-start latch: the first section-shaped line without a
      // trailing TOC page reference marks the end of the front matter.
      if (sectionMatch && !bodyStarted && !TOC_TAIL_RE.test(line)) {
        bodyStarted = true;
      }
      if (!bodyStarted) continue;
      if (ignoreLine.test(line)) continue;

      if (sectionMatch) {
        // Per-chapter mini-tables-of-contents repeat the section
        // headings as a run of `10.NNN Title <page>` lines. They match
        // the section pattern but carry a trailing page reference and
        // are followed by another heading-shaped line, whereas a real
        // body heading is followed by rule prose. Skip the mini-TOC
        // entry so the real body heading (with its rule text) is the
        // one atomized.
        if (TOC_TAIL_RE.test(line)) {
          let j = i + 1;
          while (j < rawLines.length && !rawLines[j]) j++;
          const next = rawLines[j] ?? "";
          if (
            next &&
            (DECIMAL_SECTION_RE.test(next) ||
              DECIMAL_RUNNING_HEADER_RE.test(next))
          ) {
            continue;
          }
        }
        const label = sectionMatch[1] ?? "";
        const title = (sectionMatch[2] ?? "").trim();
        // No `label` field set — the extractor's splitHeadingLabel
        // parses "10.303.2 Title" via its numeric branch into
        // (sectionNumber, title). All numbered units land at depth 3
        // (section) so each is an independently retrievable
        // `code-section` atom, consistent with the B3 walker.
        blocks.push({
          kind: "heading",
          depth: 3,
          text: `${label} ${title}`,
          sourceAnchor: `#p${page.pageNumber}-section-${slug(label)}`,
        });
        continue;
      }

      emitParagraph(blocks, line, undefined);
    }
  }
  return blocks;
}

// --- Chapter-decimal convention (Taylor "Taylor Made" LDC) ------------

// Standalone chapter heading: "CHAPTER 2 - DEVELOPMENT PROCESS". The
// separator may be a hyphen, en/em dash, or colon. Promotion is gated
// on an all-caps test below so body prose ("see Chapter 245 of the
// Texas Local Government Code") never matches.
const CHAPTER_DECIMAL_CHAPTER_RE = /^CHAPTER\s+(\d+)\s*[-–—:]\s*(.+?)\s*$/i;
// Chapter-scoped decimal section number: 2 to 6 dotted components, the
// first 1-2 digits (the chapter index), each further group 1-3 digits:
// "1.1", "4.2.3", "5.10", "1.9.1.1", "1.10.10.2". A trailing-dot list
// marker ("1." / "(1)") carries no digit after the dot and never matches.
const CHAPTER_DECIMAL_SECTION_RE =
  /^§?\s*(\d{1,2}(?:\.\d{1,3}){1,5})\s+(\S.*)$/;
// Chapter-scoped running page-number line, e.g. "2 - 21" (chapter - page).
const CHAPTER_DECIMAL_PAGE_RE = /^\d{1,2}\s*[-–—]\s*\d{1,4}$/;
// Generic front-matter line suppressed on every page.
const CHAPTER_DECIMAL_IGNORE_RE = /^TABLE OF CONTENTS$/i;
// A decimal number whose "title" is nothing but a unit of measure
// ("2.5 ACRES", "10 FEET") is a quantity lifted out of a table cell or
// flowchart box, not a section heading. No real section title is a bare
// unit, so an exact-match reject carries no false-rejection risk.
const MEASUREMENT_UNIT_RE =
  /^(?:acres?|feet|foot|ft|miles?|inch(?:es)?|percent|sf|du)$/i;

/**
 * Walk extracted PDF page text for a code that combines standalone
 * all-caps `CHAPTER N - TITLE` headings with chapter-scoped decimal
 * section numbers (`1.1`, `4.2.3`, `5.10`). Onboarded for the City of
 * Taylor "Taylor Made" Land Development Code.
 *
 * Two structural signals differ from the `decimal-numbered` (Hutto)
 * walker:
 *
 *   - The chapter label is a typeset all-caps heading line, repeated as
 *     a running header on every body page. One chapter container is
 *     emitted each time the chapter number changes.
 *   - Section numbers are rooted at the chapter index, not a fixed
 *     `10.` namespace, so the section pattern is namespace-agnostic.
 *
 * Front matter (cover, council roster, executive summary, table of
 * contents) precedes the body. Both chapter and section lines appear in
 * the table of contents with a trailing page-reference number; body
 * headings do not. The `bodyStarted` latch flips on the first chapter
 * (or section) line WITHOUT a trailing page reference, so front matter
 * is skipped without hard-coding a page range. Publisher running-header
 * boilerplate is suppressed via the caller-supplied `ignoreLineRegex`.
 */
function chapterDecimalPagesToBlocks(
  pages: ReadonlyArray<PdfPageText>,
  options: PdfNormalizeOptions,
): NormalizedBlock[] {
  const callerIgnore = options.ignoreLineRegex;
  const blocks: NormalizedBlock[] = [];
  let bodyStarted = false;
  let currentChapter: string | null = null;

  for (const page of pages) {
    const rawLines = page.text.split(/\n+/).map((l) => l.trim());
    for (const line of rawLines) {
      if (!line) continue;

      // Chapter heading — typeset all-caps line. TOC entries carry a
      // trailing page reference; skip them without opening a container
      // or flipping the body latch.
      const chapterMatch = line.match(CHAPTER_DECIMAL_CHAPTER_RE);
      if (chapterMatch && isAllCapsLine(line)) {
        if (TOC_TAIL_RE.test(line)) continue;
        bodyStarted = true;
        const label = chapterMatch[1] ?? "";
        if (label && label !== currentChapter) {
          currentChapter = label;
          const title = (chapterMatch[2] ?? "").trim();
          blocks.push({
            kind: "heading",
            depth: 1,
            text: `Chapter ${label}${title ? ` ${title}` : ""}`,
            sourceAnchor: `#p${page.pageNumber}-chapter-${slug(label)}`,
          });
        }
        continue;
      }

      const sectionMatch = line.match(CHAPTER_DECIMAL_SECTION_RE);
      // Body-start latch: the first section-shaped line without a
      // trailing TOC page reference also ends the front matter
      // (defensive — in practice the chapter-1 heading flips it first).
      if (sectionMatch && !bodyStarted && !TOC_TAIL_RE.test(line)) {
        bodyStarted = true;
      }
      if (!bodyStarted) continue;
      if (CHAPTER_DECIMAL_IGNORE_RE.test(line)) continue;
      if (CHAPTER_DECIMAL_PAGE_RE.test(line)) continue;
      if (callerIgnore?.test(line)) continue;

      if (sectionMatch) {
        // TOC entries match the section pattern but carry a trailing
        // page reference; the real body heading does not.
        if (TOC_TAIL_RE.test(line)) continue;
        const label = sectionMatch[1] ?? "";
        const title = (sectionMatch[2] ?? "").trim();
        // Reject decimal-leading lines that are not section headings:
        // a title with no letter (numeric table row), or a title that
        // is nothing but a unit of measure (a quantity from a table or
        // flowchart). The line stays as body prose.
        if (!/[A-Za-z]/.test(title) || MEASUREMENT_UNIT_RE.test(title)) {
          emitParagraph(blocks, line, undefined);
          continue;
        }
        // No `label` field — the extractor's splitHeadingLabel parses
        // "1.1 Title" into (sectionNumber, title) via its numeric
        // branch. All numbered units land at depth 3 (section) so each
        // is an independently retrievable `code-section` atom, matching
        // the decimal-numbered walker.
        blocks.push({
          kind: "heading",
          depth: 3,
          text: `${label} ${title}`,
          sourceAnchor: `#p${page.pageNumber}-section-${slug(label)}`,
        });
        continue;
      }

      emitParagraph(blocks, line, undefined);
    }
  }
  return blocks;
}

function emitParagraph(
  blocks: NormalizedBlock[],
  text: string,
  subsectionLabel: string | undefined,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  blocks.push(
    subsectionLabel
      ? { kind: "paragraph", text: trimmed, subsectionLabel }
      : { kind: "paragraph", text: trimmed },
  );

  // Extract any cross-references in the paragraph body.
  for (const match of trimmed.matchAll(SECTION_REF_RE)) {
    const label = match[1];
    if (!label) continue;
    blocks.push({
      kind: "cross-reference",
      referenceText: match[0],
      referenceType: inferReferenceType(trimmed),
      targetSectionLabel: trimRefLabel(label),
      referenceContext: trimmed,
    });
  }
  for (const match of trimmed.matchAll(ARTICLE_REF_RE)) {
    const label = match[1];
    if (!label) continue;
    blocks.push({
      kind: "cross-reference",
      referenceText: match[0],
      referenceType: inferReferenceType(trimmed),
      targetSectionLabel: trimRefLabel(label),
      referenceContext: trimmed,
    });
  }
  for (const match of trimmed.matchAll(CHAPTER_REF_RE)) {
    const label = match[1];
    if (!label) continue;
    blocks.push({
      kind: "cross-reference",
      referenceText: match[0],
      referenceType: inferReferenceType(trimmed),
      targetSectionLabel: trimRefLabel(label),
      referenceContext: trimmed,
    });
  }
}

/**
 * Headings in the B3 Code (and similar conventions) are typeset in
 * all-caps or near-all-caps. A line of body prose with leading "Chapter"
 * (e.g., "Chapter 1 governs ...") would otherwise false-match the
 * CHAPTER_RE. Restrict heading promotion to lines that look like
 * typeset headings.
 */
function isAllCapsLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  const upper = letters.replace(/[^A-Z]/g, "");
  return upper.length === letters.length;
}

function isMostlyCapsLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  const upper = letters.replace(/[^A-Z]/g, "");
  return upper.length / letters.length >= 0.7;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
