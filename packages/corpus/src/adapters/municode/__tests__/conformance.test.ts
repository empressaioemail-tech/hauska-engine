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
