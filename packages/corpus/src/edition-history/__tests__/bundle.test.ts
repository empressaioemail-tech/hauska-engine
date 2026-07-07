import { describe, expect, it } from "vitest";

import { parseEditionBundle } from "../bundle.js";

describe("parseEditionBundle date handling", () => {
  it("normalizes date-only strings to UTC midnight", () => {
    const bundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-06-21T12:00:00.000Z",
      jurisdictionTenant: "test_city",
      jurisdictionName: "Test City",
      entries: [
        {
          edition: {
            entityId: "test_city/test-edition",
            editionLabel: "Test Edition",
            effectiveFrom: "2013-09-16",
            effectiveTo: "2021-04-01",
            sourceAdapter: "municode-html",
            sourceUrl: "https://example.com/test",
          },
          adoptionOrdinance: {
            ordinanceId: "ord-2013-test",
            effectiveDate: "2013-09-16",
            authority: "Test Council",
            title: "Test Ordinance",
            sourceUrl: "https://example.com/ord.pdf",
          },
        },
      ],
    });

    expect(bundle.entries[0]!.edition.effectiveFrom).toBe("2013-09-16T00:00:00Z");
    expect(bundle.entries[0]!.edition.effectiveTo).toBe("2021-04-01T00:00:00Z");
    expect(bundle.entries[0]!.adoptionOrdinance!.effectiveDate).toBe("2013-09-16T00:00:00Z");
  });

  it("preserves offset datetime strings unchanged", () => {
    const bundle = parseEditionBundle({
      format: "hauska-edition-bundle/1",
      generatedAt: "2026-06-21T12:00:00.000Z",
      jurisdictionTenant: "test_city",
      jurisdictionName: "Test City",
      entries: [
        {
          edition: {
            entityId: "test_city/test-edition",
            editionLabel: "Test Edition",
            effectiveFrom: "2022-07-01T00:00:00.000Z",
            effectiveTo: "2025-04-01T00:00:00.000Z",
            sourceAdapter: "municode-html",
            sourceUrl: "https://example.com/test",
          },
          adoptionOrdinance: {
            ordinanceId: "ord-2022-test",
            effectiveDate: "2022-07-01T00:00:00.000Z",
            authority: "Test Council",
            title: "Test Ordinance",
            sourceUrl: "https://example.com/ord.pdf",
          },
        },
      ],
    });

    expect(bundle.entries[0]!.edition.effectiveFrom).toBe("2022-07-01T00:00:00.000Z");
    expect(bundle.entries[0]!.edition.effectiveTo).toBe("2025-04-01T00:00:00.000Z");
    expect(bundle.entries[0]!.adoptionOrdinance!.effectiveDate).toBe("2022-07-01T00:00:00.000Z");
  });

  it("rejects garbage date strings", () => {
    expect(() =>
      parseEditionBundle({
        format: "hauska-edition-bundle/1",
        generatedAt: "2026-06-21T12:00:00.000Z",
        jurisdictionTenant: "test_city",
        jurisdictionName: "Test City",
        entries: [
          {
            edition: {
              entityId: "test_city/test-edition",
              editionLabel: "Test Edition",
              effectiveFrom: "not-a-date",
              effectiveTo: null,
              sourceAdapter: "municode-html",
              sourceUrl: "https://example.com/test",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed date strings", () => {
    expect(() =>
      parseEditionBundle({
        format: "hauska-edition-bundle/1",
        generatedAt: "2026-06-21T12:00:00.000Z",
        jurisdictionTenant: "test_city",
        jurisdictionName: "Test City",
        entries: [
          {
            edition: {
              entityId: "test_city/test-edition",
              editionLabel: "Test Edition",
              effectiveFrom: "2022-13-45",
              effectiveTo: null,
              sourceAdapter: "municode-html",
              sourceUrl: "https://example.com/test",
            },
          },
        ],
      }),
    ).toThrow();
  });
});
