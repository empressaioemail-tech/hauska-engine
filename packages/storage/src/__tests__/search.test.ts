/**
 * Search scoring — single-digit section-number anchor boost.
 *
 * The query tokenizer drops single-character tokens as noise (stray
 * "a" / Roman numerals from subsection labels) but keeps a lone digit,
 * because embedded-ordinance exhibits (Leander's Subdivision / Zoning
 * Exhibit A) number their sections with bare integers `1.`-`9.`. If the
 * digit were dropped the section-number anchor boost could never fire
 * for any of them, and a bare `Sec. 2.` would tie — and lose on insert
 * order to — any giant glossary section that merely mentions the topic.
 */

import { describe, expect, it } from "vitest";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { InMemoryStorage } from "../in-memory-storage.js";

function section(
  entityId: string,
  sectionNumber: string,
  title: string,
  bodyText: string,
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId,
    jurisdictionTenant: "searchtest_tx",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "search-test",
    sourceUrl: "https://example.test/code",
    contentHash: `hash-${entityId}`,
    codeEditionId: "searchtest_tx/edition-1",
    sectionNumber,
    title,
    subsectionPath: null,
    bodyText,
  };
}

describe("InMemoryStorage.search — single-digit section-number anchor", () => {
  it("ranks a bare single-digit section above a same-topic giant via the anchor boost", async () => {
    const storage = new InMemoryStorage();
    const target = section(
      "searchtest_tx/edition-1/2",
      "2.",
      "Special use permit",
      "The City Council may grant a special use permit for listed uses.",
    );
    // A glossary-style giant under a different section number: a huge
    // body that also contains every topic token, so it would tie the
    // target on raw token ratio. Only the anchor boost separates them.
    const giant = section(
      "searchtest_tx/edition-1/6",
      "6.",
      "Definitions",
      "special use permit 2 ".repeat(400),
    );
    await storage.writeAtoms([target, giant]);
    const results = await storage.search({
      q: "2 special use permit",
      jurisdiction: "searchtest_tx",
      limit: 3,
    });
    expect(results[0]?.entityId).toBe("searchtest_tx/edition-1/2");
  });

  it("anchors to the queried single digit when sections share a topic word", async () => {
    const storage = new InMemoryStorage();
    const three = section(
      "searchtest_tx/edition-1/3",
      "3.",
      "Authority",
      "This article is adopted under the authority of the city.",
    );
    const seven = section(
      "searchtest_tx/edition-1/7",
      "7.",
      "Policy",
      "The authority and policy of the city are stated here.",
    );
    await storage.writeAtoms([three, seven]);
    const results = await storage.search({
      q: "7 policy authority",
      jurisdiction: "searchtest_tx",
      limit: 3,
    });
    expect(results[0]?.entityId).toBe("searchtest_tx/edition-1/7");
  });
});
