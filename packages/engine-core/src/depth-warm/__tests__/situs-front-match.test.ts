/**
 * FRONT-role situs-street match (operator-ratified defect 48021:34177).
 *
 * A corner parcel whose situs is "901 PECAN ST" must put front on the
 * Pecan-facing edge even when the Pine-facing edge is closer to its road.
 * No situs / no match / ambiguous (curving street on two edges) → the
 * existing adjacency heuristic, unchanged, with frontBasis recorded.
 */

import { describe, expect, it } from "vitest";

import {
  labelEdgesFromRoads,
  normalizeStreetNameForMatch,
} from "../edgeLabeling.js";
import type { WarmRoadSource } from "../types.js";

/**
 * Synthetic corner lot near Bastrop (CCW ring, closed):
 *   edge 0 = south, edge 1 = east, edge 2 = north, edge 3 = west.
 * Pine Street runs ~5.6 m south of the south edge (closest road).
 * Pecan Street runs ~7.7 m west of the west edge (the situs street).
 * Under the pure proximity heuristic Pine wins front; situs must flip it.
 */
const CORNER_RING: [number, number][] = [
  [-97.32, 30.11],
  [-97.3194, 30.11],
  [-97.3194, 30.1104],
  [-97.32, 30.1104],
  [-97.32, 30.11],
];

const SOUTH_EDGE = 0;
const WEST_EDGE = 3;

const PECAN_ROAD: WarmRoadSource = {
  osmWayId: 1001,
  osmHighwayTag: "residential",
  name: "Pecan Street",
  classification: "residential",
  polyline: [
    [-97.32008, 30.1098],
    [-97.32008, 30.1106],
  ],
};

const PINE_ROAD: WarmRoadSource = {
  osmWayId: 1002,
  osmHighwayTag: "residential",
  name: "Pine Street",
  classification: "residential",
  polyline: [
    [-97.3202, 30.10995],
    [-97.3192, 30.10995],
  ],
};

/** Pecan curving around the corner: adjacent to BOTH west and north edges. */
const PECAN_ROAD_CURVING: WarmRoadSource = {
  ...PECAN_ROAD,
  polyline: [
    [-97.32008, 30.1098],
    [-97.32008, 30.11048],
    [-97.3194, 30.11048],
  ],
};

function frontOf(result: ReturnType<typeof labelEdgesFromRoads>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("labeling declined");
  const front = result.edgeLabels.find((e) => e.label === "front");
  expect(front).toBeDefined();
  return front!;
}

describe("normalizeStreetNameForMatch", () => {
  it("strips house number and suffix variants", () => {
    expect(normalizeStreetNameForMatch("901 PECAN ST")).toBe("PECAN");
    expect(normalizeStreetNameForMatch("Pecan Street")).toBe("PECAN");
    expect(normalizeStreetNameForMatch("CHESTNUT ST")).toBe("CHESTNUT");
    expect(normalizeStreetNameForMatch("Chestnut Street")).toBe("CHESTNUT");
    expect(normalizeStreetNameForMatch("800 Chestnut Drive")).toBe("CHESTNUT");
    expect(normalizeStreetNameForMatch("800 CHESTNUT DR")).toBe("CHESTNUT");
  });

  it("strips directionals and unit designators", () => {
    expect(normalizeStreetNameForMatch("1009 N Main St")).toBe("MAIN");
    expect(normalizeStreetNameForMatch("Main Street West")).toBe("MAIN");
    expect(normalizeStreetNameForMatch("901 PECAN ST APT 4")).toBe("PECAN");
  });

  it("never strips a token down to nothing", () => {
    expect(normalizeStreetNameForMatch("West Street")).toBe("WEST");
    expect(normalizeStreetNameForMatch("Street")).toBe("STREET");
  });

  it("keeps unsuffixed route names intact", () => {
    expect(normalizeStreetNameForMatch("FM 20")).toBe("FM 20");
    expect(normalizeStreetNameForMatch("123 HWY 71 W")).toBe("HWY 71");
  });
});

describe("labelEdgesFromRoads situs-street front preference", () => {
  it("901-Pecan corner: situs flips front from Pine edge to Pecan edge", () => {
    const withSitus = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD, PINE_ROAD],
        situsAddress: "901 PECAN ST",
      }),
    );
    expect(withSitus.index).toBe(WEST_EDGE);
    expect(withSitus.frontBasis).toBe("situs-street-match");
    expect(withSitus.osmWayId).toBe(PECAN_ROAD.osmWayId);
  });

  it("FULL-address situs (txgio form, comma tail) still matches — the live restamp regression", () => {
    // txgio situs_address is a full address; the county-wide restamp silently
    // fell back to the heuristic because the city/state/zip tail survived
    // normalization. The street segment before the first comma must match.
    const withFullSitus = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD, PINE_ROAD],
        situsAddress: "901 PECAN ST , BASTROP, TX 78602",
      }),
    );
    expect(withFullSitus.index).toBe(WEST_EDGE);
    expect(withFullSitus.frontBasis).toBe("situs-street-match");
  });

  it("901-Pecan corner: the Pine edge loses front under situs match", () => {
    const result = labelEdgesFromRoads({
      parcelRing: CORNER_RING,
      roads: [PECAN_ROAD, PINE_ROAD],
      situsAddress: "901 PECAN ST",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const south = result.edgeLabels.find((e) => e.index === SOUTH_EDGE);
    // Existing downstream role logic unchanged: with two road-adjacent edges
    // the non-front road edge takes the rear slot (side_corner needs a third).
    expect(south?.label).not.toBe("front");
  });

  it("no situs: adjacency heuristic unchanged (Pine edge front, basis recorded)", () => {
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD, PINE_ROAD],
      }),
    );
    expect(front.index).toBe(SOUTH_EDGE);
    expect(front.frontBasis).toBe("adjacency-heuristic");
  });

  it("suffix-variant matching: situs 'CHESTNUT ST' matches road 'Chestnut Street'", () => {
    const chestnut: WarmRoadSource = { ...PECAN_ROAD, name: "Chestnut Street" };
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [chestnut, PINE_ROAD],
        situsAddress: "800 CHESTNUT ST",
      }),
    );
    expect(front.index).toBe(WEST_EDGE);
    expect(front.frontBasis).toBe("situs-street-match");
  });

  it("situs street not among adjacent roads: heuristic fallback", () => {
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD, PINE_ROAD],
        situsAddress: "500 MAIN ST",
      }),
    );
    expect(front.index).toBe(SOUTH_EDGE);
    expect(front.frontBasis).toBe("adjacency-heuristic");
  });

  it("ambiguous match (curving street on two edges): closest situs edge wins (R30)", () => {
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD_CURVING, PINE_ROAD],
        situsAddress: "901 PECAN ST",
      }),
    );
    // Curving Pecan is adjacent to west + north; west is closer to the situs
    // frontage than south (Pine heuristic would have picked south).
    expect(front.index).toBe(WEST_EDGE);
    expect(front.frontBasis).toBe("situs-street-match");
  });

  it("empty situs string behaves as no situs", () => {
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [PECAN_ROAD, PINE_ROAD],
        situsAddress: "   ",
      }),
    );
    expect(front.index).toBe(SOUTH_EDGE);
    expect(front.frontBasis).toBe("adjacency-heuristic");
  });

  it("alley named like the situs street never wins front", () => {
    const pecanAlley: WarmRoadSource = {
      ...PECAN_ROAD,
      osmWayId: 1003,
      osmHighwayTag: "service",
      classification: "alley",
    };
    const front = frontOf(
      labelEdgesFromRoads({
        parcelRing: CORNER_RING,
        roads: [pecanAlley, PINE_ROAD],
        situsAddress: "901 PECAN ST",
      }),
    );
    expect(front.index).toBe(SOUTH_EDGE);
    expect(front.frontBasis).toBe("adjacency-heuristic");
  });
});
