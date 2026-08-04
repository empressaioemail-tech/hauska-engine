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
    //
    // Rate: 0.5 rps, not 1. The 2026-07-29/30 proof ran at 0.5 rps
    // deliberately and cleared a mid-crawl 429. The OPS-9 S3 proving
    // run (2026-08-04) reproduced a live 429 + Cloudflare challenge
    // TWICE at this adapter's then-default of 1 rps (two independent
    // attempts, each blocked 16-21s in, one after a 20s backoff-retry)
    // and then completed cleanly end-to-end with zero blocks at 0.5
    // rps on the very next attempt, same UA, same headers, same
    // target. 1 rps is empirically unsafe against this host's
    // Cloudflare tier; 0.5 rps is the only rate verified live twice
    // (proof + S3 rerun) to complete without a block.
    this.http =
      opts.http ??
      new RespectfulFetch({
        userAgent: CIVIL_USER_AGENT,
        maxRequestsPerSecondPerHost: 0.5,
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

    return { metadata: raw.metadata, blocks: this.dedupeSectionBlocks(blocks) };
  }

  /**
   * Belt-and-braces safety net for `collectParentUrls()`'s shape-driven
   * container exclusion (see that method's doc comment for the root
   * cause this defends against): if a TOC shape ever slips past the
   * container check — a node mixing fragment-href section children
   * with non-fragment-href container children, or any other future
   * shape this adapter hasn't seen yet — the same section heading can
   * still arrive twice in `blocks`, sourced from two different pages.
   *
   * Distinguishing "nav-only occurrence" from "body-bearing occurrence"
   * per-page is NOT reliable here: a section with genuinely empty body
   * text (a reserved/placeholder section, several exist in this corpus)
   * is indistinguishable from a nav-only duplicate by paragraph count
   * alone. Dedupe instead at the (sectionLabel, content-hash) level —
   * group each `section`-kind heading with the paragraph/definition/etc.
   * blocks that follow it up to the next heading, hash that group's
   * concatenated text, and keep only the first occurrence of each
   * (label, hash) pair. Two occurrences of the same label with
   * DIFFERENT content hashes are kept (that would mean genuinely
   * different content under the same label, which this dedup should
   * never silently discard). Every drop is counted and logged — never
   * silent, per the fail-loud posture this file already commits to for
   * blocked fetches.
   */
  private dedupeSectionBlocks(
    blocks: ReadonlyArray<NormalizedBlock>,
  ): ReadonlyArray<NormalizedBlock> {
    // First pass: slice `blocks` into runs, each starting at a heading
    // (or the leading run before the first heading) and running to the
    // next heading.
    interface Run {
      heading: NormalizedBlock | undefined;
      body: NormalizedBlock[];
    }
    const runs: Run[] = [];
    let current: Run = { heading: undefined, body: [] };
    for (const block of blocks) {
      if (block.kind === "heading") {
        runs.push(current);
        current = { heading: block, body: [] };
      } else {
        current.body.push(block);
      }
    }
    runs.push(current);

    const seen = new Map<string, true>();
    const kept: NormalizedBlock[] = [];
    let droppedCount = 0;
    const droppedLabels: string[] = [];

    for (const run of runs) {
      if (!run.heading) {
        // Leading run before any heading (never observed in practice,
        // but handled so this pass is total over any input).
        kept.push(...run.body);
        continue;
      }
      const isSectionHeading =
        run.heading.kind === "heading" && "label" in run.heading && !!run.heading.label;
      if (!isSectionHeading) {
        // Only section-labeled headings (§ x.xx.xxx) are deduped —
        // structural headings (part/article/division) legitimately
        // repeat across the document only when they ARE the same node
        // visited twice, which the container-exclusion fix already
        // prevents; leaving them unguarded here avoids over-reaching
        // beyond the diagnosed failure mode.
        kept.push(run.heading, ...run.body);
        continue;
      }
      const label = (run.heading as { label?: string }).label ?? "";
      const contentText = run.body
        .map((b) => ("text" in b ? b.text : JSON.stringify(b)))
        .join(" ");
      const key = `${label}${hashString(contentText)}`;
      if (seen.has(key)) {
        droppedCount++;
        droppedLabels.push(label);
        continue;
      }
      seen.set(key, true);
      kept.push(run.heading, ...run.body);
    }

    if (droppedCount > 0) {
      // Fail-loud, not fail-silent: this is a safety net catching a
      // shape this adapter's TOC-walk exclusion didn't anticipate, so
      // an operator needs to see it happened even though the run
      // otherwise succeeds.
      // eslint-disable-next-line no-console -- deliberate operator-facing signal, not debug noise
      console.warn(
        `ECode360Adapter.normalize: dropped ${droppedCount} duplicate section marker(s) ` +
          `(identical label + content hash seen on more than one fetched page): ` +
          `${droppedLabels.join(", ")}`,
      );
    }

    return kept;
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

  /**
   * Walk the TOC tree and collect the URLs of pages that actually carry
   * unique content — excluding pure navigational container nodes whose
   * "content" is entirely covered by their own children's pages.
   *
   * Diagnosed 2026-08-04 (OPS-9 S3 fix): the TOC endpoint returns a JSON
   * tree (see raw/toc.json in the proof artifacts) where EVERY node —
   * chapter, division, part, article, subarticle, section — carries an
   * `href`. Sections (`type: "section"`) carry a fragment href of the
   * shape `/{parentGuid}#{ownGuid}`; the original implementation
   * collected every non-fragment href as a "parent page," which is
   * correct for a node whose children are section leaves (its own page
   * IS the content page for those sections) but WRONG for a node whose
   * children are themselves separately-paged containers (part/article/
   * etc. with their own non-fragment hrefs) — that container's own page
   * is pure chrome/summary and eCode360 renders the FIRST child's
   * section markers on it too, producing a duplicate content-marker
   * for every section under that child. Confirmed live: `39654739`
   * ("ADMINISTRATION", type `part`) has two `article` children
   * (`39654740`, `39654761`), each separately paged; collecting
   * `39654739`'s own page tripled the `§ 1.02.001` marker (present on
   * `39654739`, `39654740`, and `39654761` instead of just the latter
   * two). The July 2026-07-29/30 proof's own normalized.json excludes
   * `39654739` from its 149-page effective set, confirming this
   * exclusion is the historically correct behavior, not a new rule.
   *
   * Rule (verified shape-driven, not a hardcoded page list — checked
   * against all 44 container/child-href collision nodes in the live
   * Smithville tree with zero mixed cases): a node's own page is
   * collected only when it is NOT a pure container of other paged
   * nodes — i.e., when it has no children, or when none of its direct
   * children carry a non-fragment href of their own. A node all of
   * whose children carry non-fragment hrefs (distinct pages) is a nav
   * container; skip its own href and let the recursive walk collect
   * its children's (and their descendants') pages instead. A node
   * that mixes fragment-href section children with non-fragment-href
   * container children was not observed in the live tree, but if one
   * appears, this rule still collects that node's own page (since not
   * ALL of its children are non-fragment), which is the safe default —
   * it may occasionally re-collect a page a container child would also
   * separately cover, but never drops real section content.
   */
  private collectParentUrls(tocJson: string): ReadonlyArray<string> {
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
      const children = Array.isArray(n.children) ? n.children : [];

      if (href && href.startsWith("/") && !href.includes("#")) {
        const isPureContainer =
          children.length > 0 &&
          children.every((child) => {
            if (!child || typeof child !== "object") return false;
            const childHref = (child as Record<string, unknown>).href;
            return (
              typeof childHref === "string" &&
              childHref.startsWith("/") &&
              !childHref.includes("#")
            );
          });
        if (!isPureContainer) {
          urls.add(`${this.baseUrl}${href}`);
        }
      }

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

/**
 * Small deterministic string hash (FNV-1a, 32-bit) used by
 * `dedupeSectionBlocks()` to key duplicate-content detection. Not
 * cryptographic — collision resistance within one document's section
 * count (hundreds, not millions) is all this needs.
 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
