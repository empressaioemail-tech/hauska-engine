import { describe, expect, it, vi } from "vitest";

import {
  ArcGisParcelGeometryResolver,
  TxgioDatabaseParcelGeometryResolver,
} from "../parcel-geometry-resolver.js";

describe("TxgioDatabaseParcelGeometryResolver", () => {
  it("resolves 48021:27303 without a bbox override", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "Polygon",
        coordinates: [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
      },
      westLng: -97.3,
      southLat: 30.1,
      eastLng: -97.29,
      northLat: 30.11,
      sourceVintage: "stratmap25-landparcels_48021_2025",
    }));
    const resolver = new TxgioDatabaseParcelGeometryResolver({
      databaseUrl: "postgres://not-used-by-test",
      query,
    });

    await expect(resolver.resolve("48021:27303")).resolves.toEqual({
      bbox: { westLng: -97.3, southLat: 30.1, eastLng: -97.29, northLat: 30.11 },
      sourceRef: "txgio-parcel:48021:27303:stratmap25-landparcels_48021_2025",
    });
    expect(query).toHaveBeenCalledWith("48021", "27303");
  });

  it("declines malformed parcel identities", async () => {
    const resolver = new TxgioDatabaseParcelGeometryResolver({
      databaseUrl: "postgres://not-used-by-test",
      query: async () => null,
    });
    await expect(resolver.resolve("not-a-node-id")).resolves.toBeNull();
  });

  it("resolves a configured county ArcGIS parcel by node id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      features: [{
        geometry: {
          type: "Polygon",
          coordinates: [[[-97.31, 30.1], [-97.3, 30.1], [-97.3, 30.11], [-97.31, 30.1]]],
        },
      }],
    }), { status: 200 }));
    const resolver = new ArcGisParcelGeometryResolver([{
      countyFips: "48021",
      queryUrl: "https://example.test/FeatureServer/0",
      propIdField: "prop_id",
    }], fetchImpl);

    await expect(resolver.resolve("48021:27303")).resolves.toEqual({
      bbox: { westLng: -97.31, southLat: 30.1, eastLng: -97.3, northLat: 30.11 },
      sourceRef: "arcgis-parcel:48021:27303",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("prop_id+%3D+%2727303%27");
  });
});
