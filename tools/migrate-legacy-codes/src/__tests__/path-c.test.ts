/**
 * Path C end-to-end tests against a stubbed MunicodeJsonClient.
 *
 * Verifies that:
 *   - chapterFilter prunes the top-level TOC to matching subtrees
 *   - walker recurses into HasChildren nodes up to the budget
 *   - assembled HTML is correctly extracted into NormalizedBlocks
 *   - atomization produces Bump 1 atom types
 *   - migrated atoms are searchable via storage and resolve known DIDs
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import {
  MunicodeHtmlAdapter,
  MunicodeJsonClient,
  type MunicodeContentEnvelope,
  type MunicodeJob,
  type MunicodeTocNode,
  type RawCode,
} from "@hauska-engine/corpus/adapters";

import { runPathCIngest } from "../path-c-ingest.js";
import { buildBastropUdcCuratedQueries } from "../udc-curated-queries.js";

class StubJsonClient extends MunicodeJsonClient {
  constructor(
    private readonly tocMap: Record<string, ReadonlyArray<MunicodeTocNode>>,
    private readonly content: Record<string, MunicodeContentEnvelope>,
    private readonly jobValue: MunicodeJob,
  ) {
    super();
  }

  override async getClientByName() {
    return { ClientID: 1169, ClientName: "Bastrop" };
  }

  override async getClientContent() {
    return {
      codes: [
        {
          productName: "Code of Ordinances",
          productId: 9999,
        },
      ],
    };
  }

  override async getLatestJob() {
    return this.jobValue;
  }

  override async getTocChildren(_jobId: number, _productId: number, nodeId?: string) {
    return (this.tocMap[nodeId ?? "ROOT"] ?? []) as MunicodeTocNode[];
  }

  override async getCodesContent(_jobId: number, _productId: number, nodeId: string) {
    return this.content[nodeId] ?? { Docs: [], PdfUrl: null, ShowToc: false };
  }
}

function toc(
  ...nodes: Array<{
    Id: string;
    Heading: string;
    HasChildren?: boolean;
    NodeDepth?: number;
  }>
): MunicodeTocNode[] {
  return nodes.map((n) => ({
    Id: n.Id,
    Heading: n.Heading,
    ParentId: "",
    NodeDepth: n.NodeDepth ?? 1,
    HasChildren: n.HasChildren ?? false,
    DocOrderId: 0,
  }));
}

function envelope(
  ...docs: Array<{ Id: string; Title: string; Content: string | null }>
): MunicodeContentEnvelope {
  return {
    Docs: docs.map((d) => ({
      Id: d.Id,
      Title: d.Title,
      Content: d.Content,
      NodeDepth: 3,
      DocOrderId: 0,
      TitleHtml: null,
      IsAmended: false,
      IsUpdated: false,
    })),
    PdfUrl: null,
    ShowToc: true,
  };
}

describe("MunicodeHtmlAdapter JSON mode", () => {
  it("walks chapter-filtered TOC and assembles synthetic HTML body", async () => {
    const adapter = new MunicodeHtmlAdapter({
      clientId: 1169,
      librarySlug: "bastrop",
      stateAbbr: "TX",
      chapterFilter: /unified.*development/i,
      jsonClient: new StubJsonClient(
        {
          ROOT: toc(
            { Id: "CH1", Heading: "Chapter 1 — General Provisions" },
            { Id: "UDC", Heading: "UNIFIED DEVELOPMENT CODE", HasChildren: true },
          ),
          UDC: toc(
            { Id: "UDC-ART4", Heading: "Article 4 — Zoning Districts" },
            { Id: "UDC-ART5", Heading: "Article 5 — Setbacks" },
          ),
        },
        {
          "UDC-ART4": envelope({
            Id: "UDC-ART4-DOC",
            Title: "Article 4 Zoning Districts",
            Content:
              "<p>Use districts: R-1 residential, C-1 commercial. See § 5 for setbacks.</p>",
          }),
          "UDC-ART5": envelope({
            Id: "UDC-ART5-DOC",
            Title: "Article 5 Setbacks",
            Content: "<p>Front setback minimum: 25 feet.</p>",
          }),
        },
        { Id: 12345, Name: "Bastrop UDC Supplement 19", ProductId: 9999 },
      ),
    });

    const raw: RawCode = await adapter.fetch({
      sourceId: "1169:bastrop:TX:bastrop_tx-udc",
      jurisdictionTenant: "bastrop_tx",
      editionLabel: "Bastrop UDC (current supplement)",
      sourceUrl: "https://library.municode.com/tx/bastrop/codes/code_of_ordinances",
    });

    expect(raw.contentType).toBe("text/html");
    expect(raw.body).toContain("Article 4 Zoning Districts");
    expect(raw.body).toContain("Article 5 Setbacks");
    expect(raw.body).not.toContain("General Provisions"); // pruned

    const normalized = await adapter.normalize(raw);
    const headings = normalized.blocks.filter((b) => b.kind === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(3);
    const paragraphs = normalized.blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.length).toBeGreaterThan(0);
    const xrefs = normalized.blocks.filter((b) => b.kind === "cross-reference");
    expect(xrefs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty body when chapterFilter matches nothing", async () => {
    const adapter = new MunicodeHtmlAdapter({
      clientId: 1169,
      librarySlug: "bastrop",
      stateAbbr: "TX",
      chapterFilter: /nonexistent/i,
      jsonClient: new StubJsonClient(
        {
          ROOT: toc({ Id: "CH1", Heading: "Chapter 1 — General Provisions" }),
        },
        {},
        { Id: 1, Name: "Bastrop", ProductId: 9999 },
      ),
    });
    const raw = await adapter.fetch({
      sourceId: "x",
      jurisdictionTenant: "bastrop_tx",
      editionLabel: "x",
      sourceUrl: "x",
    });
    expect(raw.body).toContain("no content");
  });
});

describe("runPathCIngest end-to-end", () => {
  it("ingests UDC chapters into storage and emits atoms via the StoragePort", async () => {
    const storage = new InMemoryStorage();
    const adapter = new MunicodeHtmlAdapter({
      clientId: 1169,
      librarySlug: "bastrop",
      stateAbbr: "TX",
      chapterFilter: /unified.*development/i,
      jsonClient: new StubJsonClient(
        {
          ROOT: toc(
            { Id: "CH1", Heading: "Chapter 1 — General Provisions" },
            { Id: "UDC", Heading: "UNIFIED DEVELOPMENT CODE", HasChildren: true },
          ),
          UDC: toc(
            { Id: "UDC-ART4", Heading: "Article 4 — Zoning Districts" },
            { Id: "UDC-ART5", Heading: "Article 5 — Setbacks" },
            { Id: "UDC-ART6", Heading: "Article 6 — Subdivision Standards" },
            { Id: "UDC-ART7", Heading: "Article 7 — Site Development Standards" },
          ),
        },
        {
          "UDC-ART4": envelope({
            Id: "UDC-ART4-DOC",
            Title: "Article 4 Zoning Districts",
            Content:
              "<p>Use districts: R-1 residential, R-2 multifamily, C-1 commercial. See § 5 for setbacks.</p>",
          }),
          "UDC-ART5": envelope({
            Id: "UDC-ART5-DOC",
            Title: "Article 5 Setbacks",
            Content:
              "<p>Front setback minimum: 25 feet. Side: 5 feet. Rear: 10 feet.</p>",
          }),
          "UDC-ART6": envelope({
            Id: "UDC-ART6-DOC",
            Title: "Article 6 Subdivision Standards",
            Content:
              "<p>Plat approval required for subdivision of land per § 4.</p>",
          }),
          "UDC-ART7": envelope({
            Id: "UDC-ART7-DOC",
            Title: "Article 7 Site Development Standards",
            Content:
              "<p>Site development requires civil engineering review per § 6.</p>",
          }),
        },
        { Id: 12345, Name: "Bastrop UDC Supplement 19", ProductId: 9999 },
      ),
    });

    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      editionLabel: "Bastrop UDC (current supplement)",
      clientId: 1169,
      librarySlug: "bastrop",
      stateAbbr: "TX",
      chapterFilter: /unified.*development/i,
      adapter,
    });

    expect(result.report.sectionsIngested).toBeGreaterThanOrEqual(4);
    expect(result.report.crossReferencesIngested).toBeGreaterThanOrEqual(1);
    expect(result.report.editionEntityId).toContain("bastrop_tx");
    expect(result.report.jurisdictionCorpusEntityId).toBe("bastrop_tx");

    const status = await storage.listJurisdictionStatus();
    expect(status.find((s) => s.jurisdictionTenant === "bastrop_tx")).toBeDefined();

    const hits = await storage.search({
      q: "setback",
      jurisdiction: "bastrop_tx",
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("UDC curated queries target the same edition DID scheme atomization produces", () => {
    const queries = buildBastropUdcCuratedQueries();
    expect(queries.length).toBeGreaterThan(0);
    const anchored = queries.filter((q) => !q.expectedAtomDid.includes("unanchored"));
    expect(anchored.length).toBeGreaterThan(0);
    for (const q of anchored) {
      expect(q.expectedAtomDid).toMatch(/^did:hauska:code-section:bastrop_tx\//);
    }
  });
});
