import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { parseEditionBundle } from "../bundle.js";
import { ingestEditionBundle } from "../ingest.js";
import { resolveEditionAtDate } from "../resolve.js";

const SAMPLE_BUNDLE = parseEditionBundle({
  format: "hauska-edition-bundle/1",
  generatedAt: "2026-06-21T12:00:00.000Z",
  jurisdictionTenant: "bastrop_tx",
  jurisdictionName: "Bastrop, TX",
  provenance: "K1-W2-A test fixture",
  entries: [
    {
      edition: {
        entityId: "bastrop_tx/ibc-2021-adopted",
        editionLabel: "IBC 2021 (adopted Jul 2022)",
        effectiveFrom: "2022-07-01T00:00:00.000Z",
        effectiveTo: "2025-04-01T00:00:00.000Z",
        sourceAdapter: "acquisition-pdf",
        sourceUrl: "https://example.com/ord-2022-ibc.pdf",
        modelCodeBase: "IBC",
        modelCodeYear: 2021,
      },
      adoptionOrdinance: {
        ordinanceId: "ord-2022-ibc",
        effectiveDate: "2022-07-01T00:00:00.000Z",
        authority: "Bastrop City Council",
        title: "Adoption of 2021 IBC",
        sourceUrl: "https://example.com/ord-2022-ibc.pdf",
      },
    },
    {
      edition: {
        entityId: "bastrop_tx/bastrop-b3-code-april-2025",
        editionLabel: "Bastrop B3 Code (April 2025)",
        effectiveFrom: "2025-04-01T00:00:00.000Z",
        effectiveTo: null,
        sourceAdapter: "municode-html",
        sourceUrl: "https://library.municode.com/tx/bastrop",
      },
    },
  ],
});

describe("ingestEditionBundle", () => {
  it("writes editions, adoption amendments, and resolves edition at date", async () => {
    const storage = new InMemoryStorage();
    const result = await ingestEditionBundle(storage, SAMPLE_BUNDLE);
    expect(result.editionsWritten).toBe(2);
    expect(result.amendmentsWritten).toBe(1);

    const in2023 = await resolveEditionAtDate(storage, {
      jurisdictionTenant: "bastrop_tx",
      asOf: "2023-06-15T00:00:00.000Z",
    });
    expect(in2023.edition?.entityId).toBe("bastrop_tx/ibc-2021-adopted");

    const in2025 = await resolveEditionAtDate(storage, {
      jurisdictionTenant: "bastrop_tx",
      asOf: "2025-06-01T00:00:00.000Z",
    });
    expect(in2025.edition?.entityId).toBe("bastrop_tx/bastrop-b3-code-april-2025");
  });
});
