/**
 * F3 lot-line geometry scrub — mechanical tests (BDC downtown STEP 3).
 *
 * Specimen 48021:34073 + shared-edge neighbor 48021:34081.
 */

import { describe, expect, it } from "vitest";

import { insetPerEdge, openRing, projectRing } from "../../depth-warm/geometry.js";
import {
  isConvexPlanarRing,
  ringHasSelfTouch,
  ringSelfIntersects,
} from "../../geometry/polygon-inset.js";
import { buildParcelAdjacencyIndex } from "../adjacency-grid.js";
import {
  isNearRectangularParcelRing,
  nearRectEnvelopeCheck,
  scrubLotLineRing,
  scrubParcelCohortEntries,
  snapSharedLotLineVertices,
} from "../lot-line-scrub.js";
import {
  DOWNTOWN_DRILL_MANIFEST_PROP_IDS,
  PARCEL_34073_BCAD,
  PARCEL_34073_CORRUPT_TXGIO,
  PARCEL_34081_BCAD,
  PARCEL_34073_SF1_LAYER23,
} from "../fixtures/bastropDowntownDrill.js";
import type { ParcelIndexEntry } from "../types.js";

const COUNTY = "48021";

function entry(propId: string, ring: typeof PARCEL_34073_BCAD, situs?: string): ParcelIndexEntry {
  const lngs = openRing(ring).map((p) => p[0]);
  const lats = openRing(ring).map((p) => p[1]);
  return {
    countyFips: COUNTY,
    propId,
    parcelNodeId: `${COUNTY}:${propId}`,
    situsAddress: situs ?? null,
    ring,
    westLng: Math.min(...lngs),
    southLat: Math.min(...lats),
    eastLng: Math.max(...lngs),
    northLat: Math.max(...lats),
  };
}

/** SF-1 inset for 34073 Jefferson row (layer 23 per-parcel record). */
function sf1InsetFeet34073(ring: typeof PARCEL_34073_BCAD): number[] {
  const n = openRing(ring).length;
  const sb = PARCEL_34073_SF1_LAYER23;
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return sb.front;
    if (i === 2) return sb.rear;
    return sb.side;
  });
}

describe("F3 lot-line geometry scrub (34073 + 34081)", () => {
  it("34073 corrupt txgio ring fails SF-1 inset before scrub", () => {
    const r = insetPerEdge(PARCEL_34073_CORRUPT_TXGIO, sf1InsetFeet34073(PARCEL_34073_CORRUPT_TXGIO));
    expect(r.empty).toBe(true);
    expect(r.emptyReason).toMatch(/setbacks exceed|correctness gate|null/i);
  });

  it("34073 scrubbed from corrupt → near-rect parcel with ≤6-vertex clean envelope", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34073_CORRUPT_TXGIO);
    expect(openRing(scrubbed).length).toBeLessThanOrEqual(5);
    expect(isNearRectangularParcelRing(scrubbed)).toBe(true);

    const inset = insetPerEdge(scrubbed, sf1InsetFeet34073(scrubbed));
    expect(inset.empty, inset.emptyReason).toBe(false);

    const check = nearRectEnvelopeCheck(scrubbed, inset.ring, 6);
    expect(check.pass, check.reasons.join("; ")).toBe(true);
    expect(check.insetVertexCount).toBeLessThanOrEqual(6);

    const insetOpen = openRing(inset.ring!);
    const proj = openRing(inset.ring!);
    expect(proj.length).toBeGreaterThanOrEqual(4);
  });

  it("34073 authoritative BCAD ring: scrub + SF-1 → clean near-rect envelope", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34073_BCAD);
    expect(isNearRectangularParcelRing(scrubbed)).toBe(true);

    const inset = insetPerEdge(scrubbed, sf1InsetFeet34073(scrubbed));
    expect(inset.empty, inset.emptyReason).toBe(false);

    const check = nearRectEnvelopeCheck(scrubbed, inset.ring, 6);
    expect(check.pass, check.reasons.join("; ")).toBe(true);
    expect(check.insetVertexCount).toBeLessThanOrEqual(6);

    const insetProj = inset.ring ? projectRing(inset.ring) : null;
    expect(insetProj).not.toBeNull();
    if (insetProj) {
      expect(ringHasSelfTouch(insetProj.points)).toBe(false);
      expect(ringSelfIntersects(insetProj.points)).toBe(false);
    }
  });

  it("34081 shared-edge neighbor: cohort snap aligns south lot line with 34073", () => {
    const entries = scrubParcelCohortEntries([
      entry("34073", PARCEL_34073_BCAD, "1006 JEFFERSON ST"),
      entry("34081", PARCEL_34081_BCAD, "1004 JEFFERSON ST"),
    ]);

    const r73 = entries.find((e) => e.propId === "34073")!.ring;
    const r81 = entries.find((e) => e.propId === "34081")!.ring;

    const shared73 = openRing(r73).filter(([lng, lat]) =>
      openRing(r81).some(([lng2, lat2]) =>
        Math.hypot(lng - lng2, lat - lat2) < 1e-6,
      ),
    );
    expect(shared73.length).toBeGreaterThanOrEqual(1);

    const inset81 = insetPerEdge(r81, sf1InsetFeet34073(r81));
    expect(inset81.empty, inset81.emptyReason).toBe(false);
    expect(nearRectEnvelopeCheck(r81, inset81.ring, 6).pass).toBe(true);
  });

  it("cohort scrub builds adjacency index without shrinking manifest set", () => {
    const cohort = [
      entry("34073", PARCEL_34073_BCAD),
      entry("34081", PARCEL_34081_BCAD),
    ];
    const scrubbed = scrubParcelCohortEntries(cohort);
    const index = buildParcelAdjacencyIndex(COUNTY, scrubbed);
    expect(index.entries.size).toBe(2);
    expect(index.entries.has("48021:34073")).toBe(true);
  });

  it("manifest prop_id list matches downtown drill catalog (39 seed parcels)", () => {
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS.length).toBe(39);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).toContain(34073);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).toContain(8741972);
    expect(DOWNTOWN_DRILL_MANIFEST_PROP_IDS).not.toContain(34065);
  });
});

/**
 * R29 — genuinely irregular lot (48021:34121, 907 Chestnut). Raw BCAD ring is a
 * notched hexagon (L-shape) hugging the interior alley: scrubs to 6 all-orthogonal
 * corners but carries ONE reflex vertex. Its GC 20/5/20 envelope is legitimately
 * non-convex. Before R29 the near-rect classifier accepted it (only checked
 * per-corner angle window, not turn-sign consistency), firing the R5 convexity
 * assertion and false-rejecting a valid inset. After R29 the classifier requires
 * convexity, so the lot is NOT near-rect and the convexity gate does not apply.
 */
const PARCEL_34121_BCAD_IRREGULAR: typeof PARCEL_34073_BCAD = [
  [-97.31668774600331, 30.110494384656565],
  [-97.31695316451284, 30.11049057184738],
  [-97.31694869370423, 30.110251391330063],
  [-97.31694780308284, 30.11003542504962],
  [-97.31669481114571, 30.110037138570224],
  [-97.31638153415243, 30.110037795238938],
  [-97.31638174941722, 30.110224436073096],
  [-97.31668279530915, 30.110221169029927],
  [-97.31668774600331, 30.110494384656565],
];

describe("R29 irregular-lot near-rect relaxation (48021:34121)", () => {
  it("notched hexagon lot is NOT classified near-rectangular (reflex vertex)", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34121_BCAD_IRREGULAR);
    // Scrub collapses the 8-vertex capture to a 6-gon L-shape.
    expect(openRing(scrubbed).length).toBe(6);
    // One reflex corner ⇒ irregular, not near-rect.
    expect(isNearRectangularParcelRing(scrubbed)).toBe(false);
    const proj = projectRing(scrubbed);
    expect(proj).not.toBeNull();
    // The lot itself is genuinely non-convex.
    expect(isConvexPlanarRing(proj!.points)).toBe(false);
  });

  it("its non-convex GC 20/5/20 inset is geometrically VALID (verify passes without the R5 gate)", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34121_BCAD_IRREGULAR);
    const n = openRing(scrubbed).length;
    // GC roles: front/rear = 20, sides = 5. Roles positioned to match the ring
    // topology (index 3 front-facing edge, index 4 rear) — the exact per-edge
    // assignment is not load-bearing for the geometry-validity assertion.
    const insetFeet = Array.from({ length: n }, (_, i) =>
      i === 3 || i === 4 ? 20 : 5,
    );
    const inset = insetPerEdge(scrubbed, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);
    expect(inset.ring).not.toBeNull();

    const insetProj = projectRing(inset.ring!);
    expect(insetProj).not.toBeNull();
    // Legitimately non-convex envelope on a legitimately non-convex lot ...
    expect(isConvexPlanarRing(insetProj!.points)).toBe(false);
    // ... but VALID: no self-intersection, no self-touch, positive area.
    expect(ringSelfIntersects(insetProj!.points)).toBe(false);
    expect(ringHasSelfTouch(insetProj!.points)).toBe(false);
    expect(inset.areaSqFt).toBeGreaterThan(0);
    expect(inset.areaSqFt).toBeLessThan(inset.parcelAreaSqFt);

    // The near-rect envelope gate must NOT be applied to this irregular lot:
    // isNearRectangularParcelRing gates the R5 convexity assertion in
    // verify-mechanical, and here it returns false.
    expect(isNearRectangularParcelRing(scrubbed)).toBe(false);
  });

  it("R5 corruption gate STILL rejects a non-convex inset on a genuinely near-rect (convex) lot", () => {
    // 34073 BCAD is a clean convex rectangle → still classified near-rect.
    const nearRect = scrubLotLineRing(PARCEL_34073_BCAD);
    expect(isNearRectangularParcelRing(nearRect)).toBe(true);

    // Inject a deliberately-notched (non-convex) inset inside the parcel.
    const frame = projectRing(nearRect)!;
    const toLngLat = (x: number, y: number): [number, number] => [
      frame.originLng + x / frame.mPerDegLng,
      frame.originLat + y / frame.mPerDegLat,
    ];
    // Parcel spans roughly ±[half-extent]; craft an L-shaped inset well inside.
    const xs = frame.points.map((p) => p.x);
    const ys = frame.points.map((p) => p.y);
    const hx = (Math.max(...xs) - Math.min(...xs)) / 2 - 2;
    const hy = (Math.max(...ys) - Math.min(...ys)) / 2 - 2;
    const notchedInset: typeof PARCEL_34073_BCAD = [
      toLngLat(-hx, -hy),
      toLngLat(hx, -hy),
      toLngLat(hx, hy),
      toLngLat(hx * 0.1, hy),
      toLngLat(hx * 0.1, 0),
      toLngLat(-hx, 0),
      toLngLat(-hx, -hy),
    ];
    const check = nearRectEnvelopeCheck(nearRect, notchedInset, 5);
    expect(check.pass).toBe(false);
    expect(check.reasons.join("; ")).toMatch(/not convex|exceeds/i);
  });
});

describe("snapSharedLotLineVertices", () => {
  it("merges near-duplicate shared vertices across two parcels", () => {
    const drifted81: typeof PARCEL_34081_BCAD = [
      [-97.316394922348977, 30.110992466811997],
      [-97.31639608, 30.11113535], // ~2cm drift from 34073 v1
      [-97.316704763, 30.111119676], // ~1cm drift from 34073 v0
      [-97.316699846182914, 30.110982118735119],
      [-97.316394922348977, 30.110992466811997],
    ];
    const snapped = snapSharedLotLineVertices(
      new Map([
        ["34073", PARCEL_34073_BCAD],
        ["34081", drifted81],
      ]),
    );
    const v73 = openRing(snapped.get("34073")!);
    const v81 = openRing(snapped.get("34081")!);
    const shared = v73.filter(([lng, lat]) =>
      v81.some(([lng2, lat2]) => Math.hypot(lng - lng2, lat - lat2) < 1e-7),
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });
});
