import { describe, expect, it } from "vitest";

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
