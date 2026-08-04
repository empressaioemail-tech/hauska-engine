import { describe, it, expect } from "vitest";

import {
  loadJurisdictionRegistryRow,
  isJurisdictionOnboarded,
  BASTROP_REGISTRY_ROW,
  BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  ELGIN_REGISTRY_ROW,
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
