/**
 * Corpus-snapshot round-trip test.
 *
 * The retrieval-api Cloud Run deploy (Lane E Phase E0) boots an
 * `InMemoryStorage` hydrated from a committed snapshot. This test pins
 * the invariant that a snapshot export followed by an import yields a
 * storage indistinguishable from the original: same atoms readable by
 * DID, same search results, same section-number lookups, same
 * jurisdiction-status rows including the `accessPolicy` tier.
 */

import { describe, expect, it } from "vitest";

import type {
  AtomLink,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";

import { InMemoryStorage } from "../in-memory-storage.js";
import { CORPUS_SNAPSHOT_FORMAT, isCorpusSnapshot } from "../snapshot.js";

function section(
  entityId: string,
  sectionNumber: string,
  title: string,
  bodyText: string,
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId,
    jurisdictionTenant: "snaptest_tx",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "snapshot-test",
    sourceUrl: "https://example.test/code",
    contentHash: `hash-${entityId}`,
    codeEditionId: "snaptest_tx/edition-1",
    sectionNumber,
    title,
    subsectionPath: null,
    bodyText,
  };
}

const corpus: JurisdictionCorpusAtomInstance = {
  entityType: "jurisdiction-corpus",
  entityId: "snaptest_tx",
  jurisdictionTenant: "snaptest_tx",
  fetchedAt: "2026-05-21T00:00:00Z",
  sourceAdapter: "snapshot-test",
  sourceUrl: "https://example.test/code",
  contentHash: "hash-corpus",
  jurisdictionName: "Snapshot Test, TX",
  adoptedEditionIds: ["snaptest_tx/edition-1"],
  currentEditionId: "snaptest_tx/edition-1",
  coverageQualityBar: "passing",
  lastRefreshedAt: "2026-05-21T00:00:00Z",
  accessPolicy: "platform-internal",
};

async function seed(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  const s1 = section("snaptest_tx/edition-1/5-04", "5.04", "Setbacks", "Setback rule body.");
  const s2 = section("snaptest_tx/edition-1/1-01", "1.01", "Scope", "Scope rule body.");
  await storage.writeAtoms([corpus, s1, s2]);
  const link: AtomLink = {
    fromEntityType: "code-section",
    fromEntityId: s2.entityId,
    toEntityType: "code-section",
    toEntityId: s1.entityId,
    linkType: "see-also",
    context: "See 5.04 for setbacks.",
  };
  await storage.writeAtomLinks([link]);
  await storage.upsertJurisdictionStatus({
    jurisdictionTenant: "snaptest_tx",
    jurisdictionName: "Snapshot Test, TX",
    currentEditionDid: "did:hauska:code-edition:snaptest_tx/edition-1",
    qualityBar: "passing",
    top3Score: 1.0,
    sectionNumScore: 1.0,
    crossRefScore: 1.0,
    atomCount: 2,
    lastRefreshedAt: "2026-05-21T00:00:00Z",
    driftStatus: "clean",
    accessPolicy: "platform-internal",
  });
  return storage;
}

describe("corpus snapshot — export / import round-trip", () => {
  it("export produces a well-formed, format-tagged snapshot", async () => {
    const storage = await seed();
    const snap = storage.exportSnapshot(["snapshot.test seed"]);
    expect(snap.format).toBe(CORPUS_SNAPSHOT_FORMAT);
    expect(isCorpusSnapshot(snap)).toBe(true);
    expect(snap.atoms).toHaveLength(3);
    expect(snap.links).toHaveLength(1);
    expect(snap.jurisdictionStatus).toHaveLength(1);
    expect(snap.provenance).toEqual(["snapshot.test seed"]);
  });

  it("survives a JSON serialize → parse → import cycle intact", async () => {
    const original = await seed();
    const wire = JSON.parse(JSON.stringify(original.exportSnapshot()));
    expect(isCorpusSnapshot(wire)).toBe(true);

    const hydrated = await InMemoryStorage.fromSnapshot(wire);

    // Atoms readable by DID.
    const corpusAtom = await hydrated.getAtom("jurisdiction-corpus", "snaptest_tx");
    expect(corpusAtom?.entityType).toBe("jurisdiction-corpus");

    // Search returns the same atoms.
    const hits = await hydrated.search({ q: "setback", jurisdiction: "snaptest_tx" });
    expect(hits.some((h) => h.sectionNumber === "5.04")).toBe(true);

    // Section-number lookup intact.
    const byNum = await hydrated.getSectionsBySectionNumber("snaptest_tx", "1.01");
    expect(byNum).toHaveLength(1);

    // Link graph intact.
    const s2Did = "did:hauska:code-section:snaptest_tx/edition-1/1-01";
    const edges = await hydrated.traverse(s2Did, "see-also");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toAtom?.entityType).toBe("code-section");

    // Jurisdiction status intact, accessPolicy preserved.
    const statuses = await hydrated.listJurisdictionStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.accessPolicy).toBe("platform-internal");
    expect(statuses[0]?.qualityBar).toBe("passing");
  });

  it("rejects a malformed snapshot via the structural guard", () => {
    expect(isCorpusSnapshot(null)).toBe(false);
    expect(isCorpusSnapshot({ format: "wrong", generatedAt: "x", atoms: [], links: [], jurisdictionStatus: [] })).toBe(false);
    expect(isCorpusSnapshot({ format: CORPUS_SNAPSHOT_FORMAT, generatedAt: "x", atoms: [], links: [] })).toBe(false);
  });
});
