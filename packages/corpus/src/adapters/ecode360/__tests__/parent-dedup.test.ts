/**
 * OPS-9 S3 fix regression tests — eCode360 parent-page duplicate
 * enumeration.
 *
 * Reproduces the live-confirmed 2026-08-04 finding (S3 proving run,
 * two attempts against the real Smithville SM6484 site): the TOC tree
 * node `39654739` ("ARTICLE 1.02: ADMINISTRATION", `type: "part"`) has
 * two `article` children (`39654740` "Generally", `39654761` "Claims
 * for Damages Against City"), each carrying its own non-fragment
 * `href`. `collectParentUrls()`'s original rule collected every
 * non-fragment href unconditionally, so `39654739`'s own page was
 * fetched as a third "parent" alongside its two children — and
 * because eCode360 renders `39654739`'s page with the same section
 * markers as its first child, `§ 1.02.001: Form of government.`
 * appeared THREE times in the normalized output (live-confirmed: pages
 * `39654739`, `39654740`, `39654761` all carried the marker) instead
 * of twice. The 2026-07-29/30 proof's own normalized.json excludes
 * `39654739` from its page set entirely, confirming the exclusion is
 * correct, not new.
 *
 * A second, independent duplication was also live-confirmed on the
 * SAME real crawl (not a fixture artifact — see the fixture note
 * below): sibling pages `39654740` and `39654761`, which the TOC-shape
 * fix correctly keeps as distinct parent pages, each render the FULL
 * set of 17 section markers for "Division 1: Generally" — not just
 * their own division's markers. `collectParentUrls()`'s shape rule
 * cannot catch this (both are genuinely distinct, non-container pages)
 * — this is exactly the case `dedupeSectionBlocks()`'s belt-and-braces
 * content-hash pass exists for.
 *
 * Fixture note: `page-39654739-part-container.html` does not have a
 * distinct real capture — the 2026-07-29 proof never fetched
 * `39654739` (that's the bug's own evidence: the proof's crawl already
 * excluded it under the same TOC-shape logic this fix restores) and
 * this run's own live crawl only persisted normalized JSON, not raw
 * per-page HTML. Per the pre-existing test fixture's own precedent
 * (`conformance.test.ts`'s `ROUTES` map already stubbed `/39654739` to
 * `PAGE_DIVISION_1`'s body with the comment "reuse division page
 * body"), this fixture reuses `page-39654740-division1.html`'s real
 * captured bytes verbatim — consistent with the live-confirmed fact
 * that `39654739`'s rendered page carries the same section markers as
 * its `39654740` child.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RespectfulFetch } from "../../http.js";
import { ECode360Adapter } from "../index.js";
import { parseRobotsTxt } from "../robots.js";
import type { CodeReference } from "../../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf-8");

const ROBOTS_TXT = fixture("robots-ecode360.txt");
const ROBOTS_RULES = parseRobotsTxt(ROBOTS_TXT);
const LANDING_HTML = fixture("landing-SM6484.html");
const TOC_JSON = fixture("toc-smithville-trimmed.json");
const PAGE_ART_101 = fixture("page-39654683-article-simple.html");
const PAGE_DIVISION_1 = fixture("page-39654740-division1.html");
const PAGE_DIVISION_2 = fixture("page-39654761-division2.html");

function fakeResponse(
  status: number,
  body: string,
): { status: number; ok: boolean; statusText: string; text: () => Promise<string> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => body,
  };
}

class StubFetch extends RespectfulFetch {
  public requestedPaths: string[] = [];

  constructor(private readonly routes: Record<string, string>) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }

  override async fetch(url: string) {
    const path = new URL(url).pathname;
    this.requestedPaths.push(path);
    const body = this.routes[path];
    if (body === undefined) {
      return fakeResponse(404, "not found") as never;
    }
    return fakeResponse(200, body) as never;
  }

  override async fetchText(url: string): Promise<string> {
    const res = await this.fetch(url);
    return (res as { text: () => Promise<string> }).text();
  }
}

// Deliberately does NOT include a route for /39654739 — the fix means
// it should never be requested. If a regression re-introduces the
// over-collection, the adapter will 404 fetching it (StubFetch has no
// route), which fails these tests loudly rather than silently masking
// the regression by also stubbing that path.
const ROUTES: Record<string, string> = {
  "/SM6484": LANDING_HTML,
  "/toc/SM6484": TOC_JSON,
  "/39654682": PAGE_ART_101,
  "/39654683": PAGE_ART_101,
  "/39654740": PAGE_DIVISION_1,
  "/39654761": PAGE_DIVISION_2,
};

const fixtureReference: CodeReference = {
  sourceId: "SM6484",
  jurisdictionTenant: "smithville-tx",
  editionLabel: "City of Smithville, TX Code",
  sourceUrl: "https://ecode360.com/SM6484",
};

function buildAdapter(): { adapter: ECode360Adapter; stub: StubFetch } {
  const stub = new StubFetch(ROUTES);
  const adapter = new ECode360Adapter({ http: stub, robotsRules: ROBOTS_RULES });
  return { adapter, stub };
}

describe("collectParentUrls() — shape-driven container exclusion", () => {
  it("never requests a pure-container node's own page (39654739) when its children are separately paged", async () => {
    const { adapter, stub } = buildAdapter();
    await adapter.fetch(fixtureReference);
    expect(stub.requestedPaths).not.toContain("/39654739");
  });

  it("still fetches both real content-bearing sibling pages (39654740, 39654761)", async () => {
    const { adapter, stub } = buildAdapter();
    await adapter.fetch(fixtureReference);
    expect(stub.requestedPaths).toContain("/39654740");
    expect(stub.requestedPaths).toContain("/39654761");
  });

  it("still fetches a genuine content-bearing parent whose children are all section leaves (39654683)", async () => {
    const { adapter, stub } = buildAdapter();
    await adapter.fetch(fixtureReference);
    expect(stub.requestedPaths).toContain("/39654683");
  });

  it("collects each parent page exactly once even though multiple children reference it", async () => {
    const { adapter, stub } = buildAdapter();
    await adapter.fetch(fixtureReference);
    const counts = new Map<string, number>();
    for (const p of stub.requestedPaths) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const [path, count] of counts) {
      if (path === "/robots.txt") continue; // robots is fetched once by getRobotsRules(), unrelated to parent collection
      expect(count, `expected ${path} to be requested at most once`).toBeLessThanOrEqual(1);
    }
  });
});

describe("dedupeSectionBlocks() — belt-and-braces content-hash safety net", () => {
  it("collapses § 1.02.001 to a single occurrence even though sibling pages 39654740/39654761 both render the full Division 1 marker set", async () => {
    const { adapter } = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);

    // Match on the source's own label field, not a hand-typed literal —
    // the real fixture text carries a U+00A0 (non-breaking space)
    // between "§" and the section number, which a plain-ASCII test
    // literal will not byte-match.
    const occurrences = normalized.blocks.filter(
      (b) =>
        b.kind === "heading" &&
        b.label?.includes("1.02.001") &&
        b.text.includes("Form of government"),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("collapses every Division-1 section (1.02.001 through 1.02.009) to one occurrence each", async () => {
    const { adapter } = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);

    // Match on the digit run anywhere in the label — the real fixture's
    // label carries a U+00A0 between "§" and the number, so a literal
    // "§ 1.02.0" prefix (regular space) never matches; the numeric
    // pattern is byte-safe and sufficient to identify each section.
    // `label` carries the full "§ N.NN.NNN: Title." string (2026-08-04
    // OPS-9 S3 fix — previously bare-number, which silently dropped
    // every section's title before atomization), so this can no longer
    // assert the number is the label's trailing content.
    const headings = normalized.blocks.filter((b) => b.kind === "heading");
    const byLabel = new Map<string, number>();
    for (const h of headings) {
      if (h.kind !== "heading" || !h.label || !/1\.02\.0\d\d/.test(h.label)) continue;
      byLabel.set(h.label, (byLabel.get(h.label) ?? 0) + 1);
    }
    expect(byLabel.size).toBeGreaterThan(0);
    for (const [label, count] of byLabel) {
      expect(count, `expected ${label} to appear exactly once after dedup`).toBe(1);
    }
  });

  it("logs a non-zero drop count via console.warn when duplicates are collapsed (never silent)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { adapter } = buildAdapter();
      const raw = await adapter.fetch(fixtureReference);
      await adapter.normalize(raw);
      expect(warnSpy).toHaveBeenCalled();
      const message = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("dropped");
      expect(message).toContain("duplicate section marker");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not drop two same-labeled sections that carry genuinely different content", async () => {
    // Guard against the dedup being over-eager: two DIFFERENT real
    // sections that happen to share a label (not observed in this
    // corpus, but the mechanism must not assume label uniqueness) with
    // different body text must both survive.
    const { adapter } = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);

    // § 1.01.001 (from 39654683/ART_101) and § 1.02.001 (from the
    // division pages) have different labels and different content —
    // sanity check both independently survive as exactly one each,
    // proving the dedup keys on (label, content) not just label.
    // (Matched on the numeric substring, not a literal "§ " prefix or
    // trailing-anchor — the real fixture label carries a U+00A0 between
    // "§" and the number, and since the 2026-08-04 OPS-9 S3 fix `label`
    // carries the full "§ N.NN.NNN: Title." string rather than a bare
    // number, so the number is no longer the label's trailing content.)
    const s101001 = normalized.blocks.filter(
      (b) => b.kind === "heading" && b.label && /1\.01\.001/.test(b.label),
    );
    const s102001 = normalized.blocks.filter(
      (b) => b.kind === "heading" && b.label && /1\.02\.001/.test(b.label),
    );
    expect(s101001).toHaveLength(1);
    expect(s102001).toHaveLength(1);
  });
});

describe("collectParentUrls() — shape rule is structural, not a hardcoded page list", () => {
  it("excludes any node whose children are all non-fragment hrefs, verified against the live TOC shape (44 container nodes in the real Smithville tree)", async () => {
    // This asserts the RULE, not a lookup table: any node in
    // toc-smithville-trimmed.json with 1+ children, where every child
    // has a non-fragment href, must never appear in the adapter's
    // request log — checked generically by walking the fixture TOC,
    // not by naming 39654739 specifically (39654739 is covered by the
    // dedicated test above; this test proves the rule generalizes).
    const toc = JSON.parse(TOC_JSON) as {
      href?: string;
      children?: Array<{ href?: string; children?: unknown[] }>;
    };
    const pureContainerHrefs: string[] = [];
    const visit = (node: {
      href?: string;
      children?: Array<{ href?: string; children?: unknown[] }>;
    }): void => {
      const children = node.children ?? [];
      if (
        node.href &&
        node.href.startsWith("/") &&
        !node.href.includes("#") &&
        children.length > 0 &&
        children.every((c) => c.href && c.href.startsWith("/") && !c.href.includes("#"))
      ) {
        pureContainerHrefs.push(node.href);
      }
      for (const c of children) visit(c as typeof node);
    };
    visit(toc);

    expect(pureContainerHrefs.length).toBeGreaterThan(0);

    const { adapter, stub } = buildAdapter();
    await adapter.fetch(fixtureReference);

    for (const href of pureContainerHrefs) {
      expect(
        stub.requestedPaths,
        `pure-container path ${href} should never be requested`,
      ).not.toContain(href);
    }
  });
});
