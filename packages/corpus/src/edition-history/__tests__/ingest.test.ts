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

  it("preserves existing currentEditionId when ingesting historical editions", async () => {
    const storage = new InMemoryStorage();
    
    const currentBundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-06-21T12:00:00.000Z",
      jurisdictionTenant: "test_city",
      jurisdictionName: "Test City",
      entries: [
        {
          edition: {
            entityId: "test_city/current-supplement-2026",
            editionLabel: "Current Supplement (2026)",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            effectiveTo: null,
            sourceAdapter: "municode-html",
            sourceUrl: "https://library.municode.com/test",
          },
        },
      ],
    });
    await ingestEditionBundle(storage, currentBundle);
    
    const corpusBeforeHistorical = await storage.getAtom("jurisdiction-corpus", "test_city");
    expect(corpusBeforeHistorical?.entityType).toBe("jurisdiction-corpus");
    if (corpusBeforeHistorical?.entityType === "jurisdiction-corpus") {
      expect(corpusBeforeHistorical.currentEditionId).toBe("test_city/current-supplement-2026");
    }

    const historicalBundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-06-22T12:00:00.000Z",
      jurisdictionTenant: "test_city",
      jurisdictionName: "Test City",
      provenance: "Wave-4 historical IBC adoptions",
      entries: [
        {
          edition: {
            entityId: "test_city/ibc-2021",
            editionLabel: "IBC 2021",
            effectiveFrom: "2021-04-01T00:00:00.000Z",
            effectiveTo: "2024-01-01T00:00:00.000Z",
            sourceAdapter: "acquisition-pdf",
            sourceUrl: "https://example.com/ord-2021.pdf",
            modelCodeBase: "IBC",
            modelCodeYear: 2021,
          },
          adoptionOrdinance: {
            ordinanceId: "ord-2021-ibc",
            effectiveDate: "2021-04-01T00:00:00.000Z",
            authority: "Test Council",
            title: "Adoption of 2021 IBC",
            sourceUrl: "https://example.com/ord-2021.pdf",
          },
        },
      ],
    });
    
    await ingestEditionBundle(storage, historicalBundle);
    
    const corpusAfterHistorical = await storage.getAtom("jurisdiction-corpus", "test_city");
    expect(corpusAfterHistorical?.entityType).toBe("jurisdiction-corpus");
    if (corpusAfterHistorical?.entityType === "jurisdiction-corpus") {
      expect(corpusAfterHistorical.currentEditionId).toBe("test_city/current-supplement-2026");
      expect(corpusAfterHistorical.adoptedEditionIds).toContain("test_city/ibc-2021");
      expect(corpusAfterHistorical.adoptedEditionIds).toContain("test_city/current-supplement-2026");
    }
  });
});
