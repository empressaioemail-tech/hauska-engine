/**
 * Overpass bbox fetch unit tests (mock fetch — no live network in CI).
 */

import { describe, expect, it } from "vitest";

import {
  BASTROP_COUNTY_BBOX,
  fetchOverpassRoadsInBbox,
  parseBastropBboxFromEnv,
} from "../fetch-overpass-bbox.js";

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

  it("parseBastropBboxFromEnv defaults to county bbox", () => {
    const bbox = parseBastropBboxFromEnv({});
    expect(bbox.south).toBe(BASTROP_COUNTY_BBOX.south);
  });
});
