import { describe, expect, it } from "vitest";

import {
  buildPresentFloodHazardFactAtom,
  NON_CANONICAL_BINDING,
  ParcelEntityIdRejectedError,
} from "@hauska-engine/atoms";

import { InMemoryStorage } from "../in-memory-storage.js";
import {
  dedupePreparedRowsLastWins,
  PROPERTY_ATOM_UPSERT_MAX_ROWS,
} from "../property-atom-batch-write.js";

describe("property-atom batch write helpers", () => {
  it("dedupes by atom_did with last occurrence winning", () => {
    const rows = [
      {
        atom_did: "did:hauska:parcel-node:48021:1",
        source_adapter: "first",
      },
      {
        atom_did: "did:hauska:parcel-node:48021:2",
        source_adapter: "only",
      },
      {
        atom_did: "did:hauska:parcel-node:48021:1",
        source_adapter: "last-wins",
      },
    ] as Parameters<typeof dedupePreparedRowsLastWins>[0];

    const out = dedupePreparedRowsLastWins(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.atom_did.endsWith(":1"))?.source_adapter).toBe(
      "last-wins",
    );
  });

  it("caps multi-row batch below Postgres bind-parameter ceiling", () => {
    expect(PROPERTY_ATOM_UPSERT_MAX_ROWS).toBeLessThanOrEqual(5041);
    expect(PROPERTY_ATOM_UPSERT_MAX_ROWS * 13).toBeLessThanOrEqual(65535);
  });
});

describe("writePropertyAtomsBatch Wave C identity (WDLL 11 C4)", () => {
  const provenance = {
    sourceAdapter: "fema-nfhl-bulk-v1",
    sourceCitation: "FEMA NFHL fixture",
    sourceUrl: "https://example.test/nfhl",
    observedAt: "2026-08-21T00:00:00.000Z",
    jurisdictionTenant: "tx_48021",
    contentHash: "fnv1a64:ident-p55-flood",
  };

  it("writes applies-to from the fact DID to the parcel-node on the same call", async () => {
    const storage = new InMemoryStorage();
    const atom = buildPresentFloodHazardFactAtom(
      {
        parcelNodeId: "48021:27303.00000000",
        inSpecialFloodHazardArea: false,
        floodZone: null,
      },
      provenance,
    );
    await storage.writePropertyAtomsBatch([atom]);
    const snap = await storage.exportSnapshot();
    const applies = snap.links.filter((l) => l.linkType === "applies-to");
    expect(applies).toHaveLength(1);
    expect(applies[0]).toMatchObject({
      fromEntityType: "flood-hazard-fact",
      fromEntityId: "48021:27303",
      toEntityType: "parcel-node",
      toEntityId: "48021:27303",
      linkType: "applies-to",
    });
  });

  it("rejects a padded entity_id that skipped the writer helper", async () => {
    const storage = new InMemoryStorage();
    const atom = buildPresentFloodHazardFactAtom(
      {
        parcelNodeId: "48021:27303",
        inSpecialFloodHazardArea: false,
        floodZone: null,
      },
      provenance,
    );
    const skipped = { ...atom, entityId: "48021:27303.00000000" };
    await expect(storage.writePropertyAtomsBatch([skipped])).rejects.toBeInstanceOf(
      ParcelEntityIdRejectedError,
    );
  });

  it("refuses a bare entityId as NON_CANONICAL_BINDING", async () => {
    const storage = new InMemoryStorage();
    const atom = buildPresentFloodHazardFactAtom(
      {
        parcelNodeId: "48021:27303",
        inSpecialFloodHazardArea: false,
        floodZone: null,
      },
      provenance,
    );
    const bare = { ...atom, entityId: "27303" };
    await expect(storage.writePropertyAtomsBatch([bare])).rejects.toMatchObject({
      code: NON_CANONICAL_BINDING,
    });
  });
});
