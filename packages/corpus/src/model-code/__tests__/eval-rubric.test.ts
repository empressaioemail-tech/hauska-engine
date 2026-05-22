/**
 * Layer 1 eval rubric tests.
 *
 * Validates the authored artifact: the rubric value, the curated query
 * set's well-formedness, and — the load-bearing check — that every
 * query's `expectedAtomDid` matches the entityId scheme the model-code
 * extractor produces, so the rubric and the extractor cannot drift.
 * A retrieval smoke test runs the real eval harness against the IRC
 * 2021 fixture to confirm the curated set actually retrieves.
 */

import { describe, expect, it } from "vitest";

import { buildAtomDid, parseAtomDid } from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import {
  ICC_CODE_CONNECT_FIXTURES,
  IRC_2021_TITLE_ID,
} from "../../adapters/icc-code-connect/__fixtures__/irc-2021.js";
import { evaluate } from "../../eval/index.js";
import { extractModelCodeAtoms } from "../extractor.js";
import {
  IRC_2021_CURATED_QUERIES,
  LAYER_1_CURATED_QUERIES,
  LAYER_1_QUALITY_BAR,
} from "../eval-rubric.js";

const IRC_2021 = ICC_CODE_CONNECT_FIXTURES.documents[IRC_2021_TITLE_ID]!;

describe("LAYER_1_QUALITY_BAR", () => {
  it("is the strict 1.0/1.0/1.0 bar of the Sync 4/4.5/5 ingests", () => {
    expect(LAYER_1_QUALITY_BAR).toEqual({
      top3RetrievalMin: 1.0,
      sectionNumRetrievabilityMin: 1.0,
      crossRefResolutionMin: 1.0,
    });
  });
});

describe("IRC 2021 curated query set", () => {
  it("is well-formed: unique ids, retrieval type, code-section DIDs", () => {
    expect(IRC_2021_CURATED_QUERIES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const q of IRC_2021_CURATED_QUERIES) {
      expect(ids.has(q.queryId)).toBe(false);
      ids.add(q.queryId);
      expect(q.queryText.trim().length).toBeGreaterThan(0);
      expect(q.queryType).toBe("retrieval");
      expect(q.jurisdictionTenant).toBe("icc-model-code");
      const did = parseAtomDid(q.expectedAtomDid);
      expect(did.entityType).toBe("code-section");
    }
  });

  it("is registered in the LAYER_1_CURATED_QUERIES edition map", () => {
    expect(
      LAYER_1_CURATED_QUERIES["2021 International Residential Code"],
    ).toBe(IRC_2021_CURATED_QUERIES);
  });

  it("every expectedAtomDid resolves to a section the extractor emits", async () => {
    const { sections } = await extractModelCodeAtoms(IRC_2021);
    const sectionDids = new Set(
      sections.map((s) => buildAtomDid("code-section", s.entityId).raw),
    );
    for (const q of IRC_2021_CURATED_QUERIES) {
      expect(sectionDids.has(q.expectedAtomDid)).toBe(true);
    }
  });
});

describe("eval rubric — retrieval against the IRC 2021 fixture", () => {
  it("the curated set retrieves every target section (top-3 score 1.0)", async () => {
    const atoms = await extractModelCodeAtoms(IRC_2021);
    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      atoms.edition,
      ...atoms.sections,
      ...atoms.definitions,
      ...atoms.crossReferences,
    ]);
    await storage.writeAtomLinks(atoms.links);

    const report = await evaluate({
      storage,
      jurisdictionTenant: "icc-model-code",
      queries: IRC_2021_CURATED_QUERIES,
      thresholds: LAYER_1_QUALITY_BAR,
    });

    // Retrieval + section-number coverage hit the 1.0 bar against the
    // fixture. Cross-reference resolution does not — the fixture is a
    // four-section slice, so most cross-references point at sections
    // outside it; against a complete edition every target exists.
    expect(report.scores.top3Score).toBe(1);
    expect(report.scores.sectionNumScore).toBe(1);
    expect(report.queriesEvaluated).toBe(IRC_2021_CURATED_QUERIES.length);
    expect(report.failures).toEqual([]);
  });
});
