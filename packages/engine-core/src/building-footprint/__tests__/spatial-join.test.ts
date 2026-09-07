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

  /**
   * The grid-index prefilter (2026-09-06 perf fix) buckets parcels by a
   * ~0.01deg cell and only checks a footprint against parcels sharing a
   * cell with it. These falsifiers prove that's a pure speedup, not a
   * behavior change: a parcel far away in a totally different cell must
   * never be picked over a correct, nearby match, and a large parcel that
   * spans MULTIPLE grid cells must still be found by a footprint landing
   * in any one of them.
   */
  it("still finds the correct parcel when many far-away decoy parcels occupy unrelated grid cells", () => {
    const target: ParcelRecord = {
      parcelNodeId: "48021:target",
      propId: "target",
      fips: "48021",
      ring: PARCEL,
    };
    const decoys: ParcelRecord[] = Array.from({ length: 50 }, (_, i) => ({
      parcelNodeId: `48021:decoy-${i}`,
      propId: `decoy-${i}`,
      fips: "48021",
      // Spread decoys far across many distinct ~0.01deg grid cells, nowhere
      // near the target parcel or the footprint under test.
      ring: [
        [-98.0 + i * 0.05, 31.0 + i * 0.05],
        [-98.0 + i * 0.05 + 0.001, 31.0 + i * 0.05],
        [-98.0 + i * 0.05 + 0.001, 31.0 + i * 0.05 + 0.001],
        [-98.0 + i * 0.05, 31.0 + i * 0.05 + 0.001],
        [-98.0 + i * 0.05, 31.0 + i * 0.05],
      ],
    }));
    const footprints: MlFootprintFeature[] = [
      { footprintId: "a", ring: footprintInsideParcel(0.25) },
    ];
    const result = joinFootprintsToParcels([target, ...decoys], footprints);
    expect(result.footprintsJoined).toBe(1);
    expect(result.byParcel.get("48021:target")?.[0]?.footprintId).toBe("primary");
    for (const d of decoys) {
      expect(result.byParcel.has(d.parcelNodeId)).toBe(false);
    }
  });

  it("finds a match inside a parcel large enough to span several grid cells", () => {
    // ~0.03deg square, spanning multiple ~0.01deg grid cells in both axes.
    const bigParcel: ParcelRecord = {
      parcelNodeId: "48021:big",
      propId: "big",
      fips: "48021",
      ring: [
        [-97.35, 30.10],
        [-97.35, 30.13],
        [-97.32, 30.13],
        [-97.32, 30.10],
        [-97.35, 30.10],
      ],
    };
    // A small footprint tucked in the far corner of the big parcel, several
    // grid cells away from the parcel's own bucketing origin cell.
    const cornerFootprint: RingLngLat = [
      [-97.323, 30.128],
      [-97.3225, 30.128],
      [-97.3225, 30.1285],
      [-97.323, 30.1285],
      [-97.323, 30.128],
    ];
    const result = joinFootprintsToParcels(
      [bigParcel],
      [{ footprintId: "corner", ring: cornerFootprint }],
    );
    expect(result.footprintsJoined).toBe(1);
    expect(result.byParcel.get("48021:big")?.[0]?.footprintId).toBe("primary");
  });
});
