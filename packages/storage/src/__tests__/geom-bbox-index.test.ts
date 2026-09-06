/**
 * geom-bbox-index.ts unit tests — pure functions, no DB fake needed.
 */
import { describe, expect, it } from "vitest";

import {
  computeLngLatBbox,
  geomBboxRowFromInstance,
  geomBboxRowsFromInstances,
} from "../geom-bbox-index.js";

describe("computeLngLatBbox", () => {
  it("computes the bbox of a real multi-point line", () => {
    const box = computeLngLatBbox([
      [-97.7, 29.9],
      [-97.65, 29.95],
      [-97.72, 29.88],
    ]);
    expect(box).toEqual({
      westLng: -97.72,
      eastLng: -97.65,
      southLat: 29.88,
      northLat: 29.95,
    });
  });

  it("returns null for an empty array", () => {
    expect(computeLngLatBbox([])).toBeNull();
  });

  it("returns null for missing/undefined coordinates", () => {
    expect(computeLngLatBbox(undefined)).toBeNull();
    expect(computeLngLatBbox(null)).toBeNull();
  });

  it("skips malformed points but still computes from the valid ones", () => {
    const box = computeLngLatBbox([
      [-97.7, 29.9],
      // @ts-expect-error -- deliberately malformed input, mirrors real-world dirty data
      [null, undefined],
      [-97.6, 29.8],
    ]);
    expect(box).toEqual({
      westLng: -97.7,
      eastLng: -97.6,
      southLat: 29.8,
      northLat: 29.9,
    });
  });

  it("returns null when every point is malformed (falsifier: never fabricate a 0,0 box)", () => {
    // @ts-expect-error -- deliberately malformed input
    expect(computeLngLatBbox([[null, null], ["x", "y"]])).toBeNull();
  });

  it("handles a single-point degenerate bbox", () => {
    expect(computeLngLatBbox([[-97.5, 30.0]])).toEqual({
      westLng: -97.5,
      eastLng: -97.5,
      southLat: 30.0,
      northLat: 30.0,
    });
  });
});

describe("geomBboxRowFromInstance", () => {
  it("extracts a road-node row from a real centerline", () => {
    const row = geomBboxRowFromInstance({
      atomDid: "did:hauska:road-node:48055:road:1",
      entityType: "road-node",
      countyFips: "48055",
      centerline: {
        coordinates: [
          [-97.7, 29.9],
          [-97.6, 29.95],
        ],
      },
    });
    expect(row).toEqual({
      atomDid: "did:hauska:road-node:48055:road:1",
      entityType: "road-node",
      countyFips: "48055",
      westLng: -97.7,
      eastLng: -97.6,
      southLat: 29.9,
      northLat: 29.95,
    });
  });

  it("extracts a building-footprint row from the outer ring, deriving countyFips from parcelNodeId", () => {
    const row = geomBboxRowFromInstance({
      atomDid: "did:hauska:building-footprint:48021:28286",
      entityType: "building-footprint",
      parcelNodeId: "48021:28286",
      footprintGeometry: {
        coordinates: [
          [
            [-97.38, 30.1],
            [-97.37, 30.11],
            [-97.375, 30.105],
          ],
        ],
      },
    });
    expect(row).toEqual({
      atomDid: "did:hauska:building-footprint:48021:28286",
      entityType: "building-footprint",
      countyFips: "48021",
      westLng: -97.38,
      eastLng: -97.37,
      southLat: 30.1,
      northLat: 30.11,
    });
  });

  it("returns null for an unrelated entity type (falsifier: never emits a bbox row for zoning-fact etc.)", () => {
    expect(
      geomBboxRowFromInstance({
        atomDid: "did:hauska:zoning-fact:48021:28286",
        entityType: "zoning-fact",
      }),
    ).toBeNull();
  });

  it("returns null for a road-node with no centerline geometry", () => {
    expect(
      geomBboxRowFromInstance({
        atomDid: "did:hauska:road-node:48055:road:1",
        entityType: "road-node",
      }),
    ).toBeNull();
  });

  it("returns null for a building-footprint with no footprintGeometry (e.g. an honest-absence row)", () => {
    expect(
      geomBboxRowFromInstance({
        atomDid: "did:hauska:building-footprint:48021:28286",
        entityType: "building-footprint",
        parcelNodeId: "48021:28286",
      }),
    ).toBeNull();
  });
});

describe("geomBboxRowsFromInstances", () => {
  it("filters a mixed batch down to only road-node/building-footprint rows", () => {
    const rows = geomBboxRowsFromInstances([
      { atomDid: "a1", entityType: "zoning-fact" },
      {
        atomDid: "a2",
        entityType: "road-node",
        countyFips: "48055",
        centerline: { coordinates: [[-97.7, 29.9], [-97.6, 29.95]] },
      },
      { atomDid: "a3", entityType: "setback-rule" },
      {
        atomDid: "a4",
        entityType: "building-footprint",
        parcelNodeId: "48021:1",
        footprintGeometry: { coordinates: [[[-97.4, 30.1], [-97.39, 30.11]]] },
      },
    ]);
    expect(rows.map((r) => r.atomDid)).toEqual(["a2", "a4"]);
  });

  it("returns an empty array for a batch with nothing applicable", () => {
    expect(
      geomBboxRowsFromInstances([{ atomDid: "a1", entityType: "zoning-fact" }]),
    ).toEqual([]);
  });
});
