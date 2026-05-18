/**
 * Municode HTML adapter — Stream 1A P1 (most TX cities are on Municode).
 *
 * Per 49 §B.1 + 51 §Stream 1A. Walks Municode's HTML microsite, emits
 * the common NormalizedBlock stream consumed by Stream 1B.
 *
 * The discover() implementation enumerates published Municode jurisdictions
 * (the source publishes a state-scoped index page); the fetch() path
 * uses a respectful crawl rate (default 1rps) per the source's
 * documented expectations.
 *
 * Status: skeleton. The DOM walker handles the common Municode page
 * shape (chapter > article > section headings; cross-reference anchors;
 * definition glossary sections). Per-jurisdiction quirks land as fixtures
 * + targeted overrides during the first-city test (51 Stream 1A exit).
 */

import * as cheerio from "cheerio";

import { RespectfulFetch } from "../http.js";
import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedBlock,
  NormalizedBlockKind,
  NormalizedCode,
  RawCode,
} from "../types.js";

export interface MunicodeHtmlAdapterOptions {
  http?: RespectfulFetch;
  /** Base URL for the Municode index. */
  baseUrl?: string;
}

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

const SECTION_REFERENCE_RE = /§\s*([\w.()-]+(?:\([a-z0-9]+\))*)/gi;

export class MunicodeHtmlAdapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: "municode-html",
    displayName: "Municode HTML",
    sourceFamilies: ["municode"],
    supportsDiscovery: true,
    supportsAmendments: true,
  };

  private readonly http: RespectfulFetch;
  private readonly baseUrl: string;

  constructor(opts: MunicodeHtmlAdapterOptions = {}) {
    this.http = opts.http ?? new RespectfulFetch();
    this.baseUrl = opts.baseUrl ?? "https://library.municode.com";
  }

  async discover(
    options: Record<string, unknown> = {},
  ): Promise<ReadonlyArray<CodeReference>> {
    const region =
      typeof options.region === "string" ? options.region.toUpperCase() : "TX";
    const indexUrl = `${this.baseUrl}/${region.toLowerCase()}`;
    let html: string;
    try {
      html = await this.http.fetchText(indexUrl);
    } catch {
      // Municode region-index URLs can rotate; surface as empty rather
      // than failing discovery hard. Operators that hit this should
      // hand-curate references via tools/ingest-cli enqueue.
      return [];
    }
    const $ = cheerio.load(html);
    const references: CodeReference[] = [];
    $("a[href*='/codes/']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const name = $(el).text().trim();
      if (!href || !name) return;
      const sourceId = href.replace(/^.*?\/codes\/(.*?)\/?$/, "$1");
      if (!sourceId) return;
      references.push({
        sourceId,
        jurisdictionTenant: this.slugify(`${name}-${region.toLowerCase()}`),
        editionLabel: name,
        sourceUrl: href.startsWith("http") ? href : `${this.baseUrl}${href}`,
      });
    });
    return references;
  }

  async metadata(reference: CodeReference): Promise<CodeMetadata> {
    // Cheap header read — Municode publishes a small landing page per
    // edition. We fetch it but only parse metadata, not body content.
    const landingUrl = `${this.baseUrl}/codes/${reference.sourceId}`;
    let html = "";
    try {
      html = await this.http.fetchText(landingUrl);
    } catch {
      // Allow metadata() to return what we know from the reference even
      // when the landing page is unreachable; the conformance suite asks
      // only for jurisdiction + url + adapter-name + fetchedAt.
    }
    const $ = cheerio.load(html);
    const publicationDate =
      $("meta[name='publication-date']").attr("content") ?? "";
    const jurisdictionName =
      $("meta[name='jurisdiction-name']").attr("content") ?? reference.editionLabel;
    return {
      jurisdictionTenant: reference.jurisdictionTenant,
      jurisdictionName,
      editionLabel: reference.editionLabel,
      publicationDate,
      sourceAdapter: this.capabilities.name,
      sourceUrl: reference.sourceUrl,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetch(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
    // Municode publishes the full code under a tree of section pages.
    // First-pass fetch pulls the table-of-contents page; secondary
    // fetches (one per chapter / per section) happen lazily on
    // normalize(). Until the lazy walker lands, fetch() captures the
    // TOC page so the conformance suite has body content to assert on.
    const tocUrl = `${this.baseUrl}/codes/${reference.sourceId}/toc`;
    let body = "";
    try {
      body = await this.http.fetchText(tocUrl);
    } catch {
      body = "<html><body><!-- municode TOC unreachable --></body></html>";
    }
    return {
      metadata: { ...meta, sourceUrl: tocUrl, fetchedAt: new Date().toISOString() },
      contentType: "text/html",
      body,
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    if (!raw.contentType.startsWith("text/html")) {
      throw new Error(
        `MunicodeHtmlAdapter.normalize: unsupported contentType "${raw.contentType}"`,
      );
    }
    const $ = cheerio.load(raw.body);
    const blocks: NormalizedBlock[] = [];

    // Headings — Municode uses h1..h6 plus class="chapter-heading",
    // "section-heading" etc. We honor both anchors.
    const headingSelectors: Array<{ selector: string; depth: number }> = [
      { selector: "h1", depth: 1 },
      { selector: "h2", depth: 2 },
      { selector: "h3", depth: 3 },
      { selector: "h4", depth: 4 },
      { selector: "h5", depth: 5 },
      { selector: "h6", depth: 6 },
    ];

    for (const { selector, depth } of headingSelectors) {
      $(selector).each((_, el) => {
        const text = $(el).text().trim();
        if (!text) return;
        const id = $(el).attr("id");
        blocks.push({
          kind: "heading",
          depth,
          text,
          ...(id ? { sourceAnchor: `#${id}` } : {}),
        });
      });
    }

    // Paragraphs — body prose under section scope. We carry subsection
    // labels when the source marks them (e.g. <p data-subsection="(b)(2)">).
    $("p").each((_, el) => {
      const text = $(el).text().trim();
      if (!text) return;
      const subsectionLabel = $(el).attr("data-subsection") ?? undefined;
      const block: NormalizedBlock = subsectionLabel
        ? { kind: "paragraph", text, subsectionLabel }
        : { kind: "paragraph", text };
      blocks.push(block);

      // Sniff inline cross-references — section symbols in prose.
      const matches = [...text.matchAll(SECTION_REFERENCE_RE)];
      for (const match of matches) {
        const label = match[1];
        if (!label) continue;
        const referenceType = inferReferenceType(text);
        blocks.push({
          kind: "cross-reference",
          referenceText: match[0],
          referenceType,
          targetSectionLabel: label,
          referenceContext: text,
        });
      }
    });

    // Definitions — Municode glossaries use <dl><dt>Term</dt><dd>Defn</dd></dl>.
    $("dl").each((_, dl) => {
      const $dl = $(dl);
      const dts = $dl.find("> dt").toArray();
      const dds = $dl.find("> dd").toArray();
      for (let i = 0; i < dts.length; i++) {
        const term = $(dts[i]).text().trim();
        const defnEl = dds[i];
        const defn = defnEl ? $(defnEl).text().trim() : "";
        if (!term || !defn) continue;
        blocks.push({
          kind: "definition",
          term,
          definitionText: defn,
        });
      }
    });

    // Amendments — Municode marks ordinance records with .amendment-record
    // (or sometimes <aside class="amendment">). Skeleton selector below;
    // refine via fixtures during first-city test.
    $(".amendment-record, aside.amendment").each((_, el) => {
      const $el = $(el);
      const ordinanceId = $el.find(".ordinance-id").text().trim();
      const effectiveDate = $el.find(".effective-date").text().trim();
      const authority = $el.find(".authority").text().trim();
      const text = $el.text().trim();
      if (!ordinanceId && !text) return;
      blocks.push({
        kind: "amendment-record",
        ordinanceId: ordinanceId || `unknown-${blocks.length}`,
        effectiveDate,
        authority,
        affectedSectionLabels: [],
        amendmentText: text,
      });
    });

    return {
      metadata: raw.metadata,
      blocks,
    };
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }
}

function inferReferenceType(text: string):
  | "see"
  | "notwithstanding"
  | "subject-to"
  | "as-defined-in"
  | "amends"
  | "supersedes"
  | "unknown" {
  for (const { pattern, referenceType } of REFERENCE_PATTERNS) {
    if (pattern.test(text)) return referenceType;
  }
  return "unknown";
}

// Exported for tests / debugging. Keeps the union narrow at the call site.
export const __blockKinds: ReadonlyArray<NormalizedBlockKind> = [
  "heading",
  "paragraph",
  "definition",
  "cross-reference",
  "table",
  "figure",
  "note",
  "amendment-record",
];
