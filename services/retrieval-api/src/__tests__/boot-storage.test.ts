import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { bootRetrievalStorage } from "../boot-storage.js";

describe("bootRetrievalStorage", () => {
  it("returns snapshot-only storage when no substrate URL is configured", async () => {
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

    const handle = bootRetrievalStorage({
      snapshot,
      substrateDatabaseUrl: "",
    });
    expect(await handle.storage.countAtoms()).toBe(1);
    await handle.close();
  });
});
