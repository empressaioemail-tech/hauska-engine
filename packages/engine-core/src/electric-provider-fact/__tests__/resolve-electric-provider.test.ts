/**
 * item 21 (electric) -- mocked HIFLD upstream (no live network in unit
 * tests). The "3 overlapping candidates" fixture below is not invented: it
 * is the real live response captured 2026-09-07 querying
 * https://services2.arcgis.com/LYMgRMwHfrWWEg3s/arcgis/rest/services/HIFLD_Electric_Retail_Service_Territories/FeatureServer/0
 * at both real Bastrop test parcels' centroids -- a genuine HIFLD
 * territory-overlap artifact, not a test author's invention.
 */
import { describe, expect, it } from "vitest";

import { resolveElectricProviderFact } from "../resolve-electric-provider.js";

const BASTROP_52726_CENTROID = { latitude: 30.11148235687972, longitude: -97.31856839686304 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Real HIFLD response, captured live 2026-09-07 at the Bastrop centroid above. */
const REAL_BASTROP_HIFLD_RESPONSE = {
  features: [
    { attributes: { NAME: "CITY OF BASTROP - (TX)", TYPE: "MUNICIPAL", NAICS_DESC: "ELECTRIC POWER GENERATION, TRANSMISSION AND DISTRIBUTION", WEBSITE: "NOT AVAILABLE", SOURCE: "FERC 714, EIA 861, Urban Areas - Cartographic Boundary Shapefiles - U.S. Census" } },
    { attributes: { NAME: "BLUEBONNET ELECTRIC COOP, INC", TYPE: "COOPERATIVE", NAICS_DESC: "ELECTRIC POWER GENERATION, TRANSMISSION AND DISTRIBUTION", WEBSITE: "http://www.bluebonnetelectric.coop/", SOURCE: "EIA 861, TIGER/Line Shapefiles - U.S. Census" } },
    { attributes: { NAME: "FAYETTE ELECTRIC COOP, INC", TYPE: "COOPERATIVE", NAICS_DESC: "ELECTRIC POWER GENERATION, TRANSMISSION AND DISTRIBUTION", WEBSITE: "http://www.fayette.coop/", SOURCE: "EIA 861, TIGER/Line Shapefiles - U.S. Census" } },
  ],
};

describe("resolveElectricProviderFact", () => {
  it("real Bastrop replay: present with a disclosed multi-candidate ambiguity, never a silently-picked single name", async () => {
    const fetchImpl = (async () => jsonResponse(REAL_BASTROP_HIFLD_RESPONSE)) as unknown as typeof fetch;
    const result = await resolveElectricProviderFact(BASTROP_52726_CENTROID, fetchImpl);

    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.facts.candidates).toHaveLength(3);
      expect(result.facts.ambiguous).toBe(true);
      expect(result.facts.candidates.map((c) => c.name)).toContain("CITY OF BASTROP - (TX)");
      expect(result.facts.candidates.map((c) => c.name)).toContain("BLUEBONNET ELECTRIC COOP, INC");
    }
  });

  it("present, unambiguous, when exactly one HIFLD territory intersects", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ features: [{ attributes: { NAME: "PEDERNALES ELECTRIC COOPERATIVE", TYPE: "COOPERATIVE" } }] })) as unknown as typeof fetch;
    const result = await resolveElectricProviderFact({ latitude: 30.5, longitude: -98.2 }, fetchImpl);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.facts.candidates).toHaveLength(1);
      expect(result.facts.ambiguous).toBe(false);
    }
  });

  it("honest absence, never a fabricated provider name, when the staged HIFLD data does not reach this parcel", async () => {
    const fetchImpl = (async () => jsonResponse({ features: [] })) as unknown as typeof fetch;
    const result = await resolveElectricProviderFact({ latitude: 0, longitude: 0 }, fetchImpl);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason).toContain("does not reach this parcel");
    }
  });

  it("honest absence when the upstream lookup fails outright", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await resolveElectricProviderFact(BASTROP_52726_CENTROID, fetchImpl);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason).toContain("network unreachable");
    }
  });

  it("filters out features with no NAME rather than reporting a blank provider", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ features: [{ attributes: { NAME: "" } }, { attributes: { NAME: "REAL PROVIDER CO" } }] })) as unknown as typeof fetch;
    const result = await resolveElectricProviderFact(BASTROP_52726_CENTROID, fetchImpl);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.facts.candidates).toHaveLength(1);
      expect(result.facts.candidates[0]!.name).toBe("REAL PROVIDER CO");
    }
  });
});
