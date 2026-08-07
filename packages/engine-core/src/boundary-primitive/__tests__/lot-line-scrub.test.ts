/**
 * F3 lot-line geometry scrub — mechanical tests (BDC downtown STEP 3).
 *
 * Specimen 48021:34073 + shared-edge neighbor 48021:34081.
 */

import { describe, expect, it } from "vitest";

import { insetPerEdge, openRing, projectRing } from "../../depth-warm/geometry.js";
import {
  isConvexPlanarRing,
  pointInOrOnPolygon,
  ringHasSelfTouch,
  ringSelfIntersects,
} from "../../geometry/polygon-inset.js";
import { buildParcelAdjacencyIndex } from "../adjacency-grid.js";
import {
  isNearRectangularParcelRing,
  nearRectEnvelopeCheck,
  fetchBcadParcelRings,
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
  // 2026-08-07 CORRECTION (OFFSET-CORE-VARIABLE-DISTANCE redesign, PR #269,
  // master planner ruling 1): this test previously asserted
  // `r.empty === true` on the corrupt (pre-scrub) ring. That assertion was
  // FALSE — a defect pin on the OLD strip-union-difference core, the SAME
  // fixture and SAME insetFeet array ([25,5,25,5,5,5,5,5], F25/S5/R25 per
  // PARCEL_34073_SF1_LAYER23) already corrected in
  // geometry/__tests__/robust-inward-offset.test.ts's negative-space
  // regression suite. Ground truth verified there via three independent
  // methods (manual half-plane math, clipping-free brute-force grid
  // sampling, and sheet-standard.test.ts's independent PDF pipeline on a
  // sibling fixture): the true buildable area is ~2148.13 sqft, not empty.
  // The corrupt ring's redundant collinear vertices are cosmetic
  // subdivisions of the same physical edges and do not change the true
  // buildable region — scrubbing is still valuable for producing a clean,
  // minimal-vertex envelope (see the next test), but "the corrupt ring
  // fails to inset at all" was never true.
  it("34073 corrupt txgio ring insets successfully even before scrub — verified ground truth ~2148.13 sqft, not empty", () => {
    const r = insetPerEdge(PARCEL_34073_CORRUPT_TXGIO, sf1InsetFeet34073(PARCEL_34073_CORRUPT_TXGIO));
    expect(r.empty, r.emptyReason).toBe(false);
    expect(r.areaSqFt).toBeGreaterThan(2147.6);
    expect(r.areaSqFt).toBeLessThan(2148.6);
  });

  it("34073 scrubbed from corrupt → near-rect parcel with ≤6-vertex clean envelope", () => {
    const scrubbed = scrubLotLineRing(PARCEL_34073_CORRUPT_TXGIO, { aggressive: true });
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
    const scrubbed = scrubLotLineRing(PARCEL_34073_BCAD, { aggressive: true });
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
    const scrubbed = scrubLotLineRing(PARCEL_34121_BCAD_IRREGULAR, { aggressive: true });
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
    const scrubbed = scrubLotLineRing(PARCEL_34121_BCAD_IRREGULAR, { aggressive: true });
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
    // 2026-08-07 CORRECTION (OFFSET-CORE-VARIABLE-DISTANCE redesign, PR
    // #269, master planner ruling 1): this previously asserted the inset
    // MUST stay non-convex, on the unverified assumption that a non-convex
    // parcel always produces a non-convex envelope. That assumption is
    // false in general — verified independently (brute-force grid
    // sampling, no offset-core code involved) on this exact fixture and
    // setback assignment: the 20ft setbacks on the two edges bounding the
    // reflex notch are large enough to fully consume the concave region,
    // so the TRUE buildable envelope here is convex (area 3142.90 sqft by
    // brute force vs 3142.93 sqft from insetPerEdge — matching to the 4th
    // significant figure). The load-bearing assertion this test exists
    // for — VALID geometry (no self-intersection, no self-touch, positive
    // bounded area) without requiring the R5 near-rect convexity gate — is
    // unaffected by convexity either way, so it stays exactly as strict.
    // ... VALID: no self-intersection, no self-touch, positive area.
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
    const nearRect = scrubLotLineRing(PARCEL_34073_BCAD, { aggressive: true });
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

describe("fetchBcadParcelRings prop_id field casing", () => {
  const square = [
    [-97.6, 29.9],
    [-97.6, 29.901],
    [-97.599, 29.901],
    [-97.599, 29.9],
    [-97.6, 29.9],
  ];

  function fakeFetchWithPropKey(propKey: string): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          features: [
            {
              properties: { [propKey]: 22945 },
              geometry: { type: "Polygon", coordinates: [square] },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
  }

  it("resolves rings when the layer echoes lowercase prop_id (BCAD/Guadalupe shape)", async () => {
    const out = await fetchBcadParcelRings([22945], fakeFetchWithPropKey("prop_id"));
    expect(out).toHaveLength(1);
    expect(out[0]!.propId).toBe("22945");
  });

  it("resolves rings when the layer echoes cased Prop_ID (Caldwell CAD shape)", async () => {
    const out = await fetchBcadParcelRings([22945], fakeFetchWithPropKey("Prop_ID"));
    expect(out).toHaveLength(1);
    expect(out[0]!.propId).toBe("22945");
  });

  it("resolves rings when the layer uses pid (Ellis Halff shape)", async () => {
    const out = await fetchBcadParcelRings([22945], fakeFetchWithPropKey("pid"), "http://example/layer/0", "pid");
    expect(out).toHaveLength(1);
    expect(out[0]!.propId).toBe("22945");
  });

  it("uses quoted string IN when prop ids are non-numeric (Williamson PARCELID R* shape)", async () => {
    let capturedWhere = "";
    const fakeFetch: typeof fetch = (async (input) => {
      const u = new URL(String(input));
      capturedWhere = u.searchParams.get("where") ?? "";
      return new Response(
        JSON.stringify({
          features: [
            {
              properties: { PARCELID: "R12345" },
              geometry: { type: "Polygon", coordinates: [square] },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await fetchBcadParcelRings(
      ["R12345", "R67890"],
      fakeFetch,
      "http://example/layer/0",
      "PARCELID",
    );
    expect(capturedWhere).toBe("PARCELID IN ('R12345','R67890')");
    expect(out).toHaveLength(1);
    expect(out[0]!.propId).toBe("R12345");
  });

  it("uses numeric IN when all prop ids are numeric (unchanged path)", async () => {
    let capturedWhere = "";
    const fakeFetch: typeof fetch = (async (input) => {
      const u = new URL(String(input));
      capturedWhere = u.searchParams.get("where") ?? "";
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchBcadParcelRings([22945, 22946], fakeFetch, "http://example/layer/0", "PropertyID");
    expect(capturedWhere).toBe("PropertyID IN (22945,22946)");
  });
});

/**
 * D2 ring-truncation regression (2026-08-06 differential audit, WS1 operator
 * QA fail on 48021:31308). Root cause: the DEFAULT scrub previously ran
 * `removeNearlyStraightVertices` (turn-angle heuristic, no length floor),
 * which collapsed a genuine ~0.89deg shallow-angle corner bounding a real
 * ~2.8m edge — turning a true 5-vertex ring into 4 and leaking the served
 * inset ~7ft onto the neighbor to the east (2 of 4 inset vertices land
 * outside the true parcel ring). `removeCollinearVertices` (the exact,
 * scale-correct cross-product test already in the default pipeline) does
 * NOT drop this vertex (|cross| ~0.94 vs tol 0.05) — it is not actually
 * collinear in the sense that matters. The fix: `removeNearlyStraightVertices`
 * now only runs under `aggressive: true`, opt-in for known-corrupt sources.
 */
describe("D2 ring-truncation regression (48021:31308, Jones/Higgins)", () => {
  const PARCEL_31308_RAW: typeof PARCEL_34073_BCAD = [
    [-97.32653742899998, 30.10664583500005],
    [-97.32676392099995, 30.106643674000054],
    [-97.32681061299996, 30.106956840000066],
    [-97.32655329199997, 30.106996621000064],
    [-97.32650865799997, 30.106645721000064],
    [-97.32653742899998, 30.10664583500005],
  ];

  it("default (strict) scrub preserves the true 5-vertex ring — no truncation to 4", () => {
    const scrubbed = scrubLotLineRing(PARCEL_31308_RAW);
    expect(openRing(scrubbed).length).toBe(5);
  });

  it("aggressive scrub (opt-in) still collapses it — documents the tradeoff explicitly", () => {
    const scrubbed = scrubLotLineRing(PARCEL_31308_RAW, { aggressive: true });
    expect(openRing(scrubbed).length).toBe(4);
  });

  it("a 4-edge inset built against the WRONG (truncated) 4-vertex ring leaks outside the true 5-vertex parcel", () => {
    // Historical bug reproduction: the served inset ring recorded by the
    // operator QA probe, checked against the TRUE (untruncated) parcel ring.
    const leakedInsetRing: typeof PARCEL_34073_BCAD = [
      [-97.32670451746095, 30.10689620685521],
      [-97.32666827953699, 30.106653154522785],
      [-97.32648543333013, 30.10665435421853],
      [-97.32653771000867, 30.10692199386753],
      [-97.32670451746095, 30.10689620685521],
    ];
    const parcelProj = projectRing(PARCEL_31308_RAW)!;
    let outsideCount = 0;
    for (const [lng, lat] of openRing(leakedInsetRing)) {
      const p = {
        x: (lng - parcelProj.originLng) * parcelProj.mPerDegLng,
        y: (lat - parcelProj.originLat) * parcelProj.mPerDegLat,
      };
      if (!pointInOrOnPolygon(p, parcelProj.points, 0.12)) outsideCount++;
    }
    expect(outsideCount).toBeGreaterThan(0);
  });
});

/**
 * Fix 1 required unit fixtures (dispatch 2026-08-06): 4-vertex rectangle,
 * 6-vertex collinear-split, 7-vertex non-rectangular, and a corner lot.
 * Each asserts the DEFAULT (strict) scrub preserves genuine corners and the
 * resulting envelope stays CONTAINED in the parcel ring.
 */
describe("Fix 1 ring-fidelity fixtures", () => {
  function assertEnvelopeContained(parcelRing: typeof PARCEL_34073_BCAD, insetRing: typeof PARCEL_34073_BCAD) {
    const parcelProj = projectRing(parcelRing)!;
    for (const [lng, lat] of openRing(insetRing)) {
      const p = {
        x: (lng - parcelProj.originLng) * parcelProj.mPerDegLng,
        y: (lat - parcelProj.originLat) * parcelProj.mPerDegLat,
      };
      expect(pointInOrOnPolygon(p, parcelProj.points, 0.12)).toBe(true);
    }
  }

  it("4-vertex rectangle: scrub is a no-op, envelope stays contained", () => {
    const rect: typeof PARCEL_34073_BCAD = [
      [-97.6, 29.9],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    const scrubbed = scrubLotLineRing(rect);
    expect(openRing(scrubbed).length).toBe(4);
    const n = openRing(scrubbed).length;
    const inset = insetPerEdge(scrubbed, Array.from({ length: n }, () => 10));
    expect(inset.empty, inset.emptyReason).toBe(false);
    assertEnvelopeContained(scrubbed, inset.ring!);
  });

  it("6-vertex collinear-split rectangle: default scrub removes exact-collinear midpoints, envelope stays contained", () => {
    // A true rectangle with two exact-collinear points inserted mid-edge
    // (genuine digitization split, zero perpendicular deviation) — the
    // properly-scaled removeCollinearVertices pass (always-on) should drop
    // these two, independent of the aggressive/turn-angle pass.
    const splitRect: typeof PARCEL_34073_BCAD = [
      [-97.6, 29.9],
      [-97.6, 29.9005],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9005],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    const scrubbed = scrubLotLineRing(splitRect);
    expect(openRing(scrubbed).length).toBe(4);
    const n = openRing(scrubbed).length;
    const inset = insetPerEdge(scrubbed, Array.from({ length: n }, () => 10));
    expect(inset.empty, inset.emptyReason).toBe(false);
    assertEnvelopeContained(scrubbed, inset.ring!);
  });

  it("7-vertex non-rectangular lot: default scrub preserves all real corners, envelope stays contained", () => {
    // Irregular 7-gon (no genuinely collinear or sub-survey-noise vertices).
    const irregular7: typeof PARCEL_34073_BCAD = [
      [-97.6, 29.9],
      [-97.5996, 29.9002],
      [-97.5993, 29.9008],
      [-97.5995, 29.9015],
      [-97.6, 29.9018],
      [-97.6005, 29.9012],
      [-97.6004, 29.9004],
      [-97.6, 29.9],
    ];
    const scrubbed = scrubLotLineRing(irregular7);
    expect(openRing(scrubbed).length).toBe(7);
    const n = openRing(scrubbed).length;
    const inset = insetPerEdge(scrubbed, Array.from({ length: n }, () => 5));
    expect(inset.empty, inset.emptyReason).toBe(false);
    assertEnvelopeContained(scrubbed, inset.ring!);
  });

  it("corner lot (48021:31371-shaped, front+sideCorner roles): default scrub preserves the true ring, envelope stays contained", () => {
    // Raw 7-vertex corner-lot ring per D2 audit (31371 raw edge count 7).
    const cornerLot: typeof PARCEL_34073_BCAD = [
      [-97.3268, 30.1066],
      [-97.3266, 30.1064],
      [-97.3263, 30.1064],
      [-97.3261, 30.1066],
      [-97.3261, 30.107],
      [-97.3265, 30.1072],
      [-97.3268, 30.107],
      [-97.3268, 30.1066],
    ];
    const scrubbed = scrubLotLineRing(cornerLot);
    // No genuinely collinear or sub-survey-length vertex in this fixture —
    // the strict default must not truncate a real 7-corner lot.
    expect(openRing(scrubbed).length).toBe(7);
    const insetFeet = [15, 25, 5, 5, 25, 15, 5];
    const inset = insetPerEdge(scrubbed, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);
    assertEnvelopeContained(scrubbed, inset.ring!);
  });
});
