import { describe, expect, it } from "vitest";

import { roadIntakeDescriptorFromCountyRegistry } from "../descriptor-from-registry.js";
import {
  buildCountyBoundaryIndex,
  emitTargetsForWay,
  pointInCountyGeometry,
  resolveWayCounties,
  segmentsIntersect,
  type CountyBoundaryRecord,
} from "../way-to-county.js";

/** Unit square counties meeting at x=0 for crossing tests. */
function square(
  countyFips: string,
  countyName: string,
  west: number,
  south: number,
  east: number,
  north: number,
): CountyBoundaryRecord {
  return {
    countyFips,
    countyName,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

describe("way-to-county resolver", () => {
  const index = buildCountyBoundaryIndex([
    square("48021", "Bastrop", -98, 29, -97, 31),
    square("48055", "Caldwell", -97, 29, -96, 31),
    square("48453", "Travis", -98, 31, -97, 32),
  ]);

  it("assigns an interior way to exactly one county", () => {
    const centerline = [
      [-97.5, 30.1],
      [-97.4, 30.2],
    ] as const;
    const { hits, unresolved } = resolveWayCounties(centerline, index);
    expect(unresolved).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.countyFips).toBe("48021");
    expect(hits[0]!.basis).toBe("vertex-inside");
  });

  it("emits N road-node ids for a way spanning three counties (preserve id shape)", () => {
    const centerline = [
      [-97.5, 30.0], // Bastrop
      [-96.5, 30.0], // Caldwell
      [-96.5, 31.5], // north then west into Travis
      [-97.5, 31.5], // Travis
    ] as const;
    const targets = emitTargetsForWay(999001, centerline, index);
    const fips = targets.map((t) => t.countyFips).sort();
    expect(fips).toEqual(["48021", "48055", "48453"]);
    expect(targets.every((t) => t.roadNodeId.endsWith(":road:999001"))).toBe(
      true,
    );
    expect(targets.find((t) => t.countyFips === "48021")!.roadNodeId).toBe(
      "48021:road:999001",
    );
  });

  it("assigns a boundary-running road to BOTH adjacent counties", () => {
    // Shared vertical boundary at lon=-97. Even-odd treats on-boundary
    // vertices as outside; segment-cross must recover BOTH sides.
    const along = [
      [-97, 29.2],
      [-97, 30.8],
    ] as const;
    const { hits } = resolveWayCounties(along, index);
    const fips = new Set(hits.map((h) => h.countyFips));
    expect(fips.has("48021")).toBe(true);
    expect(fips.has("48055")).toBe(true);
    expect(fips.size).toBe(2);
    // Basis may be vertex/midpoint or segment-cross depending on ray-cast
    // edge cases; the invariant is BOTH counties, not the basis label.
  });

  it("catches a middle-county crossing with no vertex or midpoint inside", () => {
    // Long eastbound segment: midpoint sits ON the shared line (outside both
    // under even-odd). Basis must still resolve both counties via segment-cross.
    const leap = [
      [-97.8, 30.0],
      [-96.2, 30.0],
    ] as const;
    const { hits } = resolveWayCounties(leap, index);
    const fips = hits.map((h) => h.countyFips).sort();
    expect(fips).toEqual(["48021", "48055"]);
  });

  it("segmentsIntersect detects collinear shared-edge touch", () => {
    expect(
      segmentsIntersect([-97, 29], [-97, 31], [-97, 29.5], [-97, 30.5]),
    ).toBe(true);
  });

  it("documents that on-edge points are outside under even-odd (nasty case)", () => {
    const bastrop = index.find((c) => c.countyFips === "48021")!;
    expect(pointInCountyGeometry(-97, 30, bastrop.geometry)).toBe(false);
    expect(pointInCountyGeometry(-97.0001, 30, bastrop.geometry)).toBe(true);
  });
});

describe("descriptor-from-registry", () => {
  it("derives descriptor without hand-authored per-city adapter", () => {
    const d = roadIntakeDescriptorFromCountyRegistry({
      countyFips: "48021",
      countyName: "Bastrop County",
    });
    expect(d.countyFips).toBe("48021");
    expect(d.jurisdictionTenant).toBe("breadth_48021_bastrop");
    expect(d.sourceAdapter).toBe("road-intake-osm-geofabrik-pbf");
    expect(d.assumedRowWidthFt.residential).toBe(50);
    expect(d.key).toContain("48021");
  });

  it("preserves breadth_48021_bastrop when overridden (parity with hand descriptors)", () => {
    const d = roadIntakeDescriptorFromCountyRegistry({
      countyFips: "48021",
      countyName: "Bastrop County",
      jurisdictionTenant: "breadth_48021_bastrop",
    });
    expect(d.jurisdictionTenant).toBe("breadth_48021_bastrop");
  });
});
