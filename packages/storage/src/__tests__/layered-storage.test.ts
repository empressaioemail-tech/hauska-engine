import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "../in-memory-storage.js";
import { LayeredStorage } from "../layered-storage.js";
import {
  STORAGE_PORT_PROOF_ATOM_DID,
  STORAGE_PORT_PROOF_SEARCH_TOKEN,
  buildStoragePortProofAtom,
} from "../storage-port-proof.js";

describe("LayeredStorage", () => {
  it("serves Postgres-only atoms by DID while preserving snapshot corpus count", async () => {
    const snapshot = new InMemoryStorage();
    await snapshot.writeAtoms([
      {
        entityType: "code-section",
        entityId: "snaptest_tx/edition-1/1",
        jurisdictionTenant: "snaptest_tx",
        fetchedAt: "2026-07-23T00:00:00Z",
        sourceAdapter: "snapshot-test",
        sourceUrl: "https://example.test/code",
        contentHash: "hash-snap-1",
        codeEditionId: "snaptest_tx/edition-1",
        sectionNumber: "1.",
        title: "Snapshot section",
        subsectionPath: null,
        bodyText: "snapshot corpus body",
      },
    ]);

    const postgres = new InMemoryStorage();
    const proof = buildStoragePortProofAtom();
    await postgres.writeAtom(proof);

    const layered = new LayeredStorage({ primary: postgres, snapshot });
    const fetched = await layered.getAtomByDid(STORAGE_PORT_PROOF_ATOM_DID);
    expect(fetched?.entityId).toBe(proof.entityId);

    const snapshotOnly = await snapshot.getAtomByDid(STORAGE_PORT_PROOF_ATOM_DID);
    expect(snapshotOnly).toBeNull();

    expect(await layered.countAtoms()).toBe(2);
    expect(await snapshot.countAtoms()).toBe(1);
  });

  it("hasAtoms() is true when only the snapshot holds atoms, false when both are empty", async () => {
    const snapshot = new InMemoryStorage();
    await snapshot.writeAtom({
      entityType: "code-section",
      entityId: "snaptest_tx/edition-1/1",
      jurisdictionTenant: "snaptest_tx",
      fetchedAt: "2026-07-23T00:00:00Z",
      sourceAdapter: "snapshot-test",
      sourceUrl: "https://example.test/code",
      contentHash: "hash-snap-1",
      codeEditionId: "snaptest_tx/edition-1",
      sectionNumber: "1.",
      title: "Snapshot section",
      subsectionPath: null,
      bodyText: "snapshot corpus body",
    });
    const emptyPrimary = new InMemoryStorage();
    const layered = new LayeredStorage({ primary: emptyPrimary, snapshot });
    expect(await layered.hasAtoms()).toBe(true);

    const bothEmpty = new LayeredStorage({
      primary: new InMemoryStorage(),
      snapshot: new InMemoryStorage(),
    });
    expect(await bothEmpty.hasAtoms()).toBe(false);
  });

  it("hasAtoms() short-circuits on the snapshot and never asks the primary when the snapshot already has atoms", async () => {
    const snapshot = new InMemoryStorage();
    await snapshot.writeAtom({
      entityType: "code-section",
      entityId: "snaptest_tx/edition-1/1",
      jurisdictionTenant: "snaptest_tx",
      fetchedAt: "2026-07-23T00:00:00Z",
      sourceAdapter: "snapshot-test",
      sourceUrl: "https://example.test/code",
      contentHash: "hash-snap-1",
      codeEditionId: "snaptest_tx/edition-1",
      sectionNumber: "1.",
      title: "Snapshot section",
      subsectionPath: null,
      bodyText: "snapshot corpus body",
    });
    const primary = new InMemoryStorage();
    let primaryAsked = false;
    const originalHasAtoms = primary.hasAtoms.bind(primary);
    primary.hasAtoms = async () => {
      primaryAsked = true;
      return originalHasAtoms();
    };

    const layered = new LayeredStorage({ primary, snapshot });
    expect(await layered.hasAtoms()).toBe(true);
    expect(primaryAsked).toBe(false);
  });

  it("merges search results from Postgres overlay and snapshot", async () => {
    const snapshot = new InMemoryStorage();
    await snapshot.writeAtom({
      entityType: "code-section",
      entityId: "snaptest_tx/edition-1/1",
      jurisdictionTenant: "snaptest_tx",
      fetchedAt: "2026-07-23T00:00:00Z",
      sourceAdapter: "snapshot-test",
      sourceUrl: "https://example.test/code",
      contentHash: "hash-snap-1",
      codeEditionId: "snaptest_tx/edition-1",
      sectionNumber: "1.",
      title: "Snapshot section",
      subsectionPath: null,
      bodyText: "snapshot-only token alpha",
    });

    const postgres = new InMemoryStorage();
    await postgres.writeAtom(buildStoragePortProofAtom());

    const layered = new LayeredStorage({ primary: postgres, snapshot });
    const results = await layered.search({
      q: STORAGE_PORT_PROOF_SEARCH_TOKEN,
      limit: 5,
    });
    expect(results.some((r) => r.atomDid === STORAGE_PORT_PROOF_ATOM_DID)).toBe(
      true,
    );
  });
});
