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

  it("Elgin registry row carries railPerParcel cohort config (layer 0, Bastrop-county side only)", () => {
    expect(ELGIN_REGISTRY_ROW.railPerParcel).toBeDefined();
    const filter = ELGIN_REGISTRY_ROW.railPerParcel?.parcelFilter;
    expect(filter?.kind).toBe("cityFilter");
    if (filter?.kind === "cityFilter") {
      expect(filter.field).toBe("CITY_LIMIT");
      expect(filter.value).toBe("ELGIN");
    }
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.featureServerLayerUrl).toContain("Elgin_Zoning/FeatureServer/0");
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.districtField).toBe("Zone_Code");
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.propIdField).toBe("PROP_ID");
    // "A" is the sole GIS/ordinance divergence — every other district code
    // maps to itself (identity), per Sec. 46-203 vs. Sec. 46-391/46-417.
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.districtValueByPrefix["R-4"]).toBe("A");
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.districtValueByPrefix["R-1"]).toBe("R-1");
    expect(ELGIN_REGISTRY_ROW.railPerParcel?.districtValueByPrefix.I).toBe("I");
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

  it("Elgin (railPerParcel wired 2026-08-03) builds a CITY_LIMIT = 'ELGIN' clause", () => {
    const where = buildWhereClause(ELGIN_REGISTRY_ROW, null);
    expect(where).toBe("CITY_LIMIT = 'ELGIN'");
  });

  it("Elgin R-4 prefix resolves through the A-domain-value mapping (Zone_Code = 'A')", () => {
    const where = buildWhereClause(ELGIN_REGISTRY_ROW, "R-4");
    expect(where).toBe("CITY_LIMIT = 'ELGIN' AND Zone_Code = 'A'");
  });

  it("Elgin identity-mapped prefix (e.g. C-2) resolves to the same value as its canonical name", () => {
    const where = buildWhereClause(ELGIN_REGISTRY_ROW, "C-2");
    expect(where).toBe("CITY_LIMIT = 'ELGIN' AND Zone_Code = 'C-2'");
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
