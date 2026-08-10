/**
 * Spatial join threshold tests (50% primary, 10% straddle, reject).
 */
import { describe, expect, it } from "vitest";

import {
  classifyOverlapRatio,
  footprintParcelOverlapRatio,
  joinFootprintsToParcels,
} from "../spatial-join.js";
import type { MlFootprintFeature, ParcelRecord, RingLngLat } from "../types.js";

const PARCEL: RingLngLat = [
  [-97.326, 30.106],
  [-97.326, 30.107],
  [-97.325, 30.107],
  [-97.325, 30.106],
  [-97.326, 30.106],
];

function footprintInsideParcel(fraction = 1): RingLngLat {
  const w = 0.0004 * fraction;
  const cx = -97.3255;
  const cy = 30.1065;
  return [
    [cx - w, cy - w],
    [cx + w, cy - w],
    [cx + w, cy + w],
    [cx - w, cy + w],
    [cx - w, cy - w],
  ];
}

describe("footprintParcelOverlapRatio", () => {
  it("returns ~1.0 when footprint is fully inside parcel", () => {
    const ratio = footprintParcelOverlapRatio(
      footprintInsideParcel(0.3),
      PARCEL,
    );
    expect(ratio).toBeGreaterThanOrEqual(0.99);
  });

  it("returns low ratio when footprint is mostly outside parcel", () => {
    const orphan: RingLngLat = [
      [-97.33, 30.11],
      [-97.329, 30.11],
      [-97.329, 30.111],
      [-97.33, 30.111],
      [-97.33, 30.11],
    ];
    expect(footprintParcelOverlapRatio(orphan, PARCEL)).toBeLessThan(0.1);
  });
});

describe("classifyOverlapRatio", () => {
  it("primary attach at >= 50%", () => {
    expect(classifyOverlapRatio(0.5).attach).toBe(true);
    expect(classifyOverlapRatio(0.5).structureRole).toBe("primary");
    expect(classifyOverlapRatio(0.49).structureRole).toBe("unknown");
    expect(classifyOverlapRatio(0.49).flag).toBe("straddle-review");
  });

  it("rejects below 10%", () => {
    expect(classifyOverlapRatio(0.09).attach).toBe(false);
  });
});

describe("joinFootprintsToParcels", () => {
  it("joins qualifying footprints and rejects orphans", () => {
    const parcels: ParcelRecord[] = [
      {
        parcelNodeId: "48021:31362",
        propId: "31362",
        fips: "48021",
        ring: PARCEL,
      },
    ];
    const footprints: MlFootprintFeature[] = [
      { footprintId: "a", ring: footprintInsideParcel(0.25) },
      {
        footprintId: "orphan",
        ring: [
          [-97.33, 30.11],
          [-97.329, 30.11],
          [-97.329, 30.111],
          [-97.33, 30.111],
          [-97.33, 30.11],
        ],
      },
    ];
    const result = joinFootprintsToParcels(parcels, footprints);
    expect(result.footprintsJoined).toBe(1);
    expect(result.orphanRejected).toBe(1);
    expect(result.parcelsWithFootprint).toBe(1);
    expect(result.byParcel.get("48021:31362")?.[0]?.footprintId).toBe("primary");
  });
});
