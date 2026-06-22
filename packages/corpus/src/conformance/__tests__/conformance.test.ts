/**
 * Corpus family conformance — validates born-correct atomization output
 * against @hauska/atom-contract@1.5.0 conformance target.
 */

import { describe, expect, it } from "vitest";

import { MunicodeHtmlAdapter } from "../../adapters/municode/index.js";
import { RespectfulFetch } from "../../adapters/http.js";
import type { CodeReference } from "../../adapters/types.js";
import { buildCodeTree } from "../../extraction/extractor.js";
import { atomize } from "../../atomization/index.js";
import {
  ATOM_CONFORMANCE_TARGET_VERSION,
  validateAtomConformance,
} from "@hauska/atom-contract/conformance";

const CORPUS_FAMILIES = [
  "code-section",
  "code-definition",
  "code-amendment",
  "code-cross-reference",
  "code-edition",
  "jurisdiction-corpus",
] as const;

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

async function atomizeFixture() {
  const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(FIXTURE) });
  const raw = await adapter.fetch(reference);
  const normalized = await adapter.normalize(raw);
  const tree = buildCodeTree(normalized);
  return atomize(tree, { accessPolicy: "public-free" });
}

describe("corpus conformance — born-correct atomization", () => {
  it("stamps all five corpus families with conformance target 1.5.0", async () => {
    const atomized = await atomizeFixture();
    const all = [
      atomized.jurisdictionCorpus,
      atomized.edition,
      ...atomized.sections,
      ...atomized.definitions,
      ...atomized.amendments,
      ...atomized.crossReferences,
    ];

    const typesSeen = new Set(all.map((a) => a.entityType));
    for (const family of CORPUS_FAMILIES) {
      expect(typesSeen.has(family)).toBe(true);
    }

    for (const atom of all) {
      expect(atom.readContract).toBeDefined();
      expect(atom.accessPolicy).toBe("public-free");
      expect(atom.signedHistory?.verifyChain.ok).toBe(true);

      const result = validateAtomConformance({
        tier: "data",
        readContract: atom.readContract,
        accessPolicy: atom.accessPolicy,
        signedHistory: atom.signedHistory,
      });
      expect(result.ok, JSON.stringify(result.errors)).toBe(true);
      expect(result.conformanceTargetVersion).toBe(
        ATOM_CONFORMANCE_TARGET_VERSION,
      );
    }
  });

  it("applies conservative consequence default on code-section atoms", async () => {
    const atomized = await atomizeFixture();
    for (const section of atomized.sections) {
      expect(section.consequenceInputs?.asce7RiskCategories).toEqual(["II"]);
      const readContract = section.readContract!;
      expect(readContract.axes.consequence.derivation.asce7RiskCategory).toBe(
        "II",
      );
      expect(readContract.axes.consequence.stratum).toBe("routine");
    }
  });

  it("uses asserted source-quality baseline from adapter", async () => {
    const atomized = await atomizeFixture();
    const section = atomized.sections[0]!;
    const readContract = section.readContract!;
    expect(readContract.axes.assertedConfidence.provenance).toBe("asserted");
    expect(readContract.axes.assertedConfidence.estimate).toBe(0.72);
    expect(readContract.axes.calibratedConfidence.provenance).toBe("seed");
  });
});
