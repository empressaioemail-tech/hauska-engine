import { describe, it, expect, vi } from "vitest";

import {
  BASTROP_REGISTRY_ROW,
  BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  ELGIN_REGISTRY_ROW,
  loadJurisdictionRegistryRow,
  loadJurisdictionRegistryRowsForFips,
} from "../jurisdiction-registry.js";
import { loadRegistryDistrictCohort, buildWhereClause } from "../parcel-cohort-loader.js";

describe("registry cohort rail (Phase D)", () => {
  it("Bastrop registry row carries railPerParcel cohort config", () => {
    expect(BASTROP_REGISTRY_ROW.railPerParcel).toBeDefined();
    const filter = BASTROP_REGISTRY_ROW.railPerParcel?.parcelFilter;
    expect(filter?.kind).toBe("cityFilter");
    if (filter?.kind === "cityFilter") {
      expect(filter.value).toBe("BASTROP");
    }
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

describe("ParcelCohortFilter discriminated union (onboard-fips foundation)", () => {
  it("cityFilter variant (Bastrop, unchanged) builds a CITY = '...' clause", () => {
    const where = buildWhereClause(BASTROP_REGISTRY_ROW, null);
    expect(where).toBe("CITY = 'BASTROP'");
  });

  it("cityFilter variant with a district prefix appends AND districtField = value", () => {
    const where = buildWhereClause(BASTROP_REGISTRY_ROW, "MU");
    expect(where).toBe("CITY = 'BASTROP' AND ZoneTypeClass = 6");
  });

  it("noFilter (whole-county) variant with no district prefix is an always-true predicate", () => {
    const where = buildWhereClause(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW, null);
    expect(where).toBe("1=1");
  });

  it("noFilter (whole-county) variant with a district prefix has no leading AND", () => {
    const where = buildWhereClause(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW, "SF-1");
    expect(where).toBe("ZoneTypeClass = 3");
  });

  it("throws honest-absence when the row has no railPerParcel at all (Elgin, source TODO)", () => {
    expect(() => buildWhereClause(ELGIN_REGISTRY_ROW, null)).toThrow(/honest-absence/);
  });

  // loadRegistryDistrictCohort resolves by fips via loadJurisdictionRegistryRow,
  // which returns the "active" row (Bastrop city) for 48021 — a whole-county
  // cohort fetch is exercised directly against buildWhereClause above (the
  // WHERE-clause construction is the part loadRegistryDistrictCohort's
  // pagination loop consumes verbatim); loadRegistryDistrictCohort itself
  // stays fips-keyed to the active row until it grows a rowId-keyed variant.
});

describe("multi-row-per-fips registry (onboard-fips foundation)", () => {
  it("loadJurisdictionRegistryRowsForFips returns all three 48021 rows", () => {
    const rows = loadJurisdictionRegistryRowsForFips("48021");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.rowId).sort()).toEqual(
      ["Bastrop", "Bastrop County (unincorporated)", "Elgin"].sort(),
    );
  });

  it("loadJurisdictionRegistryRow(fips) still resolves to the active Bastrop row (back-compat)", () => {
    const row = loadJurisdictionRegistryRow("48021");
    expect(row).toBe(BASTROP_REGISTRY_ROW);
    expect(row?.status).toBe("active");
  });

  it("the two new rows are pre-flight-pending, not active", () => {
    expect(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW.status).toBe("pre-flight-pending");
    expect(ELGIN_REGISTRY_ROW.status).toBe("pre-flight-pending");
  });

  it("zoningRegime is set per doctrine: county unincorporated unzoned, Bastrop + Elgin euclidean-zoned", () => {
    expect(BASTROP_REGISTRY_ROW.zoningRegime).toBe("euclidean-zoned");
    expect(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW.zoningRegime).toBe("unzoned");
    expect(ELGIN_REGISTRY_ROW.zoningRegime).toBe("euclidean-zoned");
  });
});
