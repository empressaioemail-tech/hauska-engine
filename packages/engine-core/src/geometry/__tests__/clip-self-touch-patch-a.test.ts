/**
 * PATCH-A — clean clip self-touch artifacts BEFORE the guard (WDLL).
 *
 * Positive space: good near-rects must PASS front-on-each-edge.
 * Negative space: genuinely self-touching / bowtie rings still FAIL the guard.
 * Do not weaken ringHasSelfTouch.
 */

import { describe, expect, it } from "vitest";

import {
  PARCEL_28286_LIVE_TXGIO,
  PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO,
  PARCEL_714_SPRING_33512,
} from "../../depth-warm/fixtures/parcelRings.js";
import { insetPerEdge, openRing, ringAreaSqFt } from "../../depth-warm/geometry.js";
import {
  cleanClipRingArtifacts,
  isInsetDegenerate,
  ringHasSelfTouch,
  type PlanarPoint,
} from "../polygon-inset.js";

const FT = 0.3048;

describe("PATCH-A cleanClipRingArtifacts + positive-space geometry gate", () => {
  it("28286: front-only 15' draws ~7316 on EVERY edge index (positive space)", () => {
    const ring = PARCEL_28286_LIVE_TXGIO;
    const n = openRing(ring).length;
    const lot = ringAreaSqFt(ring);
    expect(lot).toBeGreaterThan(8000);
    expect(lot).toBeLessThan(8500);

    for (let i = 0; i < n; i++) {
      const feet = Array.from({ length: n }, (_, j) => (j === i ? 15 : 0));
      const r = insetPerEdge(ring, feet);
      expect(r.empty, `edge ${i} emptied: ${r.emptyReason}`).toBe(false);
      expect(r.areaSqFt ?? 0).toBeGreaterThan(6000);
      expect(r.areaSqFt ?? 0).toBeLessThan(7600);
    }
  });

  it("28286: uniform 15' still ~3206 (no over-clean / area invent)", () => {
    const n = openRing(PARCEL_28286_LIVE_TXGIO).length;
    const r = insetPerEdge(
      PARCEL_28286_LIVE_TXGIO,
      Array.from({ length: n }, () => 15),
    );
    expect(r.empty).toBe(false);
    expect(Math.round(r.areaSqFt ?? 0)).toBeGreaterThan(3000);
    expect(Math.round(r.areaSqFt ?? 0)).toBeLessThan(3400);
  });

  it("34785 live txgio: front-only 15' still draws on all edges (peer positive)", () => {
    const ring = PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO;
    const n = openRing(ring).length;
    for (let i = 0; i < n; i++) {
      const feet = Array.from({ length: n }, (_, j) => (j === i ? 15 : 0));
      const r = insetPerEdge(ring, feet);
      expect(r.empty, `34785 edge ${i}: ${r.emptyReason}`).toBe(false);
      expect(r.areaSqFt ?? 0).toBeGreaterThan(12000);
    }
  });

  it("714 Spring concave: still draws (no regression)", () => {
    const ring = PARCEL_714_SPRING_33512;
    const n = openRing(ring).length;
    // front-ish: last edge often street-adjacent on this fixture ring
    const feet = Array.from({ length: n }, (_, j) => (j === n - 1 ? 15 : 0));
    const r = insetPerEdge(ring, feet);
    expect(r.empty).toBe(false);
    expect(r.areaSqFt ?? 0).toBeGreaterThan(10000);
  });

  it("cleanClipRingArtifacts removes zero-width spike, keeps area", () => {
    // Captured dirty edge-2 clip ring shape (metres) from planner GUARD probe
    const dirty: PlanarPoint[] = [
      { x: -9.14, y: -20.883 },
      { x: -9.139, y: -16.311 },
      { x: 9.133, y: -16.315 },
      { x: 9.132, y: -20.887 },
      { x: 9.14, y: 20.883 },
      { x: -9.132, y: 20.887 },
    ];
    expect(ringHasSelfTouch(dirty)).toBe(true);
    const cleaned = cleanClipRingArtifacts(dirty);
    expect(ringHasSelfTouch(cleaned)).toBe(false);
    expect(cleaned.length).toBeLessThanOrEqual(5);
    expect(cleaned.length).toBeGreaterThanOrEqual(4);
  });

  it("NEGATIVE: bowtie / self-intersecting inset still rejected by guard", () => {
    const orig: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const bowtie: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const meters = [0, 0, 0, 0];
    expect(isInsetDegenerate(orig, bowtie, meters)).toBe(true);
  });

  it("NEGATIVE: ringHasSelfTouch guard still rejects unclean self-touch rings", () => {
    const orig: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    // Vertex on opposite edge without a U-turn spike (not a clip artifact).
    const genuine: PlanarPoint[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 10, y: 0 },
      { x: 0, y: 20 },
    ];
    expect(ringHasSelfTouch(genuine)).toBe(true);
    // Guard must still fail-closed on this ring (proves we did not weaken ringHasSelfTouch).
    expect(isInsetDegenerate(orig, genuine, [0, 0, 0, 0])).toBe(true);
  });

  it("honest-irregular narrow lot still empties (setbacks exceed)", () => {
    // ~30' wide rect — front 15' + rear 15' uniform collapses
    const FEET = 0.3048;
    const W = 30 * FEET;
    const D = 40 * FEET;
    const lat0 = 30.11;
    const lng0 = -97.32;
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const mPerDegLng = mPerDegLat * Math.cos((lat0 * Math.PI) / 180);
    const ring = [
      [lng0, lat0],
      [lng0 + W / mPerDegLng, lat0],
      [lng0 + W / mPerDegLng, lat0 + D / mPerDegLat],
      [lng0, lat0 + D / mPerDegLat],
      [lng0, lat0],
    ] as [number, number][];
    const r = insetPerEdge(ring, [15, 15, 15, 15]);
    expect(r.empty).toBe(true);
  });
});
