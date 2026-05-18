/**
 * End-to-end smoke: adapter -> extractor -> atomizer against the
 * Municode HTML fixture. Asserts the pipeline produces the six
 * Bump 1 atom shapes with correct provenance and at least one
 * resolved cross-reference link edge.
 */

import { describe, expect, it } from "vitest";

import { MunicodeHtmlAdapter } from "../../adapters/municode/index.js";
import { RespectfulFetch } from "../../adapters/http.js";
import type { CodeReference } from "../../adapters/types.js";
import { buildCodeTree, reportExtractionQuality } from "../../extraction/extractor.js";
import { atomize } from "../index.js";

class StubFetch extends RespectfulFetch {
  constructor(private readonly body: string) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchText(): Promise<string> {
    return this.body;
  }
}

const FIXTURE = `<!doctype html>
<html>
  <head>
    <meta name="publication-date" content="2024-01-01" />
    <meta name="jurisdiction-name" content="Test City" />
  </head>
  <body>
    <h1 id="chapter-1">Chapter 1 — General Provisions</h1>
    <h3 id="sec-1-01">§ 1.01 Scope</h3>
    <p>This chapter governs subsequent provisions.</p>
    <p>See § 5.04(b) for setback requirements.</p>
    <h3 id="sec-5-04">§ 5.04 Setbacks</h3>
    <p>Setback distances apply per the table below.</p>
    <dl>
      <dt>Lot</dt>
      <dd>A parcel of land identified by recorded plat.</dd>
    </dl>
    <aside class="amendment">
      <span class="ordinance-id">ORD-2024-12</span>
      <span class="effective-date">2024-06-01</span>
      <span class="authority">City Council</span>
      Amends § 5.04.
    </aside>
  </body>
</html>`;

const reference: CodeReference = {
  sourceId: "test/test-city",
  jurisdictionTenant: "test-city-tx",
  editionLabel: "Test City Code 2024",
  sourceUrl: "https://library.municode.com/codes/test/test-city",
};

describe("end-to-end pipeline (adapter -> extract -> atomize)", () => {
  it("produces all six Bump 1 atom types with provenance", async () => {
    const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(FIXTURE) });
    const raw = await adapter.fetch(reference);
    const normalized = await adapter.normalize(raw);
    const tree = buildCodeTree(normalized);
    const report = reportExtractionQuality(tree);
    expect(report.totalSections).toBeGreaterThanOrEqual(2);
    expect(report.totalDefinitions).toBeGreaterThanOrEqual(1);
    expect(report.totalCrossReferences).toBeGreaterThanOrEqual(1);
    expect(report.totalAmendments).toBeGreaterThanOrEqual(1);

    const atomized = atomize(tree);
    expect(atomized.jurisdictionCorpus.entityType).toBe("jurisdiction-corpus");
    expect(atomized.edition.entityType).toBe("code-edition");
    expect(atomized.sections.length).toBeGreaterThanOrEqual(2);
    expect(atomized.definitions.length).toBeGreaterThanOrEqual(1);
    expect(atomized.crossReferences.length).toBeGreaterThanOrEqual(1);
    expect(atomized.amendments.length).toBeGreaterThanOrEqual(1);

    for (const section of atomized.sections) {
      expect(section.jurisdictionTenant).toBe("test-city-tx");
      expect(section.sourceAdapter).toBe("municode-html");
      expect(section.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }

    // At least one cross-reference resolved to a target section.
    const resolvedXrefs = atomized.crossReferences.filter(
      (x) => x.toSectionId !== "",
    );
    expect(resolvedXrefs.length).toBeGreaterThanOrEqual(1);

    // Cross-reference link edges land in the atom_links output.
    const xrefLinks = atomized.links.filter(
      (l) => l.fromEntityType === "code-section" && l.toEntityType === "code-section",
    );
    expect(xrefLinks.length).toBeGreaterThanOrEqual(1);

    // Amendment links to the section it amends.
    const amendLinks = atomized.links.filter((l) => l.linkType === "amends");
    expect(amendLinks.length).toBeGreaterThanOrEqual(1);
  });
});
