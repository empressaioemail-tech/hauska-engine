/**
 * Overpass bbox fetch unit tests (mock fetch — no live network in CI).
 */

import { describe, expect, it } from "vitest";

import {
  BASTROP_CITY_BBOX,
  BASTROP_COUNTY_BBOX,
  ELGIN_CITY_BBOX,
  fetchBastropRoadsForIngest,
  fetchOverpassRoadsInBbox,
  fetchOverpassRoadsTiled,
  parseBastropBboxFromEnv,
  resolveBastropRoadIngestBbox,
  resolveBastropRoadIngestScope,
} from "../fetch-overpass-bbox.js";

describe("ELGIN_CITY_BBOX (AGOL Elgin_Zoning FeatureServer/0 extent, 2026-08-04)", () => {
  it("has south < north and west < east", () => {
    expect(ELGIN_CITY_BBOX.south).toBeLessThan(ELGIN_CITY_BBOX.north);
    expect(ELGIN_CITY_BBOX.west).toBeLessThan(ELGIN_CITY_BBOX.east);
  });

  it("matches planner-derived AGOL extent verbatim", () => {
    expect(ELGIN_CITY_BBOX).toEqual({
      south: 30.313790730771967,
      west: -97.410938698399292,
      north: 30.369229436331114,
      east: -97.355026917826052,
    });
  });
});

describe("fetchOverpassRoadsInBbox", () => {
  it("parses way elements from Overpass JSON", async () => {
    const mockBody = {
      elements: [
        {
          type: "way",
          id: 42,
          tags: { highway: "residential", name: "Test St" },
          geometry: [
            { lat: 30.11, lon: -97.32 },
            { lat: 30.1105, lon: -97.3195 },
          ],
        },
        { type: "node", id: 1 },
      ],
    };
    const fetchImpl = async () =>
      ({
        ok: true,
        json: async () => mockBody,
      }) as Response;

    const result = await fetchOverpassRoadsInBbox(BASTROP_COUNTY_BBOX, fetchImpl);
    expect(result.elements.length).toBe(1);
    expect(result.elements[0]!.id).toBe(42);
    expect(result.query).toContain("way[\"highway\"]");
  });
});

describe("resolveBastropRoadIngestBbox (R4.2)", () => {
  it("defaults to full city bbox for city-cohort road coverage", () => {
    const { bbox, scope } = resolveBastropRoadIngestBbox({});
    expect(scope).toBe("city");
    expect(bbox.south).toBe(BASTROP_CITY_BBOX.south);
    expect(bbox.north).toBe(BASTROP_CITY_BBOX.north);
  });

  it("parseBastropBboxFromEnv follows city default", () => {
    const bbox = parseBastropBboxFromEnv({});
    expect(bbox.south).toBe(BASTROP_CITY_BBOX.south);
  });

  it("BASTROP_ROAD_BBOX override wins", () => {
    const { bbox, scope } = resolveBastropRoadIngestBbox({
      BASTROP_ROAD_BBOX: "1,2,3,4",
    });
    expect(scope).toBe("custom");
    expect(bbox).toEqual({ south: 1, west: 2, north: 3, east: 4 });
  });

  it("resolveBastropRoadIngestScope honors county-tiled", () => {
    expect(resolveBastropRoadIngestScope({ BASTROP_ROAD_INGEST_SCOPE: "county-tiled" })).toBe(
      "county-tiled",
    );
    expect(resolveBastropRoadIngestScope({ BASTROP_ROAD_INGEST_SCOPE: "county" })).toBe("county");
  });
});

describe("fetchOverpassRoadsTiled", () => {
  it("dedupes OSM ways across tiles", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          elements: [
            {
              type: "way",
              id: calls === 1 ? 100 : 200,
              tags: { highway: "residential" },
              geometry: [
                { lat: 30.11, lon: -97.32 },
                { lat: 30.1105, lon: -97.3195 },
              ],
            },
            ...(calls === 2
              ? [
                  {
                    type: "way",
                    id: 100,
                    tags: { highway: "residential" },
                    geometry: [
                      { lat: 30.11, lon: -97.32 },
                      { lat: 30.1105, lon: -97.3195 },
                    ],
                  },
                ]
              : []),
          ],
        }),
      } as Response;
    };

    const result = await fetchOverpassRoadsTiled(BASTROP_COUNTY_BBOX, {
      tilesX: 2,
      tilesY: 2,
      fetchImpl,
      pauseMs: 0,
    });
    expect(calls).toBe(4);
    expect(result.elements.length).toBe(2);
    expect(result.tilesFetched).toBe(4);
  });
});

describe("fetchBastropRoadsForIngest", () => {
  it("uses city bbox when scope unset", async () => {
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain(String(BASTROP_CITY_BBOX.south));
      return {
        ok: true,
        json: async () => ({ elements: [] }),
      } as Response;
    };
    const result = await fetchBastropRoadsForIngest({}, fetchImpl);
    expect(result.scope).toBe("city");
  });
});
