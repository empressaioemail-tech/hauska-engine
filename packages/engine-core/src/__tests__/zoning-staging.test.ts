/**
 * Adversarial trap coverage for Factory 1.5 zoning staging.
 */
import { describe, expect, it } from "vitest";

import {
  assertTexasWgs84Bbox,
  ZoningProjectionError,
} from "../zoning-staging/bbox.js";
import {
  assertSourceTierSatisfied,
  buildStagingRowId,
  ZoningStagingContractError,
} from "../zoning-staging/payload-contract.js";
import {
  normalizeZoningFeature,
} from "../zoning-staging/normalize.js";
import {
  drainZoningStagingRows,
  type ZoningStagingDbRow,
} from "../zoning-staging/drain.js";
import {
  resolveZoningStagingCity,
  ZONING_STAGING_REGISTRY,
} from "../zoning-staging/registry.js";

const elginSquare = {
  type: "Polygon" as const,
  rings: [
    [
      [-97.38, 30.34],
      [-97.37, 30.34],
      [-97.37, 30.35],
      [-97.38, 30.35],
      [-97.38, 30.34],
    ],
  ],
};

function elginAttrs(overrides: Record<string, unknown> = {}) {
  return {
    OBJECTID: 1,
    OID_: 0,
    CALC_ACRE: 1.2,
    PIN: " ",
    PROP_ID: "R100",
    DICT0: "R100",
    ABST_: "A1",
    ABST_NAME: "TEST",
    SUB_NAME: " ",
    SEC_UNIT: " ",
    LOT: "1",
    BLK: "1",
    CITY: " ",
    COUNTY: "BASTROP",
    Shape_Leng: 100,
    DEED: " ",
    CITY_LIMIT: "ELGIN",
    WARD_No: 1,
    Dev_Agree: " ",
    DevAgrDate: " ",
    Dev_Ord_No: " ",
    Zoning: "Single Family",
    Zone_Code: "R-1",
    Annex: " ",
    AnnexDate: " ",
    Zon_Ord_No: " ",
    ...overrides,
  };
}

function toDbRow(
  partial: Partial<ZoningStagingDbRow> &
    Pick<ZoningStagingDbRow, "staging_row_id" | "city_key" | "district_code">,
): ZoningStagingDbRow {
  return {
    staging_row_id: partial.staging_row_id,
    city_key: partial.city_key,
    city_geo_id: partial.city_geo_id ?? "4823044",
    city_name: partial.city_name ?? "Elgin",
    parent_county_fips: partial.parent_county_fips ?? "48021",
    district_code: partial.district_code,
    district_name: partial.district_name ?? null,
    geometry: partial.geometry ?? {
      type: "Polygon",
      coordinates: [
        [
          [-97.38, 30.34],
          [-97.37, 30.34],
          [-97.37, 30.35],
          [-97.38, 30.35],
          [-97.38, 30.34],
        ],
      ],
    },
    geometry_crs: partial.geometry_crs ?? "EPSG:4326",
    is_overlay: partial.is_overlay ?? false,
    is_base_district: partial.is_base_district ?? true,
    layer_role: partial.layer_role ?? "base",
    geometry_grain: partial.geometry_grain ?? "parcel-joined",
    source_url: partial.source_url ?? "https://example.test",
    source_layer_id: partial.source_layer_id ?? "0",
    fetched_at: partial.fetched_at ?? "2026-08-12T00:00:00.000Z",
    source_tiers: partial.source_tiers ?? ["municipal-arcgis-featureserver"],
    source_tier_satisfied:
      partial.source_tier_satisfied ?? ["municipal-arcgis-featureserver"],
    source_vintage: partial.source_vintage ?? "test",
    source_citation: partial.source_citation ?? "https://example.test",
    passthrough_attributes: partial.passthrough_attributes ?? { ZONING: "C-3" },
    west_lng: partial.west_lng ?? -97.38,
    south_lat: partial.south_lat ?? 30.34,
    east_lng: partial.east_lng ?? -97.37,
    north_lat: partial.north_lat ?? 30.35,
    code_field_raw: partial.code_field_raw ?? "C-3",
    code_domain_map_applied: partial.code_domain_map_applied ?? false,
    layer_where: partial.layer_where ?? "1=1",
    object_id: partial.object_id ?? "1",
  };
}

describe("CP1-F1 roster geo_id", () => {
  it("uses roster geoid 4823044 for elgin-tx (not invented 4823042)", () => {
    const e = resolveZoningStagingCity("elgin-tx");
    expect(e.cityGeoId).toBe("4823044");
    expect(e.cityGeoId).not.toBe("4823042");
  });

  it("uses roster geoid 4868456 for smithville-tx", () => {
    expect(resolveZoningStagingCity("smithville-tx").cityGeoId).toBe("4868456");
  });

  it("fails closed on unknown cityKey", () => {
    expect(() => resolveZoningStagingCity("not-a-city")).toThrow(
      /missing from ZONING_STAGING_REGISTRY/,
    );
  });
});

describe("district code collision across cities", () => {
  it("refuses county-only drain without allowMultiCity (CP2-F1)", () => {
    expect(() =>
      drainZoningStagingRows(
        [
          toDbRow({
            staging_row_id: "elgin-tx:1",
            city_key: "elgin-tx",
            district_code: "C-3",
          }),
          toDbRow({
            staging_row_id: "smithville-tx:1",
            city_key: "smithville-tx",
            city_geo_id: "4868456",
            city_name: "Smithville",
            district_code: "C-3",
            geometry_grain: "district-polygon",
          }),
        ],
        { countyFips: "48021" },
      ),
    ).toThrow(/without cityKey mixes cities/);
  });

  it("allowMultiCity opt-in returns mixed cities but keeps cityKey on each row", () => {
    const drained = drainZoningStagingRows(
      [
        toDbRow({
          staging_row_id: "elgin-tx:1",
          city_key: "elgin-tx",
          district_code: "C-3",
        }),
        toDbRow({
          staging_row_id: "smithville-tx:1",
          city_key: "smithville-tx",
          city_geo_id: "4868456",
          city_name: "Smithville",
          district_code: "C-3",
          geometry_grain: "district-polygon",
        }),
      ],
      { countyFips: "48021", allowMultiCity: true },
    );
    expect(drained.rows).toHaveLength(2);
    expect(new Set(drained.rows.map((r) => r.cityKey))).toEqual(
      new Set(["elgin-tx", "smithville-tx"]),
    );
  });

  it("same districtCode C-3 yields distinct stagingRowIds; drain filters by cityKey", () => {
    const elgin = resolveZoningStagingCity("elgin-tx");
    const smith = resolveZoningStagingCity("smithville-tx");

    const elginRow = normalizeZoningFeature(
      {
        attributes: elginAttrs({ OBJECTID: 10, Zone_Code: "C-3", Zoning: "Commercial" }),
        geometry: elginSquare,
      },
      elgin,
    );
    const smithRow = normalizeZoningFeature(
      {
        attributes: { OBJECTID: 10, ZONING: "C-3" },
        geometry: elginSquare,
      },
      smith,
    );

    expect(elginRow?.districtCode).toBe("C-3");
    expect(smithRow?.districtCode).toBe("C-3");
    expect(elginRow?.stagingRowId).toBe("elgin-tx:10");
    expect(smithRow?.stagingRowId).toBe("smithville-tx:10");
    expect(elginRow?.stagingRowId).not.toBe(smithRow?.stagingRowId);

    const drained = drainZoningStagingRows(
      [
        toDbRow({
          staging_row_id: elginRow!.stagingRowId,
          city_key: "elgin-tx",
          district_code: "C-3",
          object_id: "10",
        }),
        toDbRow({
          staging_row_id: smithRow!.stagingRowId,
          city_key: "smithville-tx",
          city_geo_id: "4868456",
          city_name: "Smithville",
          district_code: "C-3",
          geometry_grain: "district-polygon",
          object_id: "10",
        }),
      ],
      { cityKey: "elgin-tx" },
    );
    expect(drained.primaryKey).toBe("cityKey");
    expect(drained.rows).toHaveLength(1);
    expect(drained.rows[0]?.cityKey).toBe("elgin-tx");
  });

  it("buildStagingRowId never uses districtCode alone", () => {
    expect(buildStagingRowId("elgin-tx", 7)).toBe("elgin-tx:7");
    expect(() => buildStagingRowId("", "1")).toThrow(ZoningStagingContractError);
  });
});

describe("polygon wrong CRS", () => {
  it("State Plane feet as degrees fail closed", () => {
    expect(() =>
      assertTexasWgs84Bbox(
        {
          westLng: 3295400.9,
          southLat: 9975141.2,
          eastLng: 3312286.0,
          northLat: 9991673.3,
        },
        "smithville-state-plane",
      ),
    ).toThrow(ZoningProjectionError);

    const elgin = resolveZoningStagingCity("elgin-tx");
    expect(() =>
      normalizeZoningFeature(
        {
          attributes: elginAttrs(),
          geometry: {
            rings: [
              [
                [3295400.9, 9975141.2],
                [3295500.9, 9975141.2],
                [3295500.9, 9975241.2],
                [3295400.9, 9975241.2],
                [3295400.9, 9975141.2],
              ],
            ],
          },
        },
        elgin,
      ),
    ).toThrow(/Refusing to stage|WGS84/);
  });
});

describe("multi-county city identity (CP1-F5)", () => {
  it("stages under cityKey even when parentCountyFips differs from geometry county narrative", () => {
    const elgin = {
      ...ZONING_STAGING_REGISTRY["elgin-tx"],
      // Synthetic: registry says Travis primary, geometry still Bastrop degrees.
      parentCountyFips: "48453",
    };
    const row = normalizeZoningFeature(
      {
        attributes: elginAttrs({ OBJECTID: 99 }),
        geometry: elginSquare, // Bastrop-area bbox
      },
      elgin,
    );
    expect(row?.cityKey).toBe("elgin-tx");
    expect(row?.parentCountyFips).toBe("48453");
    expect(row?.stagingRowId).toBe("elgin-tx:99");
    expect(row?.westLng).toBeLessThan(-97);

    const drained = drainZoningStagingRows(
      [
        toDbRow({
          staging_row_id: row!.stagingRowId,
          city_key: "elgin-tx",
          parent_county_fips: "48453",
          district_code: row!.districtCode,
          object_id: "99",
          west_lng: row!.westLng,
          south_lat: row!.southLat,
          east_lng: row!.eastLng,
          north_lat: row!.northLat,
        }),
      ],
      { cityKey: "elgin-tx" },
    );
    expect(drained.primaryKey).toBe("cityKey");
    expect(drained.rows[0]?.parentCountyFips).toBe("48453");
  });
});

describe("overlay mistaken for base (CP1-F2)", () => {
  it("drain refuses layer_role=overlay", () => {
    const result = drainZoningStagingRows(
      [
        toDbRow({
          staging_row_id: "elgin-tx:overlay-1",
          city_key: "elgin-tx",
          district_code: "H",
          layer_role: "overlay",
          is_overlay: true,
          is_base_district: false,
          object_id: "overlay-1",
        }),
      ],
      { cityKey: "elgin-tx", baseOnly: true },
    );
    expect(result.rows).toHaveLength(0);
    expect(result.refused[0]?.reason).toMatch(/overlay/);
  });

  it("drain refuses layer_role=unknown when baseOnly=true", () => {
    const result = drainZoningStagingRows(
      [
        toDbRow({
          staging_row_id: "elgin-tx:unk-1",
          city_key: "elgin-tx",
          district_code: "X",
          layer_role: "unknown",
          object_id: "unk-1",
        }),
      ],
      { cityKey: "elgin-tx", baseOnly: true },
    );
    expect(result.rows).toHaveLength(0);
    expect(result.refused[0]?.reason).toMatch(/unknown/);
  });
});

describe("silent tier fallback (CP1-F4)", () => {
  it("assertSourceTierSatisfied rejects empty / null", () => {
    expect(() => assertSourceTierSatisfied([], "t")).toThrow(/non-empty/);
    expect(() => assertSourceTierSatisfied(null, "t")).toThrow(/non-empty/);
    expect(() => assertSourceTierSatisfied([""], "t")).toThrow(/non-empty/);
  });

  it("normalize rejects empty sourceTierSatisfied override", () => {
    const elgin = resolveZoningStagingCity("elgin-tx");
    expect(() =>
      normalizeZoningFeature(
        { attributes: elginAttrs(), geometry: elginSquare },
        elgin,
        { sourceTierSatisfied: [] },
      ),
    ).toThrow(/sourceTierSatisfied/);
  });
});

describe("passthrough harvest completeness", () => {
  it("retains Elgin-shaped attrs verbatim including Zone_Code and PROP_ID", () => {
    const elgin = resolveZoningStagingCity("elgin-tx");
    const attrs = elginAttrs({ Zone_Code: "A", Zoning: "Multiple Family" });
    const row = normalizeZoningFeature(
      { attributes: attrs, geometry: elginSquare },
      elgin,
    );
    expect(row?.districtCode).toBe("R-4"); // A → R-4
    expect(row?.codeDomainMapApplied).toBe(true);
    expect(row?.codeFieldRaw).toBe("A");
    expect(row?.geometryGrain).toBe("parcel-joined");
    expect(row?.passthroughAttributes.PROP_ID).toBe("R100");
    expect(row?.passthroughAttributes.Zone_Code).toBe("A");
    expect(row?.passthroughAttributes.CITY_LIMIT).toBe("ELGIN");
    expect(Object.keys(row!.passthroughAttributes).length).toBe(
      Object.keys(attrs).length,
    );
  });

  it("retains Smithville ZONING in passthrough; geometryGrain=district-polygon", () => {
    const smith = resolveZoningStagingCity("smithville-tx");
    const row = normalizeZoningFeature(
      {
        attributes: { OBJECTID: 1, ZONING: "C-3" },
        geometry: elginSquare,
      },
      smith,
    );
    expect(row?.districtCode).toBe("C-3");
    expect(row?.geometryGrain).toBe("district-polygon");
    expect(row?.passthroughAttributes.ZONING).toBe("C-3");
    expect(row?.passthroughAttributes.OBJECTID).toBe(1);
    expect(row?.codeDomainMapApplied).toBe(false);
  });
});
