/**
 * WDLL STEP 1 — Bastrop per-parcel layer 23 adapter (F4 source + side model).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../__fixtures__/arcgisFixtures.js";
import {
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
  fetchBastropPerParcelSetbackRecord,
  flagBastropChartDisagreement,
  parseBastropPerParcelAttributes,
  parseSideSetbackText,
  setbackTableFromBastropPerParcelRecord,
} from "../local/setbacks/bastrop-per-parcel-record.js";
import { getSetbackTableForZoning } from "../local/setbacks/index.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../__fixtures__/bastropPerParcelLayer23.json",
);
const FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<
  string,
  Record<string, unknown>
>;

function mockFetchForPropId(propId: string) {
  const attrs = FIXTURES[propId];
  if (!attrs) {
    return vi.fn(async () =>
      jsonResponse({ features: [] }),
    ) as unknown as typeof fetch;
  }
  return vi.fn(async () =>
    jsonResponse({ features: [{ attributes: attrs }] }),
  ) as unknown as typeof fetch;
}

describe("bastrop per-parcel layer 23 (WDLL STEP 1)", () => {
  it("parses 105054 as 25 / 5 interior / 15 corner / 25 with Ordinance_Link", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["105054"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.propId).toBe("105054");
    expect(parsed.frontFt).toBe(25);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.sideCornerFt).toBe(15);
    expect(parsed.rearFt).toBe(25);
    expect(parsed.ordinanceLink).toContain("105054");
    expect(parsed.sideNonScalar).toBe(false);
  });

  it("parses 34089 GC as 20 / 5 / 10 corner / 20", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["34089"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(20);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.sideCornerFt).toBe(10);
    expect(parsed.rearFt).toBe(20);
    expect(parsed.maxHeightFt).toBe(55);
    expect(parsed.maxImperviousPct).toBe(65);
  });

  it("honest-decline non-scalar MU side (Reference Building Code/Fire Code)", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["34841_mu_non_scalar"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.sideNonScalar).toBe(true);
    expect(parsed.sideInteriorFt).toBeNull();
    expect(parsed.sideDeclineReason).toMatch(/Reference Building Code/i);
    expect(parseSideSetbackText("Reference Building Code/Fire Code").ok).toBe(false);
  });

  it("flags chart disagreement for 105054 SF-1 (chart 30/10/20/30 vs record 25/5/15/25)", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["105054"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const flag = flagBastropChartDisagreement(parsed, "SF-1");
    expect(flag.disagrees).toBe(true);
    expect(flag.chart).toEqual({
      frontFt: 30,
      sideInteriorFt: 10,
      sideCornerFt: 20,
      rearFt: 30,
    });
    expect(flag.record).toEqual({
      frontFt: 25,
      sideInteriorFt: 5,
      sideCornerFt: 15,
      rearFt: 25,
    });
  });

  it("getSetbackTableForZoning uses per-parcel numbers when record supplied", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["105054"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const table = getSetbackTableForZoning("bastrop-city-tx", "SF-1", {
      bastropPerParcelRecord: parsed,
    });
    expect(table!.jurisdictionKey).toBe("bastrop-per-parcel-record");
    const row = table!.districts[0]!;
    expect(row.front_ft).toBe(25);
    expect(row.side_ft).toBe(5);
    expect(row.side_corner_ft).toBe(15);
    expect(row.rear_ft).toBe(25);
    expect(row.citation_url).toContain("105054");
  });

  it("fetchBastropPerParcelSetbackRecord hits layer 23 by prop_id", async () => {
    const fetchImpl = mockFetchForPropId("105054");
    const result = await fetchBastropPerParcelSetbackRecord("105054", { fetchImpl });
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.frontFt).toBe(25);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("Parcels_One_Click");
    expect(url).toContain("prop_id+%3D+105054");
  });

  it("setbackTableFromBastropPerParcelRecord exposes distinct interior and corner side", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["105054"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const table = setbackTableFromBastropPerParcelRecord(parsed, "SF-1");
    expect(table.districts[0]!.side_ft).toBe(5);
    expect(table.districts[0]!.side_corner_ft).toBe(15);
  });
});
