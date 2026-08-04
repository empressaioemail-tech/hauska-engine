/**
 * Adapter conformance + content-specific pass for the eCode360 adapter.
 *
 * Fixtures are real Smithville (SM6484) pages saved during the
 * 2026-07-29 proof wave — copied from
 * `P:/tmp/tx_scraper_proofs/smithville/raw/` (see file header comments
 * in `../index.ts` for the full provenance + spec derivation). No live
 * network: `StubFetch` below serves fixture bodies keyed by URL path
 * and never calls `undici`/the real internet.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAdapterConformance } from "../../__fixtures__/conformance.js";
import { RespectfulFetch } from "../../http.js";
import { ECode360Adapter, ECode360HttpBlockError } from "../index.js";
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
const PAGE_LITEM = fixture("page-39654892-litem-nesting.html");
const CHALLENGE_PAGE = fixture("challenge-page-cloudflare.html");

/** Fakes just enough of the undici Response surface for fetchGuarded(). */
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

/**
 * Serves fixture bodies keyed by URL path — no network. `blockPaths`
 * lets a test simulate a specific path returning a 403 challenge.
 */
class StubFetch extends RespectfulFetch {
  constructor(
    private readonly routes: Record<string, string>,
    private readonly blockPaths: ReadonlySet<string> = new Set(),
  ) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }

  override async fetch(url: string) {
    const path = new URL(url).pathname;
    if (this.blockPaths.has(path)) {
      return fakeResponse(403, CHALLENGE_PAGE) as never;
    }
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

const ROUTES: Record<string, string> = {
  "/SM6484": LANDING_HTML,
  "/toc/SM6484": TOC_JSON,
  "/39654682": PAGE_ART_101, // chapter parent — reuse article page body for routing coverage
  "/39654683": PAGE_ART_101,
  "/39654739": PAGE_DIVISION_1, // article 1.02 parent — reuse division page body
  "/39654740": PAGE_DIVISION_1,
  "/39654761": PAGE_DIVISION_2,
};

const fixtureReference: CodeReference = {
  sourceId: "SM6484",
  jurisdictionTenant: "smithville-tx",
  editionLabel: "City of Smithville, TX Code",
  sourceUrl: "https://ecode360.com/SM6484",
};

function buildAdapter(
  routes: Record<string, string> = ROUTES,
  blockPaths?: ReadonlySet<string>,
): ECode360Adapter {
  return new ECode360Adapter({
    http: new StubFetch(routes, blockPaths),
    robotsRules: ROBOTS_RULES,
  });
}

runAdapterConformance({ adapter: buildAdapter(), fixtureReference });

describe("ECode360Adapter — content-specific", () => {
  it("emits the synthetic depth-1 TOC heading + section/division headings + paragraphs", async () => {
    const adapter = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const kinds = new Set(normalized.blocks.map((b) => b.kind));
    expect(kinds.has("heading")).toBe(true);
    expect(kinds.has("paragraph")).toBe(true);

    const docTitle = normalized.blocks[0];
    expect(docTitle?.kind).toBe("heading");
    if (docTitle?.kind === "heading") {
      expect(docTitle.depth).toBe(1);
      expect(docTitle.text).toContain("Table of Contents");
    }
  });

  it("maps data-code-content-type to the proven depth scheme (part/article=3, subarticle=4, section=5)", async () => {
    const adapter = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const headings = normalized.blocks.filter((b) => b.kind === "heading");

    const divisionHeadings = headings.filter(
      (b) => b.kind === "heading" && b.label?.startsWith("Division"),
    );
    expect(divisionHeadings.length).toBeGreaterThan(0);
    for (const h of divisionHeadings) {
      if (h.kind === "heading") expect(h.depth).toBe(3);
    }

    const sectionHeadings = headings.filter(
      (b) => b.kind === "heading" && b.label?.startsWith("§"),
    );
    expect(sectionHeadings.length).toBeGreaterThan(0);
    for (const h of sectionHeadings) {
      if (h.kind === "heading") expect(h.depth).toBe(5);
    }
  });

  it("does not double-count headings from the nav#toc sidebar", async () => {
    // page-39654740-division1.html carries 17 data-code-content-type
    // markers inside <nav id="toc"> AND 17 more in #childContent (the
    // real content) — 34 total in the raw fixture. If normalizePage()
    // walked the whole document instead of scoping to #childContent,
    // this page alone would emit 34 headings instead of 17.
    const adapter = buildAdapter({ "/SM6484": LANDING_HTML, "/toc/SM6484": JSON.stringify({
      guid: "SM6484", href: "/SM6484", children: [
        { guid: "39654740", href: "/39654740", children: [] },
      ],
    }) , "/39654740": PAGE_DIVISION_1 });
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const headings = normalized.blocks.filter((b) => b.kind === "heading");
    // 1 synthetic doc-title heading + exactly 17 from the real content.
    expect(headings.length).toBe(18);
  });

  it("extracts nested .litem subsection labels from title attributes", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch({
        "/SM6484": LANDING_HTML,
        "/toc/SM6484": JSON.stringify({
          guid: "SM6484",
          href: "/SM6484",
          children: [{ guid: "39654892", href: "/39654892", children: [] }],
        }),
        "/39654892": PAGE_LITEM,
      }),
      robotsRules: ROBOTS_RULES,
    });
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const labeled = normalized.blocks.filter(
      (b) => b.kind === "paragraph" && b.subsectionLabel,
    );
    expect(labeled.length).toBeGreaterThanOrEqual(2);
    const labels = labeled.map((b) =>
      b.kind === "paragraph" ? b.subsectionLabel : undefined,
    );
    expect(labels).toContain("1.06.008(a)");
    expect(labels).toContain("1.06.008(b)");
  });

  it("drops .history/.footnotes text from paragraph blocks (matches the proven corpus)", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch({
        "/SM6484": LANDING_HTML,
        "/toc/SM6484": JSON.stringify({
          guid: "SM6484",
          href: "/SM6484",
          children: [{ guid: "39654740", href: "/39654740", children: [] }],
        }),
        "/39654740": PAGE_DIVISION_1,
      }),
      robotsRules: ROBOTS_RULES,
    });
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const allText = normalized.blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => (b.kind === "paragraph" ? b.text : ""))
      .join(" ");
    // "1987 Code, ch. 1, sec. 16A" is inside a .history div for
    // section 1.02.001 in the raw fixture — must not leak into any
    // paragraph's text.
    expect(allText).not.toContain("1987 Code, ch. 1, sec. 16A");
  });

  it("normalize() is pure across repeated calls on the same RawCode", async () => {
    const adapter = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const a = await adapter.normalize(raw);
    const b = await adapter.normalize(raw);
    expect(a.blocks).toEqual(b.blocks);
  });

  it("section heading `label` carries the title, not just the bare number (2026-08-04 OPS-9 S3 regression guard)", async () => {
    // Diagnosed via the Smithville eval failure (top-3 retrieval 86.7%
    // vs the 90% bar): `label` used to be truncated to the substring
    // before the first colon ("§ 1.08.037"), dropping the title
    // ("General regulations.") that `splitHeadingLabel()` (extractor.ts)
    // needs when it prefers `label` over `text`. `label` must now carry
    // the same title-bearing content as `text` for every section
    // heading — this is what let the extractor recover the title for
    // Smithville's already-captured artifact too (extractor.ts falls
    // back to `text` only when `label`'s own parse yields an empty
    // title, so `label` itself must stop being title-less at the
    // source, not just be papered over downstream).
    const adapter = buildAdapter();
    const raw = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const sectionHeadings = normalized.blocks.filter(
      (b) => b.kind === "heading" && b.label?.startsWith("§"),
    );
    expect(sectionHeadings.length).toBeGreaterThan(0);
    for (const h of sectionHeadings) {
      if (h.kind !== "heading") continue;
      expect(h.label).toBe(h.text);
    }
  });
});

describe("ECode360Adapter — fail-loud on block (never silent-empty)", () => {
  it("throws ECode360HttpBlockError on a 403 Cloudflare challenge response", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch(ROUTES, new Set(["/toc/SM6484"])),
      robotsRules: ROBOTS_RULES,
    });
    await expect(adapter.fetch(fixtureReference)).rejects.toThrow(
      ECode360HttpBlockError,
    );
  });

  it("the thrown error names the blocked URL and status — never an empty RawCode", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch(ROUTES, new Set(["/toc/SM6484"])),
      robotsRules: ROBOTS_RULES,
    });
    try {
      await adapter.fetch(fixtureReference);
      expect.unreachable("expected fetch() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ECode360HttpBlockError);
      const blockErr = err as InstanceType<typeof ECode360HttpBlockError>;
      expect(blockErr.status).toBe(403);
      expect(blockErr.url).toContain("/toc/SM6484");
    }
  });

  it("throws on a challenge page served with the content-page fetch (not just the TOC)", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch(ROUTES, new Set(["/39654740"])),
      robotsRules: ROBOTS_RULES,
    });
    await expect(adapter.fetch(fixtureReference)).rejects.toThrow(
      ECode360HttpBlockError,
    );
  });

  it("normalize() also fails loud if handed a RawCode whose body is a challenge page", async () => {
    const adapter = buildAdapter();
    const raw = {
      metadata: await adapter.metadata(fixtureReference),
      contentType: "text/html",
      body: `<!-- source:https://ecode360.com/39654740 -->\n${CHALLENGE_PAGE}`,
    };
    await expect(adapter.normalize(raw)).rejects.toThrow(
      ECode360HttpBlockError,
    );
  });
});

describe("ECode360Adapter — robots gate", () => {
  it("refuses to fetch a disallowed path without ever calling the network", async () => {
    let networkCalled = false;
    class TrackingStubFetch extends StubFetch {
      override async fetch(url: string) {
        networkCalled = true;
        return super.fetch(url);
      }
    }
    const adapter = new ECode360Adapter({
      http: new TrackingStubFetch(ROUTES),
      robotsRules: parseRobotsTxt(
        "User-agent: *\nDisallow: /toc\n",
      ),
    });
    await expect(adapter.fetch(fixtureReference)).rejects.toThrow(
      /robots\.txt disallows/,
    );
    expect(networkCalled).toBe(false);
  });

  it("fetches its own robots.txt when no robotsRules override is given", async () => {
    const adapter = new ECode360Adapter({
      http: new StubFetch({ ...ROUTES, "/robots.txt": ROBOTS_TXT }),
    });
    const raw = await adapter.fetch(fixtureReference);
    expect(raw.body.length).toBeGreaterThan(0);
  });
});

describe("ECode360Adapter — capabilities", () => {
  it("declares supportsDiscovery: false and returns [] from discover()", async () => {
    const adapter = buildAdapter();
    expect(adapter.capabilities.supportsDiscovery).toBe(false);
    expect(await adapter.discover()).toEqual([]);
  });

  it("never uses a Chrome-spoofed or bare-Mozilla UA by default", () => {
    // Constructing with no http override must select the civil
    // PublicLawTextFetcher profile, not the package-wide
    // HauskaEngineIngest default or any Chrome-shaped UA — a spoofed UA
    // is what drew the Cloudflare challenge in the live proof.
    const adapter = new ECode360Adapter();
    // @ts-expect-error -- reaching into a private field for a UA-choice
    // regression guard; there's no public getter for this and adding
    // one only for a test would widen the adapter's surface.
    const uaHeader = (adapter.http as RespectfulFetch)["userAgent"] as string;
    expect(uaHeader).toContain("PublicLawTextFetcher");
    expect(uaHeader).not.toContain("Chrome");
  });
});
