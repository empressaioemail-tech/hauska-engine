/**
 * Municode HTML adapter — Stream 1A P1 (most TX cities are on Municode).
 *
 * Per 49 §B.1 + 51 §Stream 1A. Two operating modes share the same
 * NormalizedBlock surface:
 *
 *   - HTML mode (default): fetches the Municode TOC landing page; used
 *     by the conformance suite and by lightweight discovery probes.
 *   - JSON mode (when constructor options carry clientId / librarySlug /
 *     stateAbbr): walks the api.municode.com endpoint chain
 *     (clientContent -> jobsLatest -> codesToc/children -> CodesContent),
 *     drills into UDC / zoning chapters by `chapterFilter` regex,
 *     synthesizes a single HTML document from the Docs[] envelopes,
 *     and hands it to the shared `normalize()` walker.
 *
 * The JSON path is what Path C Bastrop UDC re-ingestion uses; the HTML
 * path is what discover() and the inline-fixture tests use.
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
import {
  MunicodeJsonClient,
  municodeLibraryUrl,
  type MunicodeContentEnvelope,
  type MunicodeJob,
  type MunicodeTocNode,
} from "./json-client.js";

export interface MunicodeHtmlAdapterOptions {
  http?: RespectfulFetch;
  /** Base URL for the Municode index. */
  baseUrl?: string;
  /** Preconfigured client id (avoids /Clients/name lookup). */
  clientId?: number;
  /** Library slug (e.g., "bastrop"). Used to build canonical section URLs. */
  librarySlug?: string;
  /** State abbreviation (e.g., "TX"). */
  stateAbbr?: string;
  /**
   * Top-level chapter filter regex. When set, the JSON walker prunes the
   * top-level TOC to nodes whose Heading matches. Used to scope the walk
   * to (e.g.) the Unified Development Code chapter only.
   */
  chapterFilter?: RegExp;
  /** Maximum leaf-content fetches (politeness ceiling). Defaults to 60. */
  maxLeafFetches?: number;
  /** Maximum TOC recursion depth. Defaults to 6. */
  maxTocDepth?: number;
  /** Optional pre-built JSON client (lets tests stub the network). */
  jsonClient?: MunicodeJsonClient;
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
  private readonly clientId?: number;
  private readonly librarySlug?: string;
  private readonly stateAbbr?: string;
  private readonly chapterFilter?: RegExp;
  private readonly maxLeafFetches: number;
  private readonly maxTocDepth: number;
  private readonly jsonClient?: MunicodeJsonClient;

  constructor(opts: MunicodeHtmlAdapterOptions = {}) {
    this.http = opts.http ?? new RespectfulFetch();
    this.baseUrl = opts.baseUrl ?? "https://library.municode.com";
    this.clientId = opts.clientId;
    this.librarySlug = opts.librarySlug;
    this.stateAbbr = opts.stateAbbr;
    this.chapterFilter = opts.chapterFilter;
    this.maxLeafFetches = opts.maxLeafFetches ?? 60;
    this.maxTocDepth = opts.maxTocDepth ?? 6;
    this.jsonClient = opts.jsonClient;
  }

  private get jsonMode(): boolean {
    return Boolean(this.clientId && this.librarySlug && this.stateAbbr);
  }

  private getOrBuildJsonClient(): MunicodeJsonClient {
    return this.jsonClient ?? new MunicodeJsonClient();
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
    if (this.jsonMode) {
      const job = await this.fetchJob();
      return {
        jurisdictionTenant: reference.jurisdictionTenant,
        jurisdictionName: reference.editionLabel,
        editionLabel: job?.Name ?? reference.editionLabel,
        publicationDate: "",
        sourceAdapter: this.capabilities.name,
        sourceUrl: reference.sourceUrl,
        fetchedAt: new Date().toISOString(),
      };
    }
    const landingUrl = `${this.baseUrl}/codes/${reference.sourceId}`;
    let html = "";
    try {
      html = await this.http.fetchText(landingUrl);
    } catch {
      // Allow metadata() to return what we know from the reference.
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
    if (this.jsonMode) {
      return await this.fetchViaJson(reference);
    }
    return await this.fetchViaHtml(reference);
  }

  private async fetchJob(): Promise<MunicodeJob | null> {
    if (!this.clientId) return null;
    const client = this.getOrBuildJsonClient();
    const clientContent = await client.getClientContent(this.clientId);
    const product = clientContent?.codes?.[0];
    if (!product) return null;
    return await client.getLatestJob(product.productId);
  }

  private async fetchViaJson(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
    const client = this.getOrBuildJsonClient();
    const job = await this.fetchJob();
    if (!job) {
      return {
        metadata: meta,
        contentType: "text/html",
        body: "<html><body><!-- municode job unavailable --></body></html>",
      };
    }
    const topLevel = await client.getTocChildren(job.Id, job.ProductId);
    const scopedRoots = this.chapterFilter
      ? topLevel.filter((n) => this.chapterFilter!.test(n.Heading))
      : topLevel;
    const leaves: MunicodeTocNode[] = [];
    let leafBudget = this.maxLeafFetches;
    for (const root of scopedRoots) {
      if (leafBudget <= 0) break;
      const visited = await this.walkToc(
        client,
        job.Id,
        job.ProductId,
        root,
        1,
        leafBudget,
      );
      leaves.push(...visited);
      leafBudget -= visited.length;
    }
    // Municode's CodesContent endpoint returns every Doc in the leaf's
    // containing article (often its whole chapter), not just the leaf
    // itself. Group leaves by ParentId and, within a group, skip a leaf
    // once its own Id has already appeared among the Docs of an earlier
    // sibling's envelope — one fetch then covers the whole article.
    // A large code (Leander's Subdivision + Zoning exhibits run to ~550
    // leaf nodes) otherwise issues hundreds of redundant per-section
    // requests, which throttle out and silently drop the tail articles.
    //
    // A leaf left uncovered — because its envelope was narrow, or an
    // earlier sibling's fetch failed — is still fetched in turn, so a
    // transient drop self-heals and a source whose envelopes carry only
    // the requested leaf degrades gracefully to one fetch per leaf.
    const byParent = new Map<string, MunicodeTocNode[]>();
    for (const leaf of leaves) {
      const group = byParent.get(leaf.ParentId);
      if (group) group.push(leaf);
      else byParent.set(leaf.ParentId, [leaf]);
    }
    const contentEnvelopes: Array<{
      node: MunicodeTocNode;
      envelope: MunicodeContentEnvelope | null;
    }> = [];
    let fetchCount = 0;
    for (const group of byParent.values()) {
      const coveredDocIds = new Set<string>();
      for (const leaf of group) {
        if (fetchCount >= this.maxLeafFetches) break;
        if (coveredDocIds.has(leaf.Id)) continue;
        fetchCount += 1;
        let envelope: MunicodeContentEnvelope | null = null;
        try {
          envelope = await client.getCodesContent(job.Id, job.ProductId, leaf.Id);
        } catch {
          envelope = null;
        }
        contentEnvelopes.push({ node: leaf, envelope });
        if (envelope) {
          for (const doc of envelope.Docs) coveredDocIds.add(doc.Id);
        }
      }
    }
    const body = this.assembleHtmlFromEnvelopes(contentEnvelopes);
    // Preserve operator-supplied editionLabel (the reference's editionLabel
    // is canonical for downstream DID construction). Carry Municode's
    // job.Name as a sidecar in `extra.municodeJobName` so the live
    // supplement tag is recoverable for telemetry without sneaking into
    // the atom entityId scheme.
    return {
      metadata: {
        ...meta,
        editionLabel: reference.editionLabel,
        fetchedAt: new Date().toISOString(),
        extra: { ...(meta.extra ?? {}), municodeJobName: job.Name },
      },
      contentType: "text/html",
      body,
    };
  }

  private async walkToc(
    client: MunicodeJsonClient,
    jobId: number,
    productId: number,
    node: MunicodeTocNode,
    depth: number,
    budget: number,
  ): Promise<MunicodeTocNode[]> {
    if (depth > this.maxTocDepth) return [node];
    if (!node.HasChildren) return [node];
    if (budget <= 0) return [];
    const children = await client.getTocChildren(jobId, productId, node.Id);
    if (children.length === 0) return [node];
    const collected: MunicodeTocNode[] = [];
    let remaining = budget;
    for (const child of children) {
      if (remaining <= 0) break;
      const visited = await this.walkToc(
        client,
        jobId,
        productId,
        child,
        depth + 1,
        remaining,
      );
      collected.push(...visited);
      remaining -= visited.length;
    }
    return collected;
  }

  private assembleHtmlFromEnvelopes(
    pairs: ReadonlyArray<{
      node: MunicodeTocNode;
      envelope: MunicodeContentEnvelope | null;
    }>,
  ): string {
    const sections: string[] = [];
    for (const { node, envelope } of pairs) {
      const docs = envelope?.Docs ?? [];
      const chapterHeading = `<h2 id="${escapeAttr(node.Id)}">${escapeText(node.Heading)}</h2>`;
      const sectionHtml: string[] = [];
      for (const doc of docs) {
        if (!doc.Content) continue;
        sectionHtml.push(
          `<h3 id="${escapeAttr(doc.Id)}">${escapeText(doc.Title)}</h3>`,
        );
        sectionHtml.push(doc.Content);
      }
      sections.push(chapterHeading + sectionHtml.join("\n"));
    }
    if (sections.length === 0) {
      return "<html><body><!-- municode walked corpus had no content --></body></html>";
    }
    return `<!doctype html><html><body>${sections.join("\n")}</body></html>`;
  }

  private async fetchViaHtml(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
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

    // Walk the DOM in document order so paragraphs and cross-references
    // attach to the section that immediately precedes them, not to the
    // last heading in the file. A combined-selector each() is the
    // shortest path to ordered iteration in cheerio without recursive
    // traversal.
    const headingDepth: Record<string, number> = {
      h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
    };
    $(
      "h1,h2,h3,h4,h5,h6,p,dl,.amendment-record,aside.amendment",
    ).each((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
      const $el = $(el);
      if (tag in headingDepth) {
        const text = $el.text().trim();
        if (!text) return;
        const id = $el.attr("id");
        blocks.push({
          kind: "heading",
          depth: headingDepth[tag]!,
          text,
          ...(id ? { sourceAnchor: `#${id}` } : {}),
        });
        return;
      }
      if (tag === "p") {
        const text = $el.text().trim();
        if (!text) return;
        const subsectionLabel = $el.attr("data-subsection") ?? undefined;
        const block: NormalizedBlock = subsectionLabel
          ? { kind: "paragraph", text, subsectionLabel }
          : { kind: "paragraph", text };
        blocks.push(block);
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
        return;
      }
      if (tag === "dl") {
        const dts = $el.find("> dt").toArray();
        const dds = $el.find("> dd").toArray();
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
        return;
      }
      // .amendment-record or aside.amendment
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

  buildSectionUrl(nodeId: string): string {
    if (this.stateAbbr && this.librarySlug) {
      return municodeLibraryUrl(this.stateAbbr, this.librarySlug, nodeId);
    }
    return "";
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
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

export { MunicodeJsonClient, municodeLibraryUrl } from "./json-client.js";
