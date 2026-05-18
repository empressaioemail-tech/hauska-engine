/**
 * Eval harness sanity tests against the in-memory storage seed.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import { buildAtomDid } from "@hauska-engine/atoms";

import { atomize } from "../../atomization/index.js";
import {
  MunicodeHtmlAdapter,
  RespectfulFetch,
  type CodeReference,
} from "../../adapters/index.js";
import { buildCodeTree } from "../../extraction/index.js";
import { DEFAULT_QUALITY_BAR, evaluate, type CuratedQuery } from "../index.js";

class StubFetch extends RespectfulFetch {
  constructor(private readonly body: string) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchText(): Promise<string> {
    return this.body;
  }
}

const FIXTURE = `<!doctype html>
<html><body>
  <h1>Chapter 1</h1>
  <h3 id="sec-1-01">§ 1.01 Scope</h3>
  <p>This chapter governs subsequent provisions.</p>
  <p>See § 5.04(b) for setbacks.</p>
  <h3 id="sec-5-04">§ 5.04 Setbacks</h3>
  <p>Setback rule applies.</p>
</body></html>`;

describe("eval harness", () => {
  it("evaluates with default quality bar", async () => {
    const storage = new InMemoryStorage();
    const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(FIXTURE) });
    const ref: CodeReference = {
      sourceId: "test/test",
      jurisdictionTenant: "test-tx",
      editionLabel: "Test 2024",
      sourceUrl: "https://example/test",
    };
    const raw = await adapter.fetch(ref);
    const tree = buildCodeTree(await adapter.normalize(raw));
    const atomized = atomize(tree);
    await storage.writeAtoms([
      atomized.jurisdictionCorpus,
      atomized.edition,
      ...atomized.sections,
      ...atomized.definitions,
      ...atomized.crossReferences,
    ]);
    await storage.writeAtomLinks(atomized.links);

    const targetSection = atomized.sections.find(
      (s) => s.sectionNumber.includes("5.04"),
    );
    expect(targetSection).toBeDefined();
    const queries: CuratedQuery[] = [
      {
        queryId: "q1",
        jurisdictionTenant: "test-tx",
        queryText: "Setbacks",
        expectedAtomDid: buildAtomDid(
          "code-section",
          targetSection!.entityId,
        ).raw,
        queryType: "retrieval",
        authorshipSource: "human-curated",
        humanReviewedBy: "test",
        humanReviewedAt: new Date().toISOString(),
        status: "approved",
      },
    ];
    const report = await evaluate({
      storage,
      jurisdictionTenant: "test-tx",
      queries,
      thresholds: DEFAULT_QUALITY_BAR,
    });
    expect(report.queriesEvaluated).toBe(1);
    expect(report.scores.top3Score).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("returns passed=false when retrieval misses", async () => {
    const storage = new InMemoryStorage();
    const queries: CuratedQuery[] = [
      {
        queryId: "q-miss",
        jurisdictionTenant: "empty",
        queryText: "nothing",
        expectedAtomDid: "did:hauska:code-section:nope/nope/nope",
        queryType: "retrieval",
        authorshipSource: "human-curated",
        humanReviewedBy: null,
        humanReviewedAt: null,
        status: "approved",
      },
    ];
    const report = await evaluate({
      storage,
      jurisdictionTenant: "empty",
      queries,
    });
    expect(report.scores.top3Score).toBe(0);
    expect(report.passed).toBe(false);
  });
});
