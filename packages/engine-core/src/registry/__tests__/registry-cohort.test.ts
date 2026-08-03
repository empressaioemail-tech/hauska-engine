import { describe, it, expect, vi } from "vitest";

import { BASTROP_REGISTRY_ROW, loadJurisdictionRegistryRow } from "../jurisdiction-registry.js";
import { loadRegistryDistrictCohort } from "../parcel-cohort-loader.js";

describe("registry cohort rail (Phase D)", () => {
  it("Bastrop registry row carries railPerParcel cohort config", () => {
    expect(BASTROP_REGISTRY_ROW.railPerParcel).toBeDefined();
    expect(BASTROP_REGISTRY_ROW.railPerParcel?.cityFilter.value).toBe("BASTROP");
    expect(BASTROP_REGISTRY_ROW.railPerParcel?.districtValueByPrefix.MU).toBe(6);
    expect(BASTROP_REGISTRY_ROW.railPerParcel?.districtValueByPrefix["SF-1"]).toBe(3);
  });

  it("un-onboarded county has no railPerParcel", () => {
    expect(loadJurisdictionRegistryRow("48129")).toBeNull();
  });
});

describe("loadRegistryDistrictCohort (mocked AGOL)", () => {
  it("paginates layer-23 MU district from registry row", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("ZoneTypeClass+%3D+6");
      expect(url).toContain("CITY+%3D+%27BASTROP%27");
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { prop_id: "141364" } }, { attributes: { prop_id: "109388" } }],
        }),
      } as Response;
    });
    const loaded = await loadRegistryDistrictCohort("48021", "MU", { fetchImpl });
    expect(loaded.count).toBe(2);
    expect(loaded.parcelNodeIds).toEqual(["48021:141364", "48021:109388"]);
    expect(loaded.source).toContain("Bastrop");
  });
});
