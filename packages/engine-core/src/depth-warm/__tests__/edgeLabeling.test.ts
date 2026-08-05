/**
 * R4 edge labeling tests — 714 Spring honest labels + decline paths.
 */

import { describe, expect, it } from "vitest";

import { edgeLabels714SpringHonest } from "../fixtures/edgeLabels714Spring.js";
import { PARCEL_714_SPRING_33512, PARCEL_BASTROP_47728 } from "../fixtures/parcelRings.js";
import { labelEdgesFromRoads, isFrontEligibleRoad, detectFlagLotShape } from "../edgeLabeling.js";
import { projectRing } from "../geometry.js";
import type { WarmRoadSource } from "../types.js";

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

  it("never labels footway as front (R4.1)", () => {
    const footway = {
      osmWayId: 888,
      osmHighwayTag: "footway",
      name: "Sidewalk",
      classification: "unclassified" as const,
      polyline: [
        [-97.3185, 30.11065],
        [-97.31855, 30.1110],
      ] as [number, number][],
    };
    const street = {
      osmWayId: 777,
      osmHighwayTag: "residential",
      name: "Chestnut St",
      classification: "residential" as const,
      polyline: [
        [-97.3187, 30.11065],
        [-97.31845, 30.11065],
      ] as [number, number][],
    };
    expect(isFrontEligibleRoad(footway)).toBe(false);
    const result = labelEdgesFromRoads({
      parcelRing: PARCEL_BASTROP_47728,
      roads: [footway, street],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("residential");
    expect(front?.osmHighwayTag).toBe("residential");
  });
});

/** Live BCAD rings for Mesquite St flag-lot pair (80577/80578), 2026-08-05. */
const RING_80577: [number, number][] = [
  [-97.321399998429683, 30.128728525694676],
  [-97.321616277640373, 30.128725632491946],
  [-97.321623296550257, 30.129270107208747],
  [-97.321416335493637, 30.129273902943531],
  [-97.321408250968972, 30.129274051028844],
  [-97.321399998429683, 30.128728525694676],
];

const RING_80578: [number, number][] = [
  [-97.321616277640373, 30.128725632491946],
  [-97.321832556810207, 30.128722739825445],
  [-97.321838343095123, 30.129266164855242],
  [-97.321623296550257, 30.129270107208747],
  [-97.321616277640373, 30.128725632491946],
];

const MESQUITE_ST_S: WarmRoadSource = {
  osmWayId: 9001,
  osmHighwayTag: "residential",
  name: "Mesquite Street",
  classification: "residential",
  polyline: [
    [-97.3225, 30.12872],
    [-97.3205, 30.12872],
  ],
};

const MESQUITE_ST_E: WarmRoadSource = {
  osmWayId: 9002,
  osmHighwayTag: "residential",
  name: "Mesquite Street",
  classification: "residential",
  polyline: [
    [-97.32162, 30.1285],
    [-97.32162, 30.1295],
  ],
};

function roleMap(result: ReturnType<typeof labelEdgesFromRoads>): Map<number, string> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("declined");
  return new Map(result.edgeLabels.map((e) => [e.index, e.label]));
}

describe("labelEdgesFromRoads flag-lot rear (80577/80578 Mesquite class)", () => {
  it("detects 80577 BCAD ring as flag-lot shape (neck + jog)", () => {
    const proj = projectRing(RING_80577);
    expect(proj).not.toBeNull();
    expect(detectFlagLotShape(proj!)).toBe(true);
  });

  it("80578: rear on north opposite edge, not the long east side (prior defect class)", () => {
    const roles = roleMap(
      labelEdgesFromRoads({
        parcelRing: RING_80578,
        roads: [MESQUITE_ST_S],
        situsAddress: "605 MESQUITE ST , BASTROP, TX 78602",
      }),
    );
    // South (Mesquite frontage) wins front; north is rear; east/west stay side.
    expect(roles.get(2)).toBe("front");
    expect(roles.get(0)).toBe("rear");
    expect(roles.get(1)).toBe("side");
    expect(roles.get(3)).toBe("side");
  });

  it("80577: skips survey-noise sliver as rear; west long edge is rear with E frontage", () => {
    const roles = roleMap(
      labelEdgesFromRoads({
        parcelRing: RING_80577,
        roads: [MESQUITE_ST_E],
        situsAddress: "607 MESQUITE ST , BASTROP, TX 78602",
      }),
    );
    expect(roles.get(2)).toBe("front");
    expect(roles.get(4)).toBe("rear");
    expect(roles.get(0)).toBe("side");
    expect(roles.get(1)).toBe("side");
    expect(roles.get(3)).toBe("side");
  });

  it("80577 with S+E roads: rear on west, tiny edge 0 stays side", () => {
    const roles = roleMap(
      labelEdgesFromRoads({
        parcelRing: RING_80577,
        roads: [MESQUITE_ST_S, MESQUITE_ST_E],
        situsAddress: "607 MESQUITE ST , BASTROP, TX 78602",
      }),
    );
    expect(roles.get(2)).toBe("front");
    expect(roles.get(4)).toBe("rear");
    expect(roles.get(0)).toBe("side");
  });
});
