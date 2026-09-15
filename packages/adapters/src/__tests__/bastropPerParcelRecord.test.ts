/**
 * WDLL STEP 1+2 — Bastrop per-parcel layer 23 adapter (F4 source + MU/GC/PDD).
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
  selectBastropLayer23Attributes,
  setbackTableFromBastropPerParcelRecord,
} from "../local/setbacks/bastrop-per-parcel-record.js";
import {
  getSetbackTableForZoning,
  isBdcPerParcelDistrictCode,
  isRetiredSetbackProvenance,
} from "../local/setbacks/index.js";

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

function mockFetchForOverlapRows(rows: Record<string, unknown>[]) {
  return vi.fn(async () =>
    jsonResponse({
      features: rows.map((attributes) => ({ attributes })),
    }),
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

  it("parses numeric FrontSetback_/SideSetback_/RearSetback_ doubles from live layer 23", () => {
    const parsed = parseBastropPerParcelAttributes({
      prop_id: 105054,
      FrontSetback_: 25,
      SideSetback_: 5,
      SideSetback: "5 ft (Corner Side Street Setback: 15 ft)",
      RearSetback_: 25,
      Ordinance_Link: "https://example.test/105054",
    });
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(25);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.sideCornerFt).toBe(15);
    expect(parsed.rearFt).toBe(25);
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

  it("R22: MU side fire-code deferral resolves to 5ft (envelope draws), city language surfaced", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["34841_mu_non_scalar"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(15);
    expect(parsed.rearFt).toBe(15);
    expect(parsed.maxHeightFt).toBe(40);
    expect(parsed.maxImperviousPct).toBe(60);
    // R22 — fire-code deferral now resolves to the 5ft code minimum (NOT a decline).
    expect(parsed.sideNonScalar).toBe(false);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.sideCornerFt).toBe(5);
    expect(parsed.sideFireCodeDeferral).toBe(true);
    expect(parsed.sideCityLanguage).toMatch(/Reference Building Code/i);
    const side = parseSideSetbackText("None - Reference Building Code/Fire Code");
    expect(side.ok).toBe(true);
    if (side.ok) {
      expect(side.sideInteriorFt).toBe(5);
      expect(side.fireCodeDeferral).toBe(true);
    }
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

  it("getSetbackTableForZoning follows the RULED chart, never the retired per-parcel scalars (P-219)", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["105054"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const resolution = getSetbackTableForZoning("bastrop-city-tx", "SF-1", {
      bastropPerParcelRecord: parsed,
    });
    // P-219 CHANGED THIS CASE, and the change IS the retirement.
    //
    // This fixture's row cites no resolvable ordinance (its `Ordinance_Link`
    // is a URL), so R-1 cannot order the two sources. Wave 6 resolved that by
    // serving the per-parcel record and disclosing the disagreement. But the
    // per-parcel record's scalars carry a `bastrop-per-parcel/*` provenance,
    // which is retired as a value author: that is the path by which both PDF
    // products printed 25/5/25 for 48021:34049 cited to an ordinance the City
    // of Bastrop repealed on 2026-04-14. So the unordered arm now follows the
    // ruled chart, and the retired source is NAMED as the second source with
    // its own values rather than picked in silence.
    expect(resolution!.kind).toBe("conflict");
    const table = resolution!.table;
    expect(table.jurisdictionKey).toBe("bastrop-development-code");
    const row = table.districts[0]!;
    expect(row.front_ft).toBe(30);
    expect(row.side_ft).toBe(10);
    expect(row.side_corner_ft).toBe(20);
    expect(row.rear_ft).toBe(30);
    if (resolution!.kind !== "conflict") return;

    // The retirement, proven by what the SERVED row cites: no scalar on the
    // followed table may rest on a retired provenance.
    const provenance = row.provenance as
      | Record<string, { atom_did?: string } | undefined>
      | undefined;
    for (const key of ["front_ft", "side_ft", "rear_ft", "side_corner_ft"]) {
      expect(isRetiredSetbackProvenance(provenance?.[key]?.atom_did)).toBe(false);
    }

    // The retired source is still named, with its own numbers, so the
    // disagreement the P-154 conflict row exists to disclose still prints.
    expect(resolution!.secondSource.id).toBe("bastrop-per-parcel-record");
    if (resolution!.note.shape !== "second-source") throw new Error("expected the two-instrument shape");
    expect(resolution!.note.front).toBe(25);
    expect(resolution!.note.side).toBe(5);
    expect(resolution!.note.rear).toBe(25);
    expect(resolution!.note.corner).toBe(15);
    expect(resolution!.reason).toContain("RETIRED");
    // No repeal claim: neither side here carries an ordinance-effective date
    // to support one (the record's own citation is a URL, not an ordinance).
    expect(resolution!.note.repealedByEffectiveDate).toBeNull();
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

describe("bastrop per-parcel layer 23 (WDLL STEP 2 — MU/GC/PDD)", () => {
  it("isBdcPerParcelDistrictCode marks MU/GC/PDD as layer-23-only", () => {
    expect(isBdcPerParcelDistrictCode("MU")).toBe(true);
    expect(isBdcPerParcelDistrictCode("GC")).toBe(true);
    expect(isBdcPerParcelDistrictCode("PDD")).toBe(true);
    expect(isBdcPerParcelDistrictCode("SF-1")).toBe(false);
  });

  it("MU/GC without per-parcel record return null (no chart-row honest-decline bypass)", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "MU")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "GC")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "PDD")).toBeNull();
  });

  it("48021:34089 GC routes through per-parcel adapter when record supplied", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["34089"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const resolution = getSetbackTableForZoning("bastrop-city-tx", "GC", {
      bastropPerParcelRecord: parsed,
      districtCode: "GC",
    });
    // GC has no codified chart row (R13 per-parcel-only district), so there
    // is one source and nothing to disclose — never a conflict row.
    expect(resolution!.kind).toBe("table");
    const row = resolution!.table.districts[0]!;
    expect(row.front_ft).toBe(20);
    expect(row.side_ft).toBe(5);
    expect(row.side_corner_ft).toBe(10);
    expect(row.rear_ft).toBe(20);
    expect(row.max_height_ft).toBe(55);
    expect(row.max_impervious_pct).toBe(65);
    expect(row.provenance?.side_ft?.not_specified).toBeUndefined();
  });

  it("R22: 48021:34841 MU base dims with side resolved to 5ft fire-code", () => {
    const parsed = parseBastropPerParcelAttributes(FIXTURES["34841_mu_non_scalar"]!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    const resolution = getSetbackTableForZoning("bastrop-city-tx", "MU", {
      bastropPerParcelRecord: parsed,
      districtCode: "MU",
    });
    // MU is per-parcel-only (no chart row): one source, no conflict row.
    expect(resolution!.kind).toBe("table");
    const row = resolution!.table.districts[0]!;
    expect(row.front_ft).toBe(15);
    expect(row.rear_ft).toBe(15);
    expect(row.side_ft).toBe(5);
    expect(row.side_corner_ft).toBe(5);
    expect(row.max_height_ft).toBe(40);
    expect(row.max_impervious_pct).toBe(60);
    // R22 — side is a real fire-code value now, not not_specified.
    expect(row.provenance?.side_ft?.not_specified).toBeUndefined();
    expect(row.display_meta?.side_fire_code_deferral).toBe(true);
  });

  it("R26: selectBastropLayer23Attributes picks the DOMINANT-area row on overlap (MU 12000sf > SF-1 8000sf)", () => {
    const picked = selectBastropLayer23Attributes(
      [
        { attributes: FIXTURES["34841_sf1_overlap"]! },
        { attributes: FIXTURES["34841_mu_overlap"]! },
      ],
      "MU",
    );
    // Dominant area (MU 12000) governs, not the passed stamp per se.
    expect(picked?.ZoneTypeClass).toBe(6);
    const parsed = parseBastropPerParcelAttributes(picked!);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(15);
    expect(parsed.rearFt).toBe(15);
    // R22 — side resolves to fire-code 5ft.
    expect(parsed.sideNonScalar).toBe(false);
    expect(parsed.sideInteriorFt).toBe(5);
  });

  it("R26: fetch resolves dominant-area district + discloses minor zones on overlap parcels", async () => {
    const fetchImpl = mockFetchForOverlapRows([
      FIXTURES["34841_sf1_overlap"]!,
      FIXTURES["34841_mu_overlap"]!,
    ]);
    const result = await fetchBastropPerParcelSetbackRecord("34841", {
      fetchImpl,
      districtCode: "MU",
    });
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.frontFt).toBe(15);
    expect(result.rearFt).toBe(15);
    // R22 fire-code side.
    expect(result.sideNonScalar).toBe(false);
    expect(result.sideInteriorFt).toBe(5);
    expect(result.sideFireCodeDeferral).toBe(true);
    // R26 — dominant district = MU; the minor SF-1 zone is disclosed.
    expect(result.resolvedDistrictCode).toBe("MU");
    expect(result.splitZoneMinorZones?.some((z) => z.districtCode === "SF-1")).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url).toContain(BASTROP_PARCELS_ONE_CLICK_LAYER_23.split("/FeatureServer")[0]);
  });
});
