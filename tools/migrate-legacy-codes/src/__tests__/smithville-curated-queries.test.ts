import { describe, expect, it } from "vitest";

import {
  buildSmithvilleCuratedQueries,
  SMITHVILLE_EDITION_LABEL,
  SMITHVILLE_JURISDICTION,
} from "../smithville-curated-queries.js";

describe("buildSmithvilleCuratedQueries()", () => {
  const queries = buildSmithvilleCuratedQueries();

  it("returns 15 draft, llm-generated retrieval queries", () => {
    expect(queries).toHaveLength(15);
    for (const q of queries) {
      expect(q.status).toBe("draft");
      expect(q.authorshipSource).toBe("llm-generated");
      expect(q.queryType).toBe("retrieval");
      expect(q.humanReviewedBy).toBeNull();
      expect(q.humanReviewedAt).toBeNull();
      expect(q.jurisdictionTenant).toBe(SMITHVILLE_JURISDICTION);
    }
  });

  it("uses the smithville_tx (underscore) tenant slug, not the artifact's smithville-tx", () => {
    expect(SMITHVILLE_JURISDICTION).toBe("smithville_tx");
  });

  it("every expectedAtomDid is well-formed (did:hauska:code-section:smithville_tx/<edition-slug>/<section-slug>) and constructible without throwing", () => {
    const editionSlugFragment = "smithville-code-of-ordinances-ecode360";
    expect(SMITHVILLE_EDITION_LABEL.toLowerCase()).toContain("smithville");
    for (const q of queries) {
      expect(q.expectedAtomDid).toMatch(
        /^did:hauska:code-section:smithville_tx\/[a-z0-9-]+\/[a-z0-9-]+$/,
      );
      expect(q.expectedAtomDid).toContain(editionSlugFragment);
    }
  });

  it("has unique queryIds and unique expectedAtomDids (no two drafts collide)", () => {
    const ids = queries.map((q) => q.queryId);
    const dids = queries.map((q) => q.expectedAtomDid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(dids).size).toBe(dids.length);
  });

  it("spans multiple chapters (section-number prefixes are not all the same chapter)", () => {
    const chapters = new Set(
      queries.map((q) => q.queryText.split(" ")[0]?.split(".")[0]),
    );
    expect(chapters.size).toBeGreaterThanOrEqual(8);
  });
});
