/**
 * eCode360 adapter — Stream 1A P1 (broad coverage; Houston, Dallas, others).
 *
 * Per 49 §B.1: "JSON API where available, HTML fallback." This skeleton
 * starts on the HTML path because eCode360's JSON endpoints sit behind
 * inconsistent auth across jurisdictions. First-city test surfaces the
 * shape difference; the JSON path lands as a non-breaking augmentation.
 *
 * The HTML path is intentionally a sibling of the Municode adapter —
 * different anchors, same NormalizedBlock contract.
 */

import * as cheerio from "cheerio";

import { RespectfulFetch } from "../http.js";
import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedBlock,
  NormalizedCode,
  RawCode,
} from "../types.js";

export interface ECode360AdapterOptions {
  http?: RespectfulFetch;
  baseUrl?: string;
}

export class ECode360Adapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: "ecode360-html",
    displayName: "eCode360 (HTML)",
    sourceFamilies: ["ecode360"],
    supportsDiscovery: false,
    supportsAmendments: true,
  };

  private readonly http: RespectfulFetch;
  private readonly baseUrl: string;

  constructor(opts: ECode360AdapterOptions = {}) {
    this.http = opts.http ?? new RespectfulFetch();
    this.baseUrl = opts.baseUrl ?? "https://ecode360.com";
  }

  async discover(): Promise<ReadonlyArray<CodeReference>> {
    // eCode360 does not surface a stable region index. Operators
    // hand-curate references via the ingest CLI; discover() returns
    // empty per `supportsDiscovery: false`.
    return [];
  }

  async metadata(reference: CodeReference): Promise<CodeMetadata> {
    return {
      jurisdictionTenant: reference.jurisdictionTenant,
      jurisdictionName: reference.editionLabel,
      editionLabel: reference.editionLabel,
      publicationDate: "",
      sourceAdapter: this.capabilities.name,
      sourceUrl: reference.sourceUrl,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetch(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
    let body: string;
    try {
      body = await this.http.fetchText(reference.sourceUrl);
    } catch {
      body = "<html><body><!-- ecode360 unreachable --></body></html>";
    }
    return {
      metadata: { ...meta, fetchedAt: new Date().toISOString() },
      contentType: "text/html",
      body,
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    const $ = cheerio.load(raw.body);
    const blocks: NormalizedBlock[] = [];

    // eCode360 wraps sections in <div class="section" id="…">. Headings
    // live in .section > .heading. Body prose in .section > .body.
    $(".section").each((_, sec) => {
      const $sec = $(sec);
      const headingText = $sec.find(".heading").first().text().trim();
      if (headingText) {
        const id = $sec.attr("id");
        blocks.push({
          kind: "heading",
          depth: 3,
          text: headingText,
          ...(id ? { sourceAnchor: `#${id}` } : {}),
        });
      }
      $sec.find(".body p").each((_, p) => {
        const text = $(p).text().trim();
        if (text) {
          blocks.push({ kind: "paragraph", text });
        }
      });
    });

    return {
      metadata: raw.metadata,
      blocks,
    };
  }
}
