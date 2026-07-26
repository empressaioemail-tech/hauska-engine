/**
 * FIX 1 — site-plan offset must match depth-warm insetPerEdge (shared polygon-clipping).
 * Specimen: 48021:34785 (1009 Chestnut), front-only 15' on clean ~98×165 ft rect.
 */

import { describe, expect, it } from "vitest";

import { insetPerEdge, ringAreaSqFt } from "../../depth-warm/geometry.js";
import { PARCEL_1009_CHESTNUT_34785 } from "../../depth-warm/fixtures/parcelRings.js";
import { projectWgs84ToLocalEnu } from "../../parcel-terrain/mesh.js";
import { signedArea } from "../../geometry/polygon-inset.js";
import {
  computeSetbackOffset,
  dedupeClosingVertex,
} from "../ring-geometry.js";

const SQMETERS_PER_SQFOOT = 0.09290304;
const TARGET_BUILDABLE_SQFT = 13_641;
const AREA_TOLERANCE_SQFT = 200;

function ringBbox(ring: Array<[number, number]>) {
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  return {
    westLng: Math.min(...lngs),
    eastLng: Math.max(...lngs),
    southLat: Math.min(...lats),
    northLat: Math.max(...lats),
  };
}

function localRingAreaSqFt(ring: Array<{ x: number; y: number }>): number {
  return Math.abs(signedArea(ring)) / SQMETERS_PER_SQFOOT;
}

describe("site-plan offset parity with depth-warm insetPerEdge (48021:34785)", () => {
  it("48021:34785 front-only 15 ft: site-plan offset area ≈ depth-warm (~13641 sqft)", () => {
    const ring = PARCEL_1009_CHESTNUT_34785;
    const depthWarm = insetPerEdge(ring, [0, 0, 0, 15]);
    expect(depthWarm.empty).toBe(false);
    expect(depthWarm.areaSqFt).toBeGreaterThan(TARGET_BUILDABLE_SQFT - AREA_TOLERANCE_SQFT);
    expect(depthWarm.areaSqFt).toBeLessThan(TARGET_BUILDABLE_SQFT + AREA_TOLERANCE_SQFT);

    const bbox = ringBbox(ring);
    const ringLocal = dedupeClosingVertex(
      ring.slice(0, -1).map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, bbox)),
    );

    const sitePlan = computeSetbackOffset(
      ringLocal,
      { front: 15, side: 0, rear: 0 },
      3,
      { side: true, rear: true },
    );

    expect(sitePlan.offsetDegenerate).toBe(false);
    expect(sitePlan.offsetRing).not.toBeNull();
    expect(sitePlan.basis).toBe("front-edge-hint");

    const sitePlanAreaSqFt = localRingAreaSqFt(sitePlan.offsetRing!);
    expect(sitePlanAreaSqFt).toBeCloseTo(depthWarm.areaSqFt, 0);
    expect(sitePlanAreaSqFt).toBeGreaterThan(TARGET_BUILDABLE_SQFT - AREA_TOLERANCE_SQFT);
    expect(sitePlanAreaSqFt).toBeLessThan(TARGET_BUILDABLE_SQFT + AREA_TOLERANCE_SQFT);
  });

  it("48021:34785 parcel lot area is ~16111 sqft (sanity on fixture)", () => {
    const lotSqFt = Math.round(ringAreaSqFt(PARCEL_1009_CHESTNUT_34785));
    expect(lotSqFt).toBeGreaterThan(16_000);
    expect(lotSqFt).toBeLessThan(16_300);
  });
});
