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
      ring: [[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]],
    });
    expect(query).toHaveBeenCalledWith("48021", "27303");
  });

  it("omits ring (rather than fabricating one) when the geometry column has no Polygon/MultiPolygon", async () => {
    const query = vi.fn(async () => ({
      geometry: null,
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
  });

  it("declines malformed parcel identities", async () => {
    const resolver = new TxgioDatabaseParcelGeometryResolver({
      databaseUrl: "postgres://not-used-by-test",
      query: async () => null,
    });
    await expect(resolver.resolve("not-a-node-id")).resolves.toBeNull();
  });

  it("Polygon single ring (unchanged behavior): resolves the ring normally", async () => {
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toEqual([[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]);
    expect(resolved?.ringDeclineReason).toBeUndefined();
  });

  it("Polygon with holes: declines with MULTI_PART_GEOMETRY_UNSUPPORTED rather than truncating to the exterior ring", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "Polygon",
        coordinates: [
          [[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.11], [-97.3, 30.1]],
          [[-97.298, 30.102], [-97.296, 30.102], [-97.296, 30.104], [-97.298, 30.104], [-97.298, 30.102]],
        ],
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
    expect(resolved?.ringDeclineReason).toBe("MULTI_PART_GEOMETRY_UNSUPPORTED");
  });

  it("MultiPolygon multi-part: declines with MULTI_PART_GEOMETRY_UNSUPPORTED rather than serving only the first part", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
          [[[-97.28, 30.1], [-97.27, 30.1], [-97.27, 30.11], [-97.28, 30.1]]],
        ],
      },
      westLng: -97.3,
      southLat: 30.1,
      eastLng: -97.27,
      northLat: 30.11,
      sourceVintage: "stratmap25-landparcels_48021_2025",
    }));
    const resolver = new TxgioDatabaseParcelGeometryResolver({
      databaseUrl: "postgres://not-used-by-test",
      query,
    });
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
    expect(resolved?.ringDeclineReason).toBe("MULTI_PART_GEOMETRY_UNSUPPORTED");
  });

  it("MultiPolygon single-part, no holes: reduces to the ring (ruled safely reducible, not a truncation)", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
        ],
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toEqual([[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]);
    expect(resolved?.ringDeclineReason).toBeUndefined();
  });

  it("MultiPolygon single-part WITH holes: declines (single part alone does not make it reducible)", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.11], [-97.3, 30.1]],
            [[-97.298, 30.102], [-97.296, 30.102], [-97.296, 30.104], [-97.298, 30.104], [-97.298, 30.102]],
          ],
        ],
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
    expect(resolved?.ringDeclineReason).toBe("MULTI_PART_GEOMETRY_UNSUPPORTED");
  });

  it("non-polygon geometry type (existing behavior): omits ring with no decline reason (genuinely absent, not a multi-part decline)", async () => {
    const query = vi.fn(async () => ({
      geometry: {
        type: "Point",
        coordinates: [-97.3, 30.1],
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
    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
    expect(resolved?.ringDeclineReason).toBeUndefined();
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
      ring: [[-97.31, 30.1], [-97.3, 30.1], [-97.3, 30.11], [-97.31, 30.1]],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("prop_id+%3D+%2727303%27");
  });

  it("ArcGIS path: MultiPolygon multi-part declines with MULTI_PART_GEOMETRY_UNSUPPORTED (bbox still resolves)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      features: [{
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[-97.31, 30.1], [-97.3, 30.1], [-97.3, 30.11], [-97.31, 30.1]]],
            [[[-97.29, 30.1], [-97.28, 30.1], [-97.28, 30.11], [-97.29, 30.1]]],
          ],
        },
      }],
    }), { status: 200 }));
    const resolver = new ArcGisParcelGeometryResolver([{
      countyFips: "48021",
      queryUrl: "https://example.test/FeatureServer/0",
      propIdField: "prop_id",
    }], fetchImpl);

    const resolved = await resolver.resolve("48021:27303");
    expect(resolved?.ring).toBeUndefined();
    expect(resolved?.ringDeclineReason).toBe("MULTI_PART_GEOMETRY_UNSUPPORTED");
    // bbox is still derived from the full multi-part geometry envelope —
    // only the ring (used for boundary/setback work) is declined.
    expect(resolved?.bbox).toEqual({ westLng: -97.31, southLat: 30.1, eastLng: -97.28, northLat: 30.11 });
  });
});
