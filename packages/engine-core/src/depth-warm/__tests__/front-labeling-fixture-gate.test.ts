/**
 * FRONT-LABELING FIXTURE GATE (M0 durable promotion — FIX 2.1 / WDLL items 2–3).
 *
 * Fails CI if front-labeling rules regress:
 * - 48021:34785 collector-vs-local → local/unclassified front, not collector
 * - R4.1 footway never wins front when street present
 * - R4.3 gravel front labels correctly
 * - NOT-BY-ACCIDENT: 34785 front identical with and without footway in road set
 */

import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../edgeLabeling.js";
import { PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO } from "../fixtures/parcelRings.js";
import {
  ROAD_34785_CORE_SET,
  ROAD_34785_SOUTH_FOOTWAY,
} from "../fixtures/roads34785.js";
import type { WarmRoadSource } from "../types.js";

function frontSnapshot(roads: ReadonlyArray<WarmRoadSource>) {
  const result = labelEdgesFromRoads({
    parcelRing: PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO,
    roads,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return null;
  const front = result.edgeLabels.find((e) => e.label === "front");
  expect(front).toBeDefined();
  return {
    index: front!.index,
    roadClass: front!.roadClass,
    osmHighwayTag: front!.osmHighwayTag,
  };
}

describe("FRONT-LABELING FIXTURE GATE (FIX 2.1)", () => {
  it("48021:34785 collector-vs-local: front is unclassified local, not collector (WDLL 1)", () => {
    const front = frontSnapshot(ROAD_34785_CORE_SET);
    expect(front!.index).toBe(3);
    expect(front!.roadClass).toBe("unclassified");
    expect(front!.osmHighwayTag).toBe("unclassified");
  });

  it("NOT-BY-ACCIDENT: 34785 front identical with and without footway (WDLL 2)", () => {
    const withoutFootway = frontSnapshot(ROAD_34785_CORE_SET);
    const withFootway = frontSnapshot([...ROAD_34785_CORE_SET, ROAD_34785_SOUTH_FOOTWAY]);
    expect(withFootway).toEqual(withoutFootway);
  });

  it("R4.1 footway never wins front when residential street present (WDLL 3)", () => {
    const ring = PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO;
    const footway = {
      osmWayId: 888,
      osmHighwayTag: "footway",
      name: "Sidewalk",
      classification: "unclassified" as const,
      polyline: [
        [-97.31545, 30.11006],
        [-97.31545, 30.11051],
      ] as [number, number][],
    };
    const street = {
      osmWayId: 777,
      osmHighwayTag: "residential",
      name: "Chestnut St",
      classification: "residential" as const,
      polyline: [
        [-97.31528, 30.11007],
        [-97.31528, 30.11051],
      ] as [number, number][],
    };
    const result = labelEdgesFromRoads({ parcelRing: ring, roads: [footway, street] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front?.roadClass).toBe("residential");
    expect(front?.osmHighwayTag).toBe("residential");
  });

  it("R4.3 gravel front labels and classifies correctly (WDLL 3)", () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const gravelService = {
      osmWayId: 15096758,
      osmHighwayTag: "service",
      surface: "unpaved",
      classification: "gravel" as const,
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ] as [number, number][],
    };
    const result = labelEdgesFromRoads({ parcelRing: ring, roads: [gravelService] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const front = result.edgeLabels.find((e) => e.label === "front");
    expect(front).toBeDefined();
    expect(front!.roadClass).toBe("gravel");
    expect(front!.osmHighwayTag).toBe("service");
    expect(front!.osmSurfaceTag).toBe("unpaved");
  });
});
