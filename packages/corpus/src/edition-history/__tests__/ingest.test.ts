import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { parseEditionBundle } from "../bundle.js";
import { ingestEditionBundle, selectCurrentEditionId } from "../ingest.js";
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

    const corpusBeforeHistorical = await storage.getAtom(
      "jurisdiction-corpus",
      "test_city",
    );
    expect(corpusBeforeHistorical?.entityType).toBe("jurisdiction-corpus");
    if (corpusBeforeHistorical?.entityType === "jurisdiction-corpus") {
      expect(corpusBeforeHistorical.currentEditionId).toBe(
        "test_city/current-supplement-2026",
      );
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

    const corpusAfterHistorical = await storage.getAtom(
      "jurisdiction-corpus",
      "test_city",
    );
    expect(corpusAfterHistorical?.entityType).toBe("jurisdiction-corpus");
    if (corpusAfterHistorical?.entityType === "jurisdiction-corpus") {
      expect(corpusAfterHistorical.currentEditionId).toBe(
        "test_city/current-supplement-2026",
      );
      expect(corpusAfterHistorical.adoptedEditionIds).toContain(
        "test_city/ibc-2021",
      );
      expect(corpusAfterHistorical.adoptedEditionIds).toContain(
        "test_city/current-supplement-2026",
      );
    }
  });

  it("advances currentEditionId on temporal supersession (B3 closed → BDC open)", async () => {
    const storage = new InMemoryStorage();

    const b3Bundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-05-26T00:00:00.000Z",
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      entries: [
        {
          edition: {
            entityId: "bastrop_tx/bastrop-b3-code-april-2025",
            editionLabel: "Bastrop B3 Code (April 2025)",
            effectiveFrom: "2025-04-01T00:00:00.000Z",
            effectiveTo: null,
            sourceAdapter: "bastrop-b3-pdf",
            sourceUrl: "https://example.com/b3.pdf",
          },
        },
        {
          edition: {
            entityId: "bastrop_tx-ibc-2018-adopted",
            editionLabel: "2018 IBC (Ordinance No. 2019-61)",
            effectiveFrom: "2019-11-26T00:00:00.000Z",
            effectiveTo: "2026-04-13T00:00:00.000Z",
            sourceAdapter: "k1-adoption-ordinance-pdf",
            sourceUrl: "https://example.com/ibc.pdf",
            modelCodeBase: "IBC",
            modelCodeYear: 2018,
          },
          adoptionOrdinance: {
            ordinanceId: "2019-61",
            effectiveDate: "2019-11-26T00:00:00.000Z",
            authority: "City of Bastrop",
            title: "Ordinance No. 2019-61",
            sourceUrl: "https://example.com/ibc.pdf",
          },
        },
      ],
    });
    await ingestEditionBundle(storage, b3Bundle);

    const before = await storage.getAtom("jurisdiction-corpus", "bastrop_tx");
    expect(
      before?.entityType === "jurisdiction-corpus" && before.currentEditionId,
    ).toBe("bastrop_tx/bastrop-b3-code-april-2025");

    // Supersession: close B3 on the IBC-boundary day and open BDC.
    const bdcBundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-07-29T00:00:00.000Z",
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      provenance: "WDLL BDC STEP1 supersession",
      entries: [
        {
          edition: {
            entityId: "bastrop_tx/bastrop-b3-code-april-2025",
            editionLabel: "Bastrop B3 Code (April 2025)",
            effectiveFrom: "2025-04-01T00:00:00.000Z",
            effectiveTo: "2026-04-13T23:59:59.000Z",
            sourceAdapter: "bastrop-b3-pdf",
            sourceUrl: "https://example.com/b3.pdf",
          },
        },
        {
          edition: {
            entityId: "bastrop_tx-bdc-2026-adopted",
            editionLabel: "2026 BDC (Ordinance No. 2026-06)",
            effectiveFrom: "2026-04-14T00:00:00.000Z",
            effectiveTo: null,
            sourceAdapter: "k1-adoption-ordinance-pdf",
            sourceUrl: "https://example.com/bdc.pdf",
          },
          adoptionOrdinance: {
            ordinanceId: "2026-06",
            effectiveDate: "2026-04-14T00:00:00.000Z",
            authority: "City of Bastrop",
            title: "Ordinance No. 2026-06",
            sourceUrl: "https://example.com/bdc.pdf",
          },
        },
      ],
    });

    const sectionEntityId = "bastrop_tx-bdc-2026-adopted/14-02-003";
    const result = await ingestEditionBundle(storage, bdcBundle, {
      sections: [
        {
          entityType: "code-section",
          entityId: sectionEntityId,
          jurisdictionTenant: "bastrop_tx",
          codeEditionId: "bastrop_tx-bdc-2026-adopted",
          sectionNumber: "14.02.003",
          title: "District Requirements",
          subsectionPath: null,
          bodyText:
            "SF-1 Front Setback 30 feet. Side Setback 10 feet. Corner Side Street Setback 20 feet. Rear Setback 30 feet.",
          fetchedAt: "2026-07-29T00:00:00.000Z",
          sourceAdapter: "bastrop-bdc-pdf",
          sourceUrl: "https://example.com/bdc.pdf",
          contentHash: "test-hash-14-02-003",
        },
      ],
    });

    expect(result.currentEditionId).toBe("bastrop_tx-bdc-2026-adopted");

    const after = await storage.getAtom("jurisdiction-corpus", "bastrop_tx");
    expect(after?.entityType).toBe("jurisdiction-corpus");
    if (after?.entityType === "jurisdiction-corpus") {
      expect(after.currentEditionId).toBe("bastrop_tx-bdc-2026-adopted");
      expect(after.adoptedEditionIds).toContain("bastrop_tx-ibc-2018-adopted");
      expect(after.adoptedEditionIds).toContain(
        "bastrop_tx/bastrop-b3-code-april-2025",
      );
      expect(after.adoptedEditionIds).toContain("bastrop_tx-bdc-2026-adopted");
    }

    const bdc = await storage.getAtom(
      "code-edition",
      "bastrop_tx-bdc-2026-adopted",
    );
    expect(bdc?.entityType).toBe("code-edition");
    if (bdc?.entityType === "code-edition") {
      expect(bdc.sectionIds).toContain(sectionEntityId);
      expect(bdc.effectiveFrom).toBe("2026-04-14T00:00:00.000Z");
    }

    const b3 = await storage.getAtom(
      "code-edition",
      "bastrop_tx/bastrop-b3-code-april-2025",
    );
    expect(b3?.entityType).toBe("code-edition");
    if (b3?.entityType === "code-edition") {
      expect(b3.effectiveTo).toBe("2026-04-13T23:59:59.000Z");
    }

    // IBC path undisturbed: still adopted, same temporal window, resolvable
    // historically, and NOT promoted to currentEditionId.
    const ibc = await storage.getAtom(
      "code-edition",
      "bastrop_tx-ibc-2018-adopted",
    );
    expect(ibc?.entityType).toBe("code-edition");
    if (ibc?.entityType === "code-edition") {
      expect(ibc.effectiveFrom).toBe("2019-11-26T00:00:00.000Z");
      expect(ibc.effectiveTo).toBe("2026-04-13T00:00:00.000Z");
      expect(ibc.sectionIds).toEqual([]);
    }

    const ibcAtDate = await resolveEditionAtDate(storage, {
      jurisdictionTenant: "bastrop_tx",
      asOf: "2020-06-01T00:00:00.000Z",
    });
    expect(ibcAtDate.edition?.entityId).toBe("bastrop_tx-ibc-2018-adopted");

    const bdcAtDate = await resolveEditionAtDate(storage, {
      jurisdictionTenant: "bastrop_tx",
      asOf: "2026-04-15T00:00:00.000Z",
    });
    expect(bdcAtDate.edition?.entityId).toBe("bastrop_tx-bdc-2026-adopted");
  });
});

describe("selectCurrentEditionId", () => {
  it("picks the latest open-ended edition", () => {
    expect(
      selectCurrentEditionId(
        [
          {
            entityId: "b3",
            effectiveFrom: "2025-04-01T00:00:00.000Z",
            effectiveTo: "2026-04-13T23:59:59.000Z",
          },
          {
            entityId: "ibc",
            effectiveFrom: "2019-11-26T00:00:00.000Z",
            effectiveTo: "2026-04-13T00:00:00.000Z",
          },
          {
            entityId: "bdc",
            effectiveFrom: "2026-04-14T00:00:00.000Z",
            effectiveTo: null,
          },
        ],
        "b3",
      ),
    ).toBe("bdc");
  });

  it("falls back when every edition is closed", () => {
    expect(
      selectCurrentEditionId(
        [
          {
            entityId: "ibc",
            effectiveFrom: "2019-11-26T00:00:00.000Z",
            effectiveTo: "2026-04-13T00:00:00.000Z",
          },
        ],
        "kept",
      ),
    ).toBe("kept");
  });
});
