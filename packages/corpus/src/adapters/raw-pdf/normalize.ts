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
