/**
 * R4 edge labeling tests — 714 Spring honest labels + decline paths.
 */

import { describe, expect, it } from "vitest";

import { edgeLabels714SpringHonest } from "../fixtures/edgeLabels714Spring.js";
import { PARCEL_714_SPRING_33512 } from "../fixtures/parcelRings.js";
import { labelEdgesFromRoads } from "../edgeLabeling.js";

const SPRING_ROAD = {
  osmWayId: 123456789,
  osmHighwayTag: "residential",
  name: "Spring Street",
  classification: "residential" as const,
  /** OSM centerline along the south ROW of 714 Spring (~15m south of edge 5). */
  polyline: [
    [-97.3194, 30.11155],
    [-97.31885, 30.11156],
    [-97.3183, 30.11157],
  ] as [number, number][],
};

describe("labelEdgesFromRoads (R4)", () => {
  it("714 Spring: one front residential edge, honest not_specified sides", () => {
    const result = labelEdgesFromRoads({
      parcelRing: PARCEL_714_SPRING_33512,
      roads: [SPRING_ROAD],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const honest = edgeLabels714SpringHonest();
    expect(result.edgeLabels.length).toBe(honest.length);

    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front).toBeDefined();
    expect(front!.roadClass).toBe("residential");
    expect(front!.osmHighwayTag).toBe("residential");
    expect(front!.index).toBe(honest.find((e) => e.label === "front")!.index);

    for (const edge of result.edgeLabels.filter((e) => e.label !== "front" && e.label !== "rear")) {
      expect(edge.roadClass).toBeUndefined();
    }
  });

  it("declines when no roads provided", () => {
    const result = labelEdgesFromRoads({
      parcelRing: PARCEL_714_SPRING_33512,
      roads: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.decline).toBe("no-roads-available");
  });

  it("declines when roads are too far from parcel", () => {
    const farRoad = {
      ...SPRING_ROAD,
      osmWayId: 999,
      polyline: [
        [-97.5, 30.2],
        [-97.49, 30.2],
      ] as [number, number][],
    };
    const result = labelEdgesFromRoads({
      parcelRing: PARCEL_714_SPRING_33512,
      roads: [farRoad],
      proximityThresholdM: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.decline).toBe("no-road-adjacency");
  });
});
