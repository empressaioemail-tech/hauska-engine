/**
 * Adapter conformance pass for the Municode HTML adapter.
 *
 * Uses a captured inline HTML fixture so the conformance suite runs
 * deterministically without any network. The first-city test (51
 * Stream 1A exit) captures a real Municode TOC fixture and pins it
 * here.
 */

import { describe, expect, it } from "vitest";

import { runAdapterConformance } from "../../__fixtures__/conformance.js";
import { RespectfulFetch } from "../../http.js";
import { MunicodeHtmlAdapter } from "../index.js";
import {
  MunicodeJsonClient,
  type MunicodeContentEnvelope,
  type MunicodeTocNode,
} from "../json-client.js";
import type { CodeReference, RawCode } from "../../types.js";

class StubFetch extends RespectfulFetch {
  constructor(private readonly body: string) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchText(): Promise<string> {
    return this.body;
  }
}

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta name="publication-date" content="2024-01-01" />
    <meta name="jurisdiction-name" content="Test Jurisdiction" />
  </head>
  <body>
    <h1 id="chapter-1">Chapter 1 — General Provisions</h1>
    <h2 id="article-1">Article 1 — Definitions</h2>
    <h3 id="sec-1-01">§ 1.01 Scope</h3>
    <p>This chapter governs the application of subsequent provisions.</p>
    <p>For the purposes of this chapter, see § 5.04(b) and § 7.12.</p>
    <h3 id="sec-1-02">§ 1.02 Definitions</h3>
    <dl>
      <dt>Lot</dt>
      <dd>A parcel of land identified by recorded plat.</dd>
      <dt>Setback</dt>
      <dd>The minimum required distance from a lot line.</dd>
    </dl>
    <aside class="amendment">
      <span class="ordinance-id">ORD-2024-12</span>
      <span class="effective-date">2024-06-01</span>
      <span class="authority">City Council</span>
      Amends § 1.01 to expand application scope.
    </aside>
  </body>
</html>`;

const fixtureReference: CodeReference = {
  sourceId: "test/test-jurisdiction",
  jurisdictionTenant: "test-jurisdiction",
  editionLabel: "Test Jurisdiction Code 2024",
  sourceUrl: "https://library.municode.com/codes/test/test-jurisdiction",
};

const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(FIXTURE_HTML) });

runAdapterConformance({ adapter, fixtureReference });

describe("MunicodeHtmlAdapter — content-specific", () => {
  it("emits at least one heading, paragraph, definition, and cross-reference", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const kinds = new Set(normalized.blocks.map((b) => b.kind));
    expect(kinds.has("heading")).toBe(true);
    expect(kinds.has("paragraph")).toBe(true);
    expect(kinds.has("definition")).toBe(true);
    expect(kinds.has("cross-reference")).toBe(true);
  });

  it("resolves cross-reference text to a target section label", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const xrefs = normalized.blocks.filter(
      (b) => b.kind === "cross-reference",
    );
    expect(xrefs.length).toBeGreaterThanOrEqual(2);
    for (const xref of xrefs) {
      if (xref.kind !== "cross-reference") continue;
      expect(xref.targetSectionLabel).toMatch(/\d+/);
    }
  });

  it("extracts definitions from <dl> glossary", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const defs = normalized.blocks.filter((b) => b.kind === "definition");
    expect(defs.length).toBe(2);
  });

  it("extracts amendment records", async () => {
    const raw: RawCode = await adapter.fetch(fixtureReference);
    const normalized = await adapter.normalize(raw);
    const amendments = normalized.blocks.filter(
      (b) => b.kind === "amendment-record",
    );
    expect(amendments.length).toBe(1);
  });
});

// Stub JSON client: a one-chapter / two-article / six-section TOC.
// `getCodesContent` records every call and returns the whole article's
// Docs for any leaf within it — mirroring Municode's real fan-out.
class StubJsonClient extends MunicodeJsonClient {
  public readonly codesContentCalls: string[] = [];

  override async getClientContent() {
    return { codes: [{ productName: "Code of Ordinances", productId: 100 }] };
  }
  override async getLatestJob() {
    return { Id: 9, Name: "Supplement 1", ProductId: 100 };
  }
  override async getTocChildren(
    _jobId: number,
    _productId: number,
    nodeId?: string,
  ): Promise<MunicodeTocNode[]> {
    const n = (
      Id: string,
      Heading: string,
      ParentId: string,
      HasChildren: boolean,
    ): MunicodeTocNode => ({
      Id,
      Heading,
      ParentId,
      NodeDepth: 1,
      HasChildren,
      DocOrderId: 0,
    });
    if (!nodeId) return [n("CH1", "CHAPTER 1 - ZONING", "", true)];
    if (nodeId === "CH1")
      return [
        n("CH1_ART1", "ARTICLE I. - GENERAL", "CH1", true),
        n("CH1_ART2", "ARTICLE II. - DISTRICTS", "CH1", true),
      ];
    if (nodeId === "CH1_ART1")
      return [
        n("CH1_ART1_S1", "Sec. 1. - Authority", "CH1_ART1", false),
        n("CH1_ART1_S2", "Sec. 2. - Purpose", "CH1_ART1", false),
        n("CH1_ART1_S3", "Sec. 3. - Scope", "CH1_ART1", false),
      ];
    if (nodeId === "CH1_ART2")
      return [
        n("CH1_ART2_S1", "Sec. 1. - Residential", "CH1_ART2", false),
        n("CH1_ART2_S2", "Sec. 2. - Commercial", "CH1_ART2", false),
        n("CH1_ART2_S3", "Sec. 3. - Industrial", "CH1_ART2", false),
      ];
    return [];
  }
  override async getCodesContent(
    _jobId: number,
    _productId: number,
    nodeId: string,
  ): Promise<MunicodeContentEnvelope> {
    this.codesContentCalls.push(nodeId);
    const doc = (Id: string, Title: string, Content: string) => ({
      Id,
      Title,
      Content,
      NodeDepth: 3,
      DocOrderId: 0,
      TitleHtml: null,
      IsAmended: false,
      IsUpdated: false,
    });
    const docs =
      nodeId.startsWith("CH1_ART1")
        ? [
            doc("CH1_ART1_S1", "Sec. 1. - Authority", "<p>Authority for these regulations.</p>"),
            doc("CH1_ART1_S2", "Sec. 2. - Purpose", "<p>Purpose of this article.</p>"),
            doc("CH1_ART1_S3", "Sec. 3. - Scope", "<p>Scope of application.</p>"),
          ]
        : [
            doc("CH1_ART2_S1", "Sec. 1. - Residential", "<p>Residential district rules.</p>"),
            doc("CH1_ART2_S2", "Sec. 2. - Commercial", "<p>Commercial district rules.</p>"),
            doc("CH1_ART2_S3", "Sec. 3. - Industrial", "<p>Industrial district rules.</p>"),
          ];
    return { Docs: docs, PdfUrl: null, ShowToc: false };
  }
}

describe("MunicodeHtmlAdapter — JSON mode per-parent fetch dedup", () => {
  const jsonReference: CodeReference = {
    sourceId: "100:test:TX:test-udc",
    jurisdictionTenant: "test_tx",
    editionLabel: "Test Code",
    sourceUrl: "https://library.municode.com/tx/test/codes/code_of_ordinances",
  };

  it("issues one CodesContent fetch per parent article, not per leaf", async () => {
    const stub = new StubJsonClient();
    const jsonAdapter = new MunicodeHtmlAdapter({
      clientId: 100,
      librarySlug: "test",
      stateAbbr: "TX",
      jsonClient: stub,
    });
    const raw = await jsonAdapter.fetch(jsonReference);
    // Six leaf sections under two parent articles -> two fetches.
    expect(stub.codesContentCalls).toHaveLength(2);
    // Every section still reaches the assembled body — the per-article
    // fan-out means one fetch carries all of its siblings.
    for (const title of [
      "Authority",
      "Purpose",
      "Scope",
      "Residential",
      "Commercial",
      "Industrial",
    ]) {
      expect(raw.body).toContain(title);
    }
  });

  it("atomizes all six sections after the deduped fetch", async () => {
    const stub = new StubJsonClient();
    const jsonAdapter = new MunicodeHtmlAdapter({
      clientId: 100,
      librarySlug: "test",
      stateAbbr: "TX",
      jsonClient: stub,
    });
    const raw = await jsonAdapter.fetch(jsonReference);
    const normalized = await jsonAdapter.normalize(raw);
    const headings = normalized.blocks.filter((b) => b.kind === "heading");
    // Two article h2s + six section h3s survive the walk.
    expect(headings.length).toBeGreaterThanOrEqual(6);
  });
});

// A clientId that publishes TWO code products — the Georgetown, TX shape
// (Code of Ordinances + a separate Unified Development Code). `getLatestJob`
// records which productId it was asked for so the test can assert the
// productNameFilter steered the walk to the right product.
class TwoProductJsonClient extends MunicodeJsonClient {
  public latestJobProductId: number | null = null;

  override async getClientContent() {
    return {
      codes: [
        { productName: "Code of Ordinances", productId: 500 },
        { productName: "Unified Development Code", productId: 501 },
      ],
    };
  }
  override async getLatestJob(productId: number) {
    this.latestJobProductId = productId;
    return { Id: 7, Name: "Supplement 3", ProductId: productId };
  }
  override async getTocChildren(): Promise<MunicodeTocNode[]> {
    return [];
  }
  override async getCodesContent(): Promise<MunicodeContentEnvelope> {
    return { Docs: [], PdfUrl: null, ShowToc: false };
  }
}

describe("MunicodeHtmlAdapter — multi-product code selection", () => {
  const ref: CodeReference = {
    sourceId: "500:test:TX:test-udc",
    jurisdictionTenant: "test_tx",
    editionLabel: "Test Code",
    sourceUrl: "https://library.municode.com/tx/test/codes/code_of_ordinances",
  };

  it("defaults to codes[0] when no productNameFilter is set", async () => {
    const stub = new TwoProductJsonClient();
    const adapter = new MunicodeHtmlAdapter({
      clientId: 12078,
      librarySlug: "test",
      stateAbbr: "TX",
      jsonClient: stub,
    });
    await adapter.fetch(ref);
    expect(stub.latestJobProductId).toBe(500);
  });

  it("selects the matching product when productNameFilter is set", async () => {
    const stub = new TwoProductJsonClient();
    const adapter = new MunicodeHtmlAdapter({
      clientId: 12078,
      librarySlug: "test",
      stateAbbr: "TX",
      jsonClient: stub,
      productNameFilter: /unified development code/i,
    });
    await adapter.fetch(ref);
    expect(stub.latestJobProductId).toBe(501);
  });
});
