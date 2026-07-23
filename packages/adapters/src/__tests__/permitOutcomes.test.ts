import { describe, expect, it, vi } from "vitest";
import sample from "../portal/permit-outcomes/__fixtures__/austinSodaSample.json";
import {
  fetchAustinSodaPermitOutcomes,
  fetchBastropMygovPermitOutcomes,
  fetchGrandCountyUtPermitOutcomes,
  mapStatusToOutcomeKind,
  normalizeAustinSodaRow,
  permitOutcomeEntityId,
  toFindingOutcomePayload,
} from "../portal/permit-outcomes/index";

describe("permit-outcome normalize (LDT finding-outcome shape)", () => {
  it("maps issued/active/final to permit-approved", () => {
    expect(mapStatusToOutcomeKind("Active")).toBe("permit-approved");
    expect(mapStatusToOutcomeKind("Final")).toBe("permit-approved");
    expect(mapStatusToOutcomeKind("Issued")).toBe("permit-approved");
  });

  it("drops denied/void statuses (no invented negative kind)", () => {
    expect(mapStatusToOutcomeKind("Denied")).toBeNull();
    expect(mapStatusToOutcomeKind("Cancelled")).toBeNull();
  });

  it("normalizes Austin SODA fixture rows to LDT-compatible payloads", () => {
    const rows = (sample as Record<string, unknown>[])
      .map((r) => normalizeAustinSodaRow(r))
      .filter(Boolean);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcomeKind).toBe("permit-approved");
    expect(rows[0]!.jurisdictionTenant).toBe("austin_tx");
    expect(rows[0]!.sourceId).toBe("austin-soda");
    expect(rows[0]!.parcelHint).toBe("0220101909");

    const payload = toFindingOutcomePayload(rows[0]!);
    expect(payload.outcomeKind).toBe("permit-approved");
    expect(payload.provenance).toBe("backtest");
    expect(payload.jurisdictionTenant).toBe("austin_tx");
    expect(payload.findingAtomId).toBe(permitOutcomeEntityId(rows[0]!));
  });
});

describe("fetchAustinSodaPermitOutcomes", () => {
  it("fetches and normalizes via injected fetchImpl", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(sample), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await fetchAustinSodaPermitOutcomes({
      limit: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.partialReason).toBeNull();
    expect(result.outcomes.length).toBe(2);
    expect(result.httpStatus).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0]![0]);
    expect(calledUrl).toContain("3syk-w9eu.json");
    // URLSearchParams encodes `$` as `%24`
    expect(calledUrl).toMatch(/%24limit=10|\$limit=10/);
  });
});

describe("bastrop + grand county PARTIAL probes", () => {
  it("bastrop_tx returns honest empty with PARTIAL reason", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("<html>lookup</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const result = await fetchBastropMygovPermitOutcomes({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.outcomes).toEqual([]);
    expect(result.partialReason).toMatch(/no public bulk JSON/i);
    expect(result.jurisdictionTenant).toBe("bastrop_tx");
  });

  it("grand_county_ut returns honest empty with PARTIAL reason", async () => {
    const result = await fetchGrandCountyUtPermitOutcomes();
    expect(result.outcomes).toEqual([]);
    expect(result.partialReason).toMatch(/no verified public bulk/i);
    expect(result.jurisdictionTenant).toBe("grand_county_ut");
  });
});
