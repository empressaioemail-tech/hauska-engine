import { describe, it, expect } from "vitest";

import {
  loadJurisdictionRegistryRow,
  loadJurisdictionRegistryRowById,
  loadJurisdictionRegistryRowsForFips,
  isJurisdictionOnboarded,
  BASTROP_REGISTRY_ROW,
  BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  ELGIN_REGISTRY_ROW,
  BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  CALDWELL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  GUADALUPE_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  MCLENNAN_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW,
} from "../jurisdiction-registry.js";
import { BASTROP_BCAD_PARCELS_URL } from "../../boundary-primitive/lot-line-scrub.js";

// A4 (OPS-1, R-FND-2): the engine READS a frozen registry row instead of
// hardcoding per-county adapters. The loader returns Bastrop's frozen Rail C
// row; an un-onboarded county returns null (honest-absence, never fabricated).
describe("jurisdiction registry loader (registry-as-engine-input)", () => {
  it("loads Bastrop's frozen Rail C row by FIPS", () => {
    const row = loadJurisdictionRegistryRow("48021");
    expect(row).not.toBeNull();
    expect(row).toBe(BASTROP_REGISTRY_ROW);
    expect(row?.railC.geometrySource).toBe("stratmap_bulk_zip");
    expect(row?.railPerParcel?.featureServerLayerUrl).toContain("Parcels_One_Click");
    // prop_id bad-rate is low (0.0022) → prop_id join is safe for Bastrop.
    expect(row?.join.joinKey).toBe("prop_id");
    // The owner-match firewall is ALWAYS required (anti-fabrication, R9).
    expect(row?.join.ownerMatchRequired).toBe(true);
    // The row carries provenance + a freeze stamp (prep-time frozen artifact).
    expect(row?.provenance.frozenAt).toBeTruthy();
  });

  it("returns null for an un-onboarded county (honest-absence, never fabricated)", () => {
    // Donley (48129) — no StratMap zip, not yet onboarded.
    expect(loadJurisdictionRegistryRow("48129")).toBeNull();
    expect(isJurisdictionOnboarded("48129")).toBe(false);
    expect(isJurisdictionOnboarded("48021")).toBe(true);
  });
});

// fix/unzoned-cert-cadastral-url-param: every 48021 row explicitly carries
// the Bastrop cadastral query URL, so cert-grade-core.ts's resolution is
// explicit rather than an implicit fetchBcadParcelRings default.
describe("railC.cadastralQueryUrl (fix/unzoned-cert-cadastral-url-param)", () => {
  it("is populated with BASTROP_BCAD_PARCELS_URL on all three 48021 rows (Bastrop, county-unincorporated, Elgin)", () => {
    expect(BASTROP_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(BASTROP_BCAD_PARCELS_URL);
    expect(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      BASTROP_BCAD_PARCELS_URL,
    );
    expect(ELGIN_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(BASTROP_BCAD_PARCELS_URL);
  });
});

// Central TX county fan (2026-08-04): eight unincorporated-county rows,
// pattern-matched to BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW. Scope is
// CENTRAL TX counties only; a concurrent DFW-area planner session owns any
// DFW rows on this same registry file.
describe("central TX county fan registry rows (2026-08-04)", () => {
  const CENTRAL_TX_ROWS = [
    { row: BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Bell County (unincorporated)", fips: "48027" },
    { row: BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Bexar County (unincorporated)", fips: "48029" },
    { row: CALDWELL_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Caldwell County (unincorporated)", fips: "48055" },
    { row: COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Comal County (unincorporated)", fips: "48091" },
    { row: GUADALUPE_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Guadalupe County (unincorporated)", fips: "48187" },
    { row: HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Hays County (unincorporated)", fips: "48209" },
    { row: MCLENNAN_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "McLennan County (unincorporated)", fips: "48309" },
    { row: WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW, rowId: "Williamson County (unincorporated)", fips: "48491" },
  ];

  it.each(CENTRAL_TX_ROWS)(
    "loads $rowId by rowId and by fips list, status pre-flight-pending, unzoned, noFilter",
    ({ row, rowId, fips }) => {
      expect(row.rowId).toBe(rowId);
      expect(row.fips).toBe(fips);
      expect(row.status).toBe("pre-flight-pending");
      expect(row.zoningRegime).toBe("unzoned");
      expect(row.join.joinKey).toBe("prop_id");
      expect(row.join.ownerMatchRequired).toBe(true);

      // loadJurisdictionRegistryRowById resolves the exact row.
      expect(loadJurisdictionRegistryRowById(rowId)).toBe(row);

      // loadJurisdictionRegistryRowsForFips includes this row for its fips.
      const rowsForFips = loadJurisdictionRegistryRowsForFips(fips);
      expect(rowsForFips).toContain(row);

      // Every row (except Hays, asserted separately below) has a noFilter
      // parcelFilter mirroring Bastrop County's unzoned shape.
      if (row.railPerParcel) {
        expect(row.railPerParcel.parcelFilter).toEqual({ kind: "noFilter" });
      }
    },
  );

  it("all 8 central TX county rows are present in the registry, keyed distinctly from Bastrop/Elgin/DFW rows", () => {
    for (const { rowId } of CENTRAL_TX_ROWS) {
      expect(loadJurisdictionRegistryRowById(rowId)).not.toBeNull();
    }
  });

  it("Bastrop, Elgin, and DFW-area rows are untouched by the county fan (pinned count + spot fields)", () => {
    // Bastrop (48021) still resolves its three original rows unchanged.
    const bastropRows = loadJurisdictionRegistryRowsForFips("48021");
    expect(bastropRows).toHaveLength(3);
    expect(bastropRows).toContain(BASTROP_REGISTRY_ROW);
    expect(bastropRows).toContain(BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW);
    expect(bastropRows).toContain(ELGIN_REGISTRY_ROW);

    // Spot-check Bastrop's original active row is byte-identical on key fields.
    expect(loadJurisdictionRegistryRow("48021")).toBe(BASTROP_REGISTRY_ROW);
    expect(BASTROP_REGISTRY_ROW.railPerParcel?.featureServerLayerUrl).toContain(
      "Parcels_One_Click",
    );

    // No DFW-area fips (Dallas 48113, Tarrant 48439, Collin 48085, Denton
    // 48121) rows exist on this registry yet — this session's scope is
    // Central TX only; a concurrent DFW-area planner session owns those.
    for (const dfwFips of ["48113", "48439", "48085", "48121"]) {
      expect(loadJurisdictionRegistryRowsForFips(dfwFips)).toHaveLength(0);
    }
  });

  it("Hays County row has no cadastralQueryUrl and no railPerParcel (loud-fail, not a borrowed default)", () => {
    expect(HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBeUndefined();
    expect(HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW.railPerParcel).toBeUndefined();
    expect(HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW.flags).toContain(
      "CADASTRAL_QUERY_URL_NOT_FOUND",
    );
  });

  it("Travis County (48453) is absent from the registry — held on the geo_id/address crosswalk gap", () => {
    expect(loadJurisdictionRegistryRowsForFips("48453")).toHaveLength(0);
    expect(isJurisdictionOnboarded("48453")).toBe(false);
  });

  it("spot-checks each county's cadastralQueryUrl and railC provenance values against the recon/StratMap sources", () => {
    expect(BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://services7.arcgis.com/EHW2HuuyZNO7DZct/arcgis/rest/services/BellCADWebService/FeatureServer/0",
    );
    expect(BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.featureCount).toBe(167441);

    expect(BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0",
    );
    expect(BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW.railPerParcel?.propIdField).toBe("PropID");

    expect(CALDWELL_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/0",
    );

    expect(COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://services6.arcgis.com/eNPJk90aMrXNOKF8/arcgis/rest/services/Comal_County_Parcels/FeatureServer/40",
    );
    expect(COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW.flags).toContain(
      "CADASTRAL_LAYER_STALE_2021_SNAPSHOT",
    );

    expect(GUADALUPE_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://services9.arcgis.com/1l4hbpt78hjlsIcl/arcgis/rest/services/GuadalupeCADWebService/FeatureServer/0",
    );

    expect(MCLENNAN_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://services8.arcgis.com/5e4b1SY8bogTc3pH/arcgis/rest/services/McLennanCADWebService/FeatureServer/0",
    );

    expect(WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW.railC.cadastralQueryUrl).toBe(
      "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0",
    );
    expect(WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW.railPerParcel?.propIdField).toBe(
      "PropertyID",
    );
  });
});
