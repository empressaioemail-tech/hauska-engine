/**
 * County-mapped hydrography adapter — registry resolution + fetch/parse
 * contract with a mocked ArcGIS upstream (no live network in unit tests).
 */
import { describe, expect, it, vi } from "vitest";

import {
  BASTROP_HYDROGRAPHY_SOURCE,
  COUNTY_HYDROGRAPHY_SOURCES,
  fetchCountyHydrography,
  resolveCountyHydrographySource,
} from "../county-hydrography.js";

// Gold-parcel viewport bbox in Bastrop County.
const bastropBbox = {
  westLng: -97.34,
  southLat: 30.09,
  eastLng: -97.3,
  northLat: 30.13,
};

// Moab, UT — no county hydrography source configured.
const moabBbox = {
  westLng: -109.552,
  southLat: 38.568,
  eastLng: -109.548,
  northLat: 38.572,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** ArcGIS query JSON shaped like the live Creeks_Streams layer response. */
function creeksResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    features: [
      {
        attributes: {
          GNIS_Name: "Piney Creek",
          FEATURE_TY: "STREAM/RIVER",
          ReachCode: "12090301000319",
        },
        geometry: {
          paths: [
            [
              [-97.3298, 30.1269],
              [-97.33, 30.1265],
            ],
          ],
        },
      },
      {
        // Unnamed feature: GNIS_Name is a single space on the live layer.
        attributes: { GNIS_Name: " ", FEATURE_TY: "ARTIFICIAL PATH" },
        geometry: {
          // Two paths -> MultiLineString.
          paths: [
            [
              [-97.3016, 30.1167],
              [-97.302, 30.1168],
            ],
            [
              [-97.303, 30.117],
              [-97.304, 30.1171],
            ],
          ],
        },
      },
    ],
    exceededTransferLimit: false,
    ...overrides,
  };
}

describe("resolveCountyHydrographySource (registry)", () => {
  it("resolves the Bastrop source for a Bastrop bbox", () => {
    const source = resolveCountyHydrographySource(bastropBbox);
    expect(source).toBe(BASTROP_HYDROGRAPHY_SOURCE);
    expect(source!.sourceKey).toBe("bastrop-county:Creeks_Streams");
  });

  it("returns null for a county with no configured source (Moab)", () => {
    expect(resolveCountyHydrographySource(moabBbox)).toBeNull();
  });

  it("is registry-driven: a custom registry entry resolves county-agnostically", () => {
    const custom = {
      ...BASTROP_HYDROGRAPHY_SOURCE,
      countyKey: "grand-county-ut",
      sourceKey: "grand-county:Streams",
      footprint: { westLng: -110, southLat: 38, eastLng: -109, northLat: 39 },
    };
    expect(resolveCountyHydrographySource(moabBbox, [custom])).toBe(custom);
  });
});

describe("fetchCountyHydrography", () => {
  it("queries the county layer with WGS84 in/out and NO pagination params", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      calledUrls.push(String(input));
      return jsonResponse(creeksResponse());
    });
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      bastropBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(calledUrls[0]!);
    expect(calledUrl.toString()).toContain(
      "maps.co.bastrop.tx.us/server/rest/services/Hydrography/Creeks_Streams/MapServer/0/query",
    );
    expect(calledUrl.searchParams.get("inSR")).toBe("4326");
    expect(calledUrl.searchParams.get("outSR")).toBe("4326");
    // The live layer 400s on pagination params (supportsPagination: false).
    expect(calledUrl.searchParams.has("resultRecordCount")).toBe(false);
    expect(calledUrl.searchParams.has("resultOffset")).toBe(false);

    expect(result.featureCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.sourceUrl).toBe(BASTROP_HYDROGRAPHY_SOURCE.serviceUrl);
  });

  it("emits GeoJSON LineString/MultiLineString with name attribute cleaned", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(creeksResponse()));
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      bastropBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const [named, unnamed] = result.features;
    expect(named!.geometry.type).toBe("LineString");
    expect(named!.properties.name).toBe("Piney Creek");
    expect(named!.properties.featureType).toBe("STREAM/RIVER");
    // Whitespace-only GNIS_Name -> null, never a blank string label.
    expect(unnamed!.geometry.type).toBe("MultiLineString");
    expect(unnamed!.properties.name).toBeNull();
  });

  it("emits Polygon for ring geometry (waterbody sources)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        features: [
          {
            attributes: { GNIS_Name: "Lake Bastrop" },
            geometry: {
              rings: [
                [
                  [-97.3, 30.15],
                  [-97.29, 30.15],
                  [-97.29, 30.16],
                  [-97.3, 30.15],
                ],
              ],
            },
          },
        ],
      }),
    );
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      bastropBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.features[0]!.geometry.type).toBe("Polygon");
    expect(result.features[0]!.properties.name).toBe("Lake Bastrop");
  });

  it("reports truncation honestly on exceededTransferLimit", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(creeksResponse({ exceededTransferLimit: true })),
    );
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      bastropBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.truncated).toBe(true);
  });

  it("caps features client-side (maxFeatures) and flags truncation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(creeksResponse()));
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      bastropBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch, maxFeatures: 1 },
    );
    expect(result.featureCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("skips the network entirely for an out-of-footprint bbox", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchCountyHydrography(
      BASTROP_HYDROGRAPHY_SOURCE,
      moabBbox,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.features).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("throws on ArcGIS error body (caller degrades honestly)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Pagination is not supported." } }),
    );
    await expect(
      fetchCountyHydrography(BASTROP_HYDROGRAPHY_SOURCE, bastropBbox, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/ArcGIS error/);
  });
});

describe("registry hygiene", () => {
  it("every registered source carries the provenance-critical fields", () => {
    for (const source of COUNTY_HYDROGRAPHY_SOURCES) {
      expect(source.serviceUrl).toMatch(/^https:\/\//);
      expect(source.sourceKey).toContain(":");
      expect(source.layerName.length).toBeGreaterThan(0);
      expect(source.footprint.westLng).toBeLessThan(source.footprint.eastLng);
      expect(source.footprint.southLat).toBeLessThan(source.footprint.northLat);
    }
  });
});
