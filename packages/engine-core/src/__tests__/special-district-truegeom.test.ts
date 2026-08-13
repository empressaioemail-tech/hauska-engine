/**
 * CP1 / SF-6 true-geometry membership gates.
 *
 * T1 proves the bbox-midpoint false-negative that true-geom fixes, without a
 * live DB: a parcel whose bbox midpoint sits outside the district while the
 * parcel polygon still intersects the district.
 *
 * T2 proves drain FAIL CLOSED on wrong / missing membershipMethodId.
 */

import { describe, expect, it } from "vitest";

import { pointInGeoJson, type BBox, type LngLat } from "../special-district-fact/geo.js";
import {
  TRUE_GEOM_MEMBERSHIP_METHOD,
  assertTrueGeomMembershipMethod,
} from "../special-district-fact/membership-method.js";
import {
  drainSpecialDistrictPlanPayload,
  readPlanPayload,
  writePlanPayload,
  SD_PLAN_NDJSON_FORMAT,
  type SpecialDistrictPlanPayload,
} from "../special-district-fact/plan-payload.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function bboxMidpoint(bbox: BBox): LngLat {
  return [
    (bbox.westLng + bbox.eastLng) / 2,
    (bbox.southLat + bbox.northLat) / 2,
  ];
}

function asRing(coords: unknown): LngLat[] | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring: LngLat[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  return ring;
}

function ringsOf(geometry: { type?: string; coordinates?: unknown }): LngLat[][] {
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    const outer = asRing(geometry.coordinates[0]);
    return outer ? [outer] : [];
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    const out: LngLat[][] = [];
    for (const poly of geometry.coordinates) {
      if (!Array.isArray(poly)) continue;
      const outer = asRing(poly[0]);
      if (outer) out.push(outer);
    }
    return out;
  }
  return [];
}

function segmentsIntersect(
  a1: LngLat,
  a2: LngLat,
  b1: LngLat,
  b2: LngLat,
): boolean {
  const orient = (p: LngLat, q: LngLat, r: LngLat) =>
    (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  const onSeg = (p: LngLat, q: LngLat, r: LngLat) =>
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1]);

  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);

  if (o1 === 0 && onSeg(a1, b1, a2)) return true;
  if (o2 === 0 && onSeg(a1, b2, a2)) return true;
  if (o3 === 0 && onSeg(b1, a1, b2)) return true;
  if (o4 === 0 && onSeg(b1, a2, b2)) return true;
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}

/** Turf-free polygon intersection oracle for the straddler fixture. */
function polygonsIntersectGeoJson(
  a: { type?: string; coordinates?: unknown },
  b: { type?: string; coordinates?: unknown },
): boolean {
  const ringsA = ringsOf(a);
  const ringsB = ringsOf(b);
  for (const ra of ringsA) {
    for (const pt of ra) {
      if (pointInGeoJson(pt[0], pt[1], b)) return true;
    }
  }
  for (const rb of ringsB) {
    for (const pt of rb) {
      if (pointInGeoJson(pt[0], pt[1], a)) return true;
    }
  }
  for (const ra of ringsA) {
    for (const rb of ringsB) {
      for (let i = 0; i < ra.length - 1; i++) {
        for (let j = 0; j < rb.length - 1; j++) {
          if (segmentsIntersect(ra[i]!, ra[i + 1]!, rb[j]!, rb[j + 1]!)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

describe("special-district true-geom (CP1)", () => {
  it("T1: bbox-midpoint ABSENT while true-geometry INTERSECTS for straddler", () => {
    // District square: [-97.50, 30.00] .. [-97.40, 30.10]
    const district = {
      type: "Polygon",
      coordinates: [
        [
          [-97.5, 30.0],
          [-97.4, 30.0],
          [-97.4, 30.1],
          [-97.5, 30.1],
          [-97.5, 30.0],
        ],
      ],
    };

    // Parcel straddles the west edge: most of the bbox is west of the district,
    // but the eastern lobe crosses into the district interior.
    const parcel = {
      type: "Polygon",
      coordinates: [
        [
          [-97.7, 30.04],
          [-97.45, 30.04],
          [-97.45, 30.06],
          [-97.7, 30.06],
          [-97.7, 30.04],
        ],
      ],
    };
    const parcelBbox: BBox = {
      westLng: -97.7,
      eastLng: -97.45,
      southLat: 30.04,
      northLat: 30.06,
    };

    const mid = bboxMidpoint(parcelBbox);
    // Midpoint lng = (-97.7 + -97.45) / 2 = -97.575 — west of district.
    expect(mid[0]).toBeCloseTo(-97.575, 6);
    expect(pointInGeoJson(mid[0], mid[1], district)).toBe(false);

    // True geometry intersects (eastern lobe at lng=-97.45 is inside district).
    expect(polygonsIntersectGeoJson(parcel, district)).toBe(true);
    expect(pointInGeoJson(-97.45, 30.05, district)).toBe(true);

    expect(TRUE_GEOM_MEMBERSHIP_METHOD).toBe(
      "postgis-zone-major-st-intersects-true-geom",
    );
    expect(() =>
      assertTrueGeomMembershipMethod(TRUE_GEOM_MEMBERSHIP_METHOD),
    ).not.toThrow();
  });

  it("T2: drainSpecialDistrictPlanPayload fail-closed on wrong/missing method", () => {
    const base: SpecialDistrictPlanPayload = {
      countyFips: "48021",
      membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
      plannedAt: "2026-08-12T00:00:00.000Z",
      districtsIndexed: 1,
      emptyDistrictIndex: false,
      absenceReasoningRuleId: "outside-tceq-source-true-geom-no-intersect",
      planned: [
        {
          outcome: "absent",
          parcelKey: "1",
          absenceKind: "outside-tceq-source-boundaries",
          reason: "test",
        },
      ],
      counts: {
        presentMemberships: 0,
        absentOutside: 1,
        parcelsInDistrict: 0,
        parcelsOutside: 1,
        skippedUnusableKey: 0,
        rateEnrichedCount: 0,
      },
      parcelsRead: 1,
    };

    const ok = drainSpecialDistrictPlanPayload(base);
    expect(ok.planned).toHaveLength(1);
    expect(ok.countyFips).toBe("48021");

    expect(() =>
      drainSpecialDistrictPlanPayload({
        ...base,
        membershipMethodId: "bbox-midpoint-pip",
      }),
    ).toThrow(/FAIL CLOSED/);

    expect(() =>
      drainSpecialDistrictPlanPayload({
        ...base,
        membershipMethodId: "",
      }),
    ).toThrow(/missing/);

    expect(() =>
      drainSpecialDistrictPlanPayload({
        ...base,
        // @ts-expect-error intentional missing method
        membershipMethodId: undefined,
      }),
    ).toThrow(/missing/);
  });

  it("T3: NDJSON plan write/read round-trip (Harris string-length fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-plan-ndjson-"));
    const path = join(dir, "48021.plan.json");
    try {
      const payload: SpecialDistrictPlanPayload = {
        countyFips: "48021",
        membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
        plannedAt: "2026-08-13T00:00:00.000Z",
        districtsIndexed: 2,
        emptyDistrictIndex: false,
        absenceReasoningRuleId: "outside-tceq-source-true-geom-no-intersect",
        planned: [
          {
            outcome: "present",
            parcelKey: "1",
            districtId: "d1",
            districtName: "Test MUD",
            districtType: "mud",
          },
          {
            outcome: "absent",
            parcelKey: "2",
            absenceKind: "outside-tceq-source-boundaries",
            reason: "test",
          },
        ],
        counts: {
          presentMemberships: 1,
          absentOutside: 1,
          parcelsInDistrict: 1,
          parcelsOutside: 1,
          skippedUnusableKey: 0,
          rateEnrichedCount: 0,
        },
        parcelsRead: 2,
      };
      writePlanPayload(path, payload);
      const head = readFileSync(path, "utf8").split("\n")[0]!;
      expect(head).toContain(SD_PLAN_NDJSON_FORMAT);
      expect(head).not.toContain('"planned":[');
      const back = readPlanPayload(path);
      expect(back.format).toBe(SD_PLAN_NDJSON_FORMAT);
      expect(back.planned).toHaveLength(2);
      expect(back.planned[0]?.parcelKey).toBe("1");
      expect(back.membershipMethodId).toBe(TRUE_GEOM_MEMBERSHIP_METHOD);
      const drained = drainSpecialDistrictPlanPayload(back);
      expect(drained.planned).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
