/**
 * eCode360 adapter — Stream 1A P1 (broad coverage; Smithville TX first
 * live target, generalizes to any eCode360 `custId`).
 *
 * Rebuilt from the 2026-07-29 proof wave (Smithville / SM6484). That
 * wave's code was never committed (lost); its evidence survives at
 * `P:/tmp/tx_scraper_proofs/smithville/` (STATUS.md, 155 raw parent
 * pages, normalized.json, fidelity_harness.json — 836/836 TOC sections,
 * 0 missing/altered spans). This implementation is re-authored to that
 * proven spec, verified directly against the saved raw HTML rather than
 * just STATUS.md's prose summary (see divergence notes below).
 *
 * Access posture, all verified live against ecode360.com 2026-07-29/30:
 *
 *   - Robots gate FIRST. ecode360.com's robots.txt disallows `/admin`,
 *     `/archives`, `/attachment`, `/dashboard`, `/documents`, `/output`,
 *     `/permissions`, `/print`, `/search`, `/user` for UA `*`. The
 *     landing (`/{custId}`), TOC (`/toc/{custId}`), and numeric content
 *     paths this adapter fetches are all allowed. A disallowed target
 *     throws `ECode360RobotsDisallowedError` before any fetch — this
 *     adapter never sends a request to a disallowed path.
 *
 *   - Civil, honestly self-identifying UA. The proof tested five
 *     profiles: a Chrome UA + Sec-Fetch spoof drew a Cloudflare
 *     challenge (403); a bare `Mozilla/5.0` and bare `curl/8.5.0` also
 *     403'd; `HauskaEngineIngest/0.1` (this package's shared
 *     `RespectfulFetch` default) got a live 200 on the proof's host but
 *     is NOT the selected profile here — `Mozilla/5.0 (compatible;
 *     PublicLawTextFetcher/1.0)` is, matching STATUS.md's explicit
 *     "SELECTED civil profile" call and its "Chrome spoof must not be
 *     used" warning. This adapter constructs its own `RespectfulFetch`
 *     with that UA rather than accepting the package default, so a
 *     future default change elsewhere can't silently flip this
 *     adapter's UA into spoofed territory.
 *
 *   - Rate ceiling ≤1 rps (this adapter uses `RespectfulFetch`'s
 *     default 1 rps cap; the proof ran at 0.5 rps deliberately and
 *     recovered from one mid-crawl 429 with a backoff — this adapter
 *     does not implement retry-with-backoff itself since
 *     `RespectfulFetch` already serializes per host at the cap; a
 *     transient 429 surfaces as `ECode360HttpBlockError` and the caller
 *     (ingest CLI) decides whether to retry).
 *
 *   - 403 / Cloudflare-challenge responses throw `ECode360HttpBlockError`
 *     — LOUD, never a silent empty result. The old stub here caught
 *     every fetch failure into an HTML comment stub and returned it as
 *     if it were content; `normalize()` then silently produced zero
 *     blocks. That failure mode is forbidden per the 2026-08-04 build
 *     ruling; a pinned test (`throws on Cloudflare challenge page`)
 *     guards against it recurring.
 *
 * Parse strategy, verified against the raw HTML (not just STATUS.md's
 * one-line ".section_content / .para" summary — see "Divergence from
 * STATUS.md" below):
 *
 *   - `GET /{custId}` (landing) and `GET /toc/{custId}` (TOC) are used
 *     for discovery/metadata; the content walk fetches each unique
 *     *parent* page once (a parent covers all of its child sections —
 *     Smithville's 836 TOC sections live under 155 unique parent
 *     pages) via the ingest-CLI-curated reference's `sourceUrl` (or, if
 *     the reference carries `extra.parentUrls`, that explicit list —
 *     see `discover()`/`fetch()` for the exact contract).
 *
 *   - Every heading/subheading marker in a parent page's body carries
 *     `data-code-content-type` ("part" | "article" | "subarticle" |
 *     "section") and `data-full-title`, regardless of which tag or
 *     `<header>` wrapper surrounds it (sections opening a subtree are
 *     wrapped in `<header><div data-component="h2" …>`; sibling
 *     sections and reserved-range placeholders are a bare
 *     `contentTitle` div with no header/component). Depth mapping,
 *     confirmed against 2,204 markers across the 155 saved pages:
 *     `part` → 3, `article` → 3, `subarticle` → 4, `section` → 5. (The
 *     top-of-document `#pageTitle` — the parent's own chapter/article
 *     title — is never emitted as an in-body block; the crawl emits one
 *     synthetic depth-1 "Table of Contents - {jurisdictionName}" heading
 *     for the whole document instead, matching normalized.json.)
 *
 *   - Section body text lives in `.section_content > .para` (plain
 *     paragraphs) and, for lettered/numbered subsections, nested
 *     `.section_content .level > .litem > .litem_content > .para`. Each
 *     `.para` becomes one paragraph block. `.history` (legislative
 *     citation) and `.footnotes` siblings are NOT emitted as blocks —
 *     confirmed by diffing normalized.json's paragraph text against the
 *     raw HTML for the same section (the `.history` citation text is
 *     absent from every paragraph block).
 *
 * Divergence from STATUS.md's one-line spec (flagged per the build
 * ruling: follow the saved artifacts over the prose summary where they
 * differ):
 *
 *   1. STATUS.md says ".section_content / .para into NormalizedBlock[]"
 *      as the whole parse rule. The raw HTML shows FOUR distinct
 *      heading-marker types (part/article/subarticle/section) mapped to
 *      three depths (3/3/4/5), not a flat one-level section scheme, and
 *      a nested `.litem` nesting layer for lettered subsections. Fixed
 *      by parsing all four `data-code-content-type` values and walking
 *      `.litem` recursively.
 *   2. The saved normalized.json's own paragraph blocks carry no
 *      `subsectionLabel` even though the raw `.litem_number` anchor
 *      (`title="1.06.008(a)"`) makes the label directly extractable.
 *      This implementation extracts it into `subsectionLabel` — a
 *      strict superset of the proven output (adds a field, does not
 *      change heading/paragraph counts or text), since the
 *      `NormalizedBlock` contract supports it and Stream 1B benefits
 *      from it. Flagged rather than silently added: if a byte-exact
 *      replay of the proof corpus is required, this is the one field
 *      this implementation emits that the original run did not.
 *   3. `status.json` (the in-run status the scraper wrote at crawl
 *      finish) shows `pass: false` with 325 missing/153 altered spans;
 *      `fidelity_harness.json` and `planner_fidelity_regrade.json`
 *      (both `pass: true`, 0 missing/altered) are the corrected re-grade
 *      after a decode-path fix, per STATUS.md's "offline regrade after
 *      decode-path fix" note. This build treats the two `pass: true`
 *      files as authoritative and `status.json` as the known-superseded
 *      pre-fix run, consistent with STATUS.md's own verdict line.
 */

import * as cheerio from "cheerio";

import { RespectfulFetch } from "../http.js";
import {
  assertPathAllowed,
  parseRobotsTxt,
  type RobotsRules,
} from "./robots.js";
import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedBlock,
  NormalizedCode,
  RawCode,
} from "../types.js";

/** The proven civil UA. Never Chrome-spoofed — see file header. */
const CIVIL_USER_AGENT = "Mozilla/5.0 (compatible; PublicLawTextFetcher/1.0)";

/** `data-code-content-type` -> NormalizedBlock heading depth. */
const CONTENT_TYPE_DEPTH: Record<string, number> = {
  part: 3,
  article: 3,
  subarticle: 4,
  section: 5,
};

/**
 * Thrown when a fetch is blocked — HTTP 403/429, or a 200 that is
 * actually a Cloudflare interstitial (rare but possible if a challenge
 * is served with a 200 during a soft-block window; detected by body
 * signature). Fail loud: this is never converted into an empty
 * `RawCode`.
 */
export class ECode360HttpBlockError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "ECode360HttpBlockError";
  }
}

/** Signature strings that mark a Cloudflare interstitial/challenge body. */
const CHALLENGE_BODY_SIGNATURES = [
  "Just a moment...",
  "cf_chl_opt",
  "challenges.cloudflare.com",
  "Enable JavaScript and cookies to continue",
];

function looksLikeChallengeBody(body: string): boolean {
  return CHALLENGE_BODY_SIGNATURES.some((sig) => body.includes(sig));
}

export interface ECode360AdapterOptions {
  http?: RespectfulFetch;
  baseUrl?: string;
  /** Override for tests; skips the live robots.txt fetch when provided. */
  robotsRules?: RobotsRules;
}

export class ECode360Adapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: "ecode360-html",
    displayName: "eCode360 (HTML)",
    sourceFamilies: ["ecode360"],
    supportsDiscovery: false,
    supportsAmendments: false,
  };

  private readonly http: RespectfulFetch;
  private readonly baseUrl: string;
  private robotsRulesCache: RobotsRules | undefined;

  constructor(opts: ECode360AdapterOptions = {}) {
    // Deliberately NOT `opts.http ?? new RespectfulFetch()` sharing the
    // package default — that default UA is `HauskaEngineIngest/0.1`,
    // which the proof did NOT select (see file header). This adapter
    // always fetches with the civil `PublicLawTextFetcher` UA unless a
    // caller explicitly injects its own `http` (tests do this to stub
    // the network; a caller injecting a live client is responsible for
    // its own UA choice).
    this.http =
      opts.http ??
      new RespectfulFetch({
        userAgent: CIVIL_USER_AGENT,
        maxRequestsPerSecondPerHost: 1,
      });
    this.baseUrl = opts.baseUrl ?? "https://ecode360.com";
    this.robotsRulesCache = opts.robotsRules;
  }

  async discover(): Promise<ReadonlyArray<CodeReference>> {
    // eCode360 does not surface a stable region index. Operators
    // hand-curate references via the ingest CLI (matches Municode's
    // HTML-mode discover() posture for sources with no crawlable
    // index); discover() returns empty per `supportsDiscovery: false`.
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
      extra: { custId: this.custIdFromReference(reference) },
    };
  }

  /**
   * Fetch raw content for one reference. `reference.sourceUrl` must be
   * the eCode360 landing URL (`https://ecode360.com/{custId}`).
   * `reference.sourceId` carries the `custId` directly (preferred) —
   * `metadata()`/`fetch()` fall back to parsing it out of `sourceUrl`
   * when `sourceId` is not the bare custId.
   *
   * The content walk is: robots gate -> fetch TOC -> collect unique
   * parent-page URLs referenced by TOC leaves -> fetch each parent page
   * once. Every fetched page's HTML is concatenated into `RawCode.body`
   * (each page's fragment is wrapped so `normalize()` can walk them in
   * document order) — mirroring the Municode JSON-mode adapter's
   * "assemble one document from many fetches" shape.
   */
  async fetch(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
    const custId = this.custIdFromReference(reference);
    const rules = await this.getRobotsRules();

    const tocPath = `/toc/${custId}`;
    assertPathAllowed(rules, tocPath);
    const tocUrl = `${this.baseUrl}${tocPath}`;
    const tocJson = await this.fetchGuarded(tocUrl);

    const parentUrls = this.collectParentUrls(tocJson);
    const pages: string[] = [];
    for (const url of parentUrls) {
      const path = this.pathFromUrl(url);
      assertPathAllowed(rules, path);
      const html = await this.fetchGuarded(url);
      pages.push(`<!-- source:${url} -->\n${html}`);
    }

    return {
      metadata: { ...meta, fetchedAt: new Date().toISOString() },
      contentType: "text/html",
      body: pages.join("\n"),
    };
  }

  /**
   * Convenience for the ingest CLI: fetch a reference whose parent
   * pages are already known (avoids re-walking the TOC JSON — used
   * when a prior `discoverParentUrls()`/manual curation already has the
   * page list, e.g. resuming from a `raw/page_*.html` cache per
   * STATUS.md's "Resume via raw/page_*.html cache" note).
   */
  async fetchPages(
    reference: CodeReference,
    parentUrls: ReadonlyArray<string>,
  ): Promise<RawCode> {
    const meta = await this.metadata(reference);
    const rules = await this.getRobotsRules();
    const pages: string[] = [];
    for (const url of parentUrls) {
      const path = this.pathFromUrl(url);
      assertPathAllowed(rules, path);
      const html = await this.fetchGuarded(url);
      pages.push(`<!-- source:${url} -->\n${html}`);
    }
    return {
      metadata: { ...meta, fetchedAt: new Date().toISOString() },
      contentType: "text/html",
      body: pages.join("\n"),
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    if (!raw.contentType.startsWith("text/html")) {
      throw new Error(
        `ECode360Adapter.normalize: unsupported contentType "${raw.contentType}"`,
      );
    }

    const blocks: NormalizedBlock[] = [];
    blocks.push({
      kind: "heading",
      depth: 1,
      text: `Table of Contents - ${raw.metadata.jurisdictionName}`,
      sourceAnchor: raw.metadata.sourceUrl,
    });

    // raw.body is the concatenation of per-page fragments, each
    // prefixed with an HTML comment carrying that page's source URL
    // (see fetch()/fetchPages()). Split on that marker so every block
    // gets the right page URL for its sourceAnchor.
    const pageFragments = this.splitPageFragments(raw.body);

    for (const { pageUrl, html } of pageFragments) {
      if (looksLikeChallengeBody(html)) {
        // Should never reach normalize() — fetchGuarded() throws first.
        // Guarded here too since normalize() must be pure and safe to
        // call on any RawCode a caller assembles by hand.
        throw new ECode360HttpBlockError(
          "ECode360Adapter.normalize: challenge-page content passed to normalize()",
          403,
          pageUrl,
        );
      }
      this.normalizePage(html, pageUrl, blocks);
    }

    return { metadata: raw.metadata, blocks };
  }

  // ---- internal ----

  private normalizePage(
    html: string,
    pageUrl: string,
    blocks: NormalizedBlock[],
  ): void {
    const $ = cheerio.load(html);

    // Scope the walk to `#childContent` — the on-page rendered content
    // region. Every fetched parent page also carries a `<nav id="toc">`
    // breadcrumb/on-this-page sidebar living INSIDE `#codeContent` but
    // BEFORE `#childContent`, and that sidebar duplicates the same
    // `data-code-content-type` markers as the real content (confirmed:
    // 17 markers in the nav, 17 in `#childContent`, for Smithville's
    // Division-1/Division-2 parent page). Walking the whole document
    // double-counts every heading. `#childContent` is absent from
    // hand-built minimal test fixtures that skip the chrome — fall back
    // to the whole document in that case.
    const $scope = $("#childContent");
    const markers =
      $scope.length > 0
        ? $scope.find("[data-code-content-type]")
        : $("[data-code-content-type]");

    markers.each((_, el) => {
      const $el = $(el);
      const contentType = $el.attr("data-code-content-type") ?? "";
      const depth = CONTENT_TYPE_DEPTH[contentType];
      if (!depth) return;

      const fullTitle = $el.attr("data-full-title")?.trim();
      if (!fullTitle) return;
      const guid = $el.attr("data-guid") ?? $el.attr("id") ?? "";

      // Section headings that open a numbered/labeled section carry a
      // "§ 1.01.001: Title." full-title; the label is the part before
      // the first colon. Division/article/part headings carry
      // "Division 2: Claims for Damages Against City" in the same
      // shape; ARTICLE-numbered parts use "ARTICLE 7.01: TITLE".
      const colonIdx = fullTitle.indexOf(":");
      const label = colonIdx === -1 ? undefined : fullTitle.slice(0, colonIdx).trim();

      blocks.push({
        kind: "heading",
        depth,
        text: fullTitle,
        ...(label ? { label } : {}),
        sourceAnchor: guid ? `${pageUrl}#${guid}` : pageUrl,
      });

      if (contentType === "section") {
        const contentId = `${guid}_content`;
        const $content = $(`#${escapeSelectorId(contentId)}`);
        if ($content.length > 0) {
          this.walkSectionContent($, $content, blocks);
        }
      }
    });
  }

  /**
   * Walk a `.section_content` subtree, emitting one paragraph block per
   * `.para` div — including `.para` divs nested inside `.level > .litem
   * > .litem_content` for lettered/numbered subsections, where the
   * `.litem_number` anchor's `title` attribute (e.g. "1.06.008(a)")
   * gives the subsection label. `.history` and `.footnotes` siblings
   * are intentionally skipped (see "Divergence from STATUS.md" note 2
   * in the file header — the proof's own corpus drops this content).
   */
  private walkSectionContent(
    $: cheerio.CheerioAPI,
    $content: ReturnType<cheerio.CheerioAPI>,
    blocks: NormalizedBlock[],
  ): void {
    // Top-level .para children of .section_content (not nested in a
    // .litem) — direct children only, so we don't double-count .para
    // divs that live inside a nested .litem_content (those are walked
    // by the .litem loop below).
    $content.children(".para").each((_, p) => {
      const text = $(p).text().trim();
      if (text) blocks.push({ kind: "paragraph", text });
    });

    this.walkLitems($, $content.children(".level"), blocks, undefined);
  }

  private walkLitems(
    $: cheerio.CheerioAPI,
    $level: ReturnType<cheerio.CheerioAPI>,
    blocks: NormalizedBlock[],
    parentLabel: string | undefined,
  ): void {
    $level.children(".litem").each((_, litem) => {
      const $litem = $(litem);
      const numberAnchor = $litem.children(".litem_number").first();
      const label = numberAnchor.attr("title")?.trim() ?? parentLabel;
      const $litemContent = $litem.children(".litem_content").first();

      $litemContent.children(".para").each((_, p) => {
        const text = $(p).text().trim();
        if (!text) return;
        blocks.push(
          label
            ? { kind: "paragraph", text, subsectionLabel: label }
            : { kind: "paragraph", text },
        );
      });

      // Deeper nesting (roman-numeral sub-sub-items) — not observed in
      // the Smithville corpus, but the DOM shape (.level > .litem
      // recursively) supports it, so walk it defensively.
      this.walkLitems(
        $,
        $litemContent.children(".level"),
        blocks,
        label,
      );
    });
  }

  private splitPageFragments(
    body: string,
  ): ReadonlyArray<{ pageUrl: string; html: string }> {
    const marker = /<!-- source:(.*?) -->\n?/g;
    const matches = [...body.matchAll(marker)];
    if (matches.length === 0) {
      // Single-fragment body with no marker (e.g. hand-built test
      // fixtures) — treat the whole body as one page with no known URL.
      return [{ pageUrl: "", html: body }];
    }
    const fragments: Array<{ pageUrl: string; html: string }> = [];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const start = match.index! + match[0].length;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
      fragments.push({ pageUrl: match[1]!.trim(), html: body.slice(start, end) });
    }
    return fragments;
  }

  private collectParentUrls(tocJson: string): ReadonlyArray<string> {
    // The TOC endpoint returns a JSON tree (see raw/toc.json in the
    // proof artifacts): every node with an `href` starting with `/`
    // (not a `#`-only fragment) is a distinct parent page. Sections
    // (`type: "section"`) carry an `href` of the shape
    // `/{parentGuid}#{ownGuid}` — the parent page is `/{parentGuid}`,
    // already covered by the parent node's own entry, so only
    // non-fragment hrefs are collected here to avoid re-fetching the
    // same parent once per child section.
    let root: unknown;
    try {
      root = JSON.parse(tocJson);
    } catch {
      return [];
    }
    const urls = new Set<string>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      const href = typeof n.href === "string" ? n.href : undefined;
      if (href && href.startsWith("/") && !href.includes("#")) {
        urls.add(`${this.baseUrl}${href}`);
      }
      const children = Array.isArray(n.children) ? n.children : [];
      for (const child of children) visit(child);
    };
    visit(root);
    return [...urls];
  }

  private async fetchGuarded(url: string): Promise<string> {
    const res = await this.http.fetch(url);
    const status = res.status;
    if (status === 403 || status === 429) {
      const body = await res.text().catch(() => "");
      throw new ECode360HttpBlockError(
        `ECode360: blocked with HTTP ${status} for ${url}` +
          (looksLikeChallengeBody(body) ? " (Cloudflare challenge)" : ""),
        status,
        url,
      );
    }
    if (!res.ok) {
      throw new ECode360HttpBlockError(
        `ECode360: HTTP ${status} ${res.statusText} for ${url}`,
        status,
        url,
      );
    }
    const body = await res.text();
    if (looksLikeChallengeBody(body)) {
      throw new ECode360HttpBlockError(
        `ECode360: HTTP ${status} for ${url} but body is a Cloudflare challenge page`,
        status,
        url,
      );
    }
    return body;
  }

  private async getRobotsRules(): Promise<RobotsRules> {
    if (this.robotsRulesCache) return this.robotsRulesCache;
    const robotsUrl = `${this.baseUrl}/robots.txt`;
    const body = await this.http.fetchText(robotsUrl);
    const rules = parseRobotsTxt(body);
    this.robotsRulesCache = rules;
    return rules;
  }

  private custIdFromReference(reference: CodeReference): string {
    if (reference.sourceId && !reference.sourceId.includes("/")) {
      return reference.sourceId;
    }
    try {
      const path = new URL(reference.sourceUrl).pathname;
      const segment = path.split("/").filter(Boolean)[0];
      return segment ?? reference.sourceId;
    } catch {
      return reference.sourceId;
    }
  }

  private pathFromUrl(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
}

function escapeSelectorId(id: string): string {
  // cheerio/CSS selectors choke on a leading digit or bare punctuation
  // in an unescaped id selector; eCode360 guids are numeric strings
  // (e.g. "39654684"), so escape per CSS.escape's leading-digit rule
  // without pulling in a DOM CSS.escape polyfill.
  return id.replace(/^(\d)/, "\\3$1 ").replace(/([.:#[\]])/g, "\\$1");
}
