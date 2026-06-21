import { describe, expect, it } from "vitest";

import {
  AMENDMENT_HAZARD_COLD_START_PRIOR,
  computeAmendmentHazardRate,
  validityDecayFromHazard,
} from "../hazard.js";

describe("computeAmendmentHazardRate", () => {
  it("returns cold-start prior when no amendments exist", () => {
    const result = computeAmendmentHazardRate({
      atomClass: "R-3xx",
      amendments: [],
    });
    expect(result.source).toBe("cold-start-prior");
    expect(result.rate).toBe(AMENDMENT_HAZARD_COLD_START_PRIOR);
    expect(result.amendmentCount).toBe(0);
  });

  it("computes rate from amendment history when fuel exists", () => {
    const result = computeAmendmentHazardRate({
      atomClass: "R-3xx",
      asOf: "2026-01-01T00:00:00.000Z",
      amendments: [
        {
          entityType: "code-amendment",
          entityId: "j/ord-1",
          jurisdictionTenant: "j",
          amendmentScope: "temporal",
          ordinanceId: "ord-1",
          effectiveDate: "2024-01-01T00:00:00.000Z",
          authority: "Council",
          affectedSectionIds: [],
          amendmentText: "Amend",
          replacesSectionContentHash: null,
          fetchedAt: "2026-01-01T00:00:00.000Z",
          sourceAdapter: "test",
          sourceUrl: "https://example.com",
          contentHash: "abc",
        },
        {
          entityType: "code-amendment",
          entityId: "j/ord-2",
          jurisdictionTenant: "j",
          amendmentScope: "temporal",
          ordinanceId: "ord-2",
          effectiveDate: "2025-01-01T00:00:00.000Z",
          authority: "Council",
          affectedSectionIds: [],
          amendmentText: "Amend 2",
          replacesSectionContentHash: null,
          fetchedAt: "2026-01-01T00:00:00.000Z",
          sourceAdapter: "test",
          sourceUrl: "https://example.com",
          contentHash: "def",
        },
      ],
    });
    expect(result.source).toBe("amendment-history");
    expect(result.amendmentCount).toBe(2);
    expect(result.rate).toBeGreaterThan(AMENDMENT_HAZARD_COLD_START_PRIOR);
  });
});

describe("validityDecayFromHazard", () => {
  it("decays validity with age", () => {
    expect(validityDecayFromHazard(0.02, 0)).toBe(1);
    expect(validityDecayFromHazard(0.02, 10)).toBeLessThan(1);
  });
});
