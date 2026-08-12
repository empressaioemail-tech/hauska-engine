import { describe, expect, it } from "vitest";

import { recurseArcGisRestFoldersFromFixtures } from "../folder-recurse.js";

describe("folder recursion — nested folders", () => {
  it("visits nested folder and does not double ArcGIS folder-prefixed service names", () => {
    const root = "https://gis.example.gov/arcgis/rest/services";
    // Real ArcGIS shape (Deer Park): services inside folder WGS84 are named
    // "WGS84/Zoning_WGS84", not bare "Zoning_WGS84".
    const fixtureMap = {
      "/": {
        folders: ["Hosted", "Utilities", "WGS84"],
        services: [],
      },
      WGS84: {
        folders: [],
        services: [{ name: "WGS84/Zoning_WGS84", type: "MapServer" }],
      },
      "WGS84/Zoning_WGS84": {
        layers: [{ id: 0, name: "Zoning Districts" }],
      },
    };

    const result = recurseArcGisRestFoldersFromFixtures(root, fixtureMap, 4);

    expect(result.pathsAttempted.some((p) => p.includes("WGS84"))).toBe(true);
    expect(result.pathsAttempted.some((p) => p.includes("Zoning_WGS84"))).toBe(true);
    expect(result.pathsAttempted.some((p) => p.includes("WGS84/WGS84/"))).toBe(false);
    expect(result.serviceLayerRefs.length).toBeGreaterThan(0);
    expect(result.serviceLayerRefs[0]!.layerUrl).toBe(
      "https://gis.example.gov/arcgis/rest/services/WGS84/Zoning_WGS84/MapServer/0",
    );
  });
});
