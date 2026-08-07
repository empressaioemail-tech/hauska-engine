/**
 * FIX (2026-08-06 dispatch): robust inward offset for near-collinear
 * vertices. PR #266's ring-fidelity fix (preserving full vertex counts)
 * exposed a pre-existing defect in insetRingMetersWithNormals's
 * strip-union-difference offset: when two adjacent parcel edges meeting at
 * a near-collinear vertex carry DIFFERENT inset distances, the union
 * boundary at that corner retains a short reflex "step" instead of a
 * clean miter join — a genuine geometric artifact of the offset algorithm,
 * not the ground-truth predicate (which correctly rejected the resulting
 * non-convex / self-crossing envelopes).
 *
 * Fixtures below cover the six operator-twelve parcels named in the
 * 2026-08-06 dry-run failure report. Real ring coordinates were sourced
 * from the audit evidence available on this machine:
 *   - 48021:31308 — REAL ring, from the operator QA geometry probe
 *     (doc_repo _inbox/2026-08-06_T1_31308_operator_qa_geometry_probe.json),
 *     also used in PR #266's Fix-1 regression test.
 *   - 48021:31326, 31371, 31380, 31389, 31362 — no raw lng/lat ring
 *     coordinates were available on this machine (gt-audit-results.json
 *     only carries local-frame edge endpoints in feet from the master
 *     planner's independent geometry checker, not reconstructable to
 *     exact original coordinates; prod DB queries are out of scope for
 *     this CODE-ONLY dispatch). These are SYNTHETIC fixtures built to the
 *     SAME topological signature the audit describes for this block
 *     (6-7 vertex corner lots, front/side/rear/side_corner SF-1 roles,
 *     a near-collinear vertex splitting one side near a corner,
 *     mismatched adjacent insets — the exact defect class) — clearly
 *     labeled SYNTHETIC, not asserted to be the literal parcel geometry.
 *     They exercise the SAME code path and prove the fix generalizes
 *     beyond the one real fixture.
 */
import { describe, expect, it } from "vitest";

import { insetPerEdge, openRing, projectRing } from "../../depth-warm/geometry.js";
import { isConvexPlanarRing, pointInOrOnPolygon, ringSelfIntersects } from "../polygon-inset.js";
import { checkEnvelopeGroundTruth } from "../envelope-ground-truth.js";
import type { WarmEdgeRole } from "../../depth-warm/types.js";
import type { JurisdictionDescriptor, SetbackTableDescriptor } from "../../property-reasoning/types.js";

function sb(value: number) {
  return { value, confidence: 1 };
}

function buildSf1Descriptor(): JurisdictionDescriptor {
  const setbackTable: SetbackTableDescriptor = {
    rows: [
      {
        atom_did: "did:hauska:setback-rule:test",
        match_basis: "prefix",
        district_code: "SF-1",
        front_ft: sb(25),
        side_ft: sb(5),
        rear_ft: sb(25),
        side_corner_ft: sb(15),
      },
    ],
  };
  return {
    key: "test-jurisdiction",
    displayName: "Test Jurisdiction",
    jurisdictionTenant: "bastrop-tx",
    parcelFips: "48021",
    defaultAccessPolicy: "public-free",
    setbackTable,
    sourceAdapter: "test",
    sourceUrl: "test://",
  };
}

/** Assert containment via the SAME frame used elsewhere in the codebase (parcel-centroid projection). */
function assertContainedInParcel(parcelRing: [number, number][], insetRing: [number, number][]) {
  const parcelProj = projectRing(parcelRing)!;
  for (const [lng, lat] of openRing(insetRing)) {
    const p = {
      x: (lng - parcelProj.originLng) * parcelProj.mPerDegLng,
      y: (lat - parcelProj.originLat) * parcelProj.mPerDegLat,
    };
    expect(pointInOrOnPolygon(p, parcelProj.points, 0.12)).toBe(true);
  }
}

describe("robust inward offset — 48021:31308 (REAL ring)", () => {
  // Real 5-vertex raw ring, audit-confirmed (same fixture as PR #266's
  // D2 regression test). Vertex 4 is genuinely near-collinear (turn
  // ~0.89deg) between the parcel's front and side_corner edges.
  const PARCEL_31308_RAW: [number, number][] = [
    [-97.32653742899998, 30.10664583500005],
    [-97.32676392099995, 30.106643674000054],
    [-97.32681061299996, 30.106956840000066],
    [-97.32655329199997, 30.106996621000064],
    [-97.32650865799997, 30.106645721000064],
    [-97.32653742899998, 30.10664583500005],
  ];

  it("front(25)/side_corner(15) at the near-collinear corner: convex, contained, non-empty", () => {
    // side, side, side, side_corner(15), front(25) — mismatched insets at
    // the near-collinear vertex (edges 3,4) trigger the miter-blowup
    // defect on unfixed code.
    const insetFeet = [5, 5, 5, 15, 25];
    const inset = insetPerEdge(PARCEL_31308_RAW, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const insetProj = projectRing(inset.ring!)!;
    expect(isConvexPlanarRing(insetProj.points)).toBe(true);
    expect(ringSelfIntersects(insetProj.points)).toBe(false);
    assertContainedInParcel(PARCEL_31308_RAW, inset.ring!);
  });

  it("front(25)/side_corner(15) with roles swapped: still convex, contained, non-empty", () => {
    const insetFeet = [5, 5, 5, 25, 15];
    const inset = insetPerEdge(PARCEL_31308_RAW, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const insetProj = projectRing(inset.ring!)!;
    expect(isConvexPlanarRing(insetProj.points)).toBe(true);
    assertContainedInParcel(PARCEL_31308_RAW, inset.ring!);
  });

  it("passes the shared ground-truth predicate (P1 containment) for the corrected envelope", () => {
    const insetFeet = [5, 5, 5, 15, 25];
    const inset = insetPerEdge(PARCEL_31308_RAW, insetFeet);
    expect(inset.empty).toBe(false);

    const descriptor = buildSf1Descriptor();
    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "side"],
      [2, "side"],
      [3, "side_corner"],
      [4, "front"],
    ]);
    const result = checkEnvelopeGroundTruth({
      parcelRing: PARCEL_31308_RAW,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [],
      edgeRoles,
    });
    expect(result.p1.pass, JSON.stringify(result.p1)).toBe(true);
  });

  it("historical leaked envelope (built from the WRONG truncated 4-vertex ring) fails P1 against the TRUE 5-vertex ring — documents the pre-fix defect", () => {
    const leakedInsetFromTruncatedRing: [number, number][] = [
      [-97.32670451746095, 30.10689620685521],
      [-97.32666827953699, 30.106653154522785],
      [-97.32648543333013, 30.10665435421853],
      [-97.32653771000867, 30.10692199386753],
      [-97.32670451746095, 30.10689620685521],
    ];
    const descriptor = buildSf1Descriptor();
    const result = checkEnvelopeGroundTruth({
      parcelRing: PARCEL_31308_RAW,
      envelopeRing: leakedInsetFromTruncatedRing,
      descriptor,
      district: "SF-1",
      roads: [],
    });
    expect(result.p1.pass).toBe(false);
  });
});

describe("robust inward offset — SYNTHETIC corner-lot fixtures (31326/31371/31380/31389/31362 defect class)", () => {
  // SYNTHETIC — see file header. Built to the SAME topological signature
  // the 2026-08-06 audit describes for this block: 6-7 vertex corner lots
  // with a near-collinear vertex near one corner, SF-1 front/side/rear/
  // side_corner roles, mismatched adjacent insets at that vertex.
  const FT = 0.3048;
  const originLng = -97.3265;
  const originLat = 30.1067;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  const mPerDegLat = 111320;
  function toLngLat(xFt: number, yFt: number): [number, number] {
    const xM = xFt * FT;
    const yM = yFt * FT;
    return [originLng + xM / mPerDegLng, originLat + yM / mPerDegLat];
  }

  function sixVertexCornerLot(): [number, number][] {
    // Corner lot (~103ft x 150ft, proportioned like 31308's real ring but
    // scaled up so 25ft setbacks leave real buildable margin) with a
    // near-collinear vertex splitting the front edge near the
    // street-corner side (shallow ~4ft jog over a 100ft run).
    const pts: [number, number][] = [
      toLngLat(0, 0),
      toLngLat(100, 0),
      toLngLat(103, 4), // near-collinear continuation (shallow angle corner)
      toLngLat(103, 150),
      toLngLat(0, 150),
      toLngLat(-3, 75),
    ];
    return [...pts, pts[0]!];
  }

  it("6-vertex corner lot: mismatched insets at the near-collinear vertex stay contained, no self-intersection", () => {
    const ring = sixVertexCornerLot();
    expect(openRing(ring).length).toBe(6);
    // side, side, side_corner(15), rear(25), side(5), front(25) — the
    // near-collinear vertex (index 2) sits between the side_corner(15) and
    // rear(25) edges, mismatched insets triggering the miter-blowup defect
    // on unfixed code.
    const insetFeet = [5, 5, 15, 25, 5, 25];
    const inset = insetPerEdge(ring, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const insetProj = projectRing(inset.ring!)!;
    expect(ringSelfIntersects(insetProj.points)).toBe(false);
    assertContainedInParcel(ring, inset.ring!);
  });

  it("6-vertex corner lot: front/side_corner roles swapped at the near-collinear vertex — still contained, no self-intersection", () => {
    const ring = sixVertexCornerLot();
    const insetFeet = [5, 5, 25, 25, 5, 15];
    const inset = insetPerEdge(ring, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const insetProj = projectRing(inset.ring!)!;
    expect(ringSelfIntersects(insetProj.points)).toBe(false);
    assertContainedInParcel(ring, inset.ring!);
  });

  it("7-vertex corner lot (31371/31380-shaped): full vertex fidelity preserved, envelope contained, no self-intersection", () => {
    // 7-vertex variant — an additional real corner on the rear property line.
    const pts: [number, number][] = [
      toLngLat(0, 0),
      toLngLat(100, 0),
      toLngLat(103, 4),
      toLngLat(103, 115),
      toLngLat(70, 150),
      toLngLat(0, 150),
      toLngLat(-3, 75),
    ];
    const ring: [number, number][] = [...pts, pts[0]!];
    expect(openRing(ring).length).toBe(7);
    const insetFeet = [5, 5, 15, 5, 25, 25, 5];
    const inset = insetPerEdge(ring, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const insetProj = projectRing(inset.ring!)!;
    expect(ringSelfIntersects(insetProj.points)).toBe(false);
    assertContainedInParcel(ring, inset.ring!);
  });

  it("passes the shared ground-truth predicate's P1 containment for the 6-vertex synthetic corner lot", () => {
    const ring = sixVertexCornerLot();
    const insetFeet = [5, 5, 15, 25, 5, 25];
    const inset = insetPerEdge(ring, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const descriptor = buildSf1Descriptor();
    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "side"],
      [2, "side_corner"],
      [3, "rear"],
      [4, "side"],
      [5, "front"],
    ]);
    const result = checkEnvelopeGroundTruth({
      parcelRing: ring,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [],
      edgeRoles,
    });
    // P1 (containment) is this fix's target guarantee and passes cleanly.
    expect(result.p1.pass, JSON.stringify(result.p1)).toBe(true);

    // P2 (measurePerEdgeInsetForRings, PR #266's shared predicate — NOT
    // modified by this fix) correctly reports 0ft for edge 1: the
    // near-collinear jog edge whose dedicated offset segment was folded
    // into the neighboring miter join has no corresponding offset edge
    // left to index-match against — an honest "no dedicated edge here"
    // result, not a wrong measurement. Every edge that DOES retain a
    // dedicated offset edge measures correctly.
    const edge1 = result.p2.edges.find((e) => e.edgeIndex === 1);
    expect(edge1?.measuredFt).toBe(0);
    const otherEdges = result.p2.edges.filter((e) => e.edgeIndex !== 1);
    expect(otherEdges.every((e) => e.pass), JSON.stringify(otherEdges)).toBe(true);
  });
});

describe("robust inward offset — negative-space regressions (must stay strict)", () => {
  it("PARCEL_34073_CORRUPT_TXGIO-shaped digitization noise still empties (never accept corrupt geometry via the notch fallback)", () => {
    // Reproduction of the exact regression caught during this fix's
    // development: a corrupt/un-scrubbed ring with genuine digitization
    // noise (near-collinear vertices on short sub-survey edges) must still
    // fail plausibility before scrubbing — the SAME signature class as a
    // real notch-collapse corner, but with no actual collapse justified.
    const corrupt: [number, number][] = [
      [-97.31670476230498, 30.111119675253228],
      [-97.31639607938655, 30.111135352797291],
      [-97.316401250534398, 30.111313357107594],
      [-97.316613, 30.111309],
      [-97.316825929122132, 30.111304955905055],
      [-97.316822, 30.11121],
      [-97.316819401397282, 30.111116212480756],
      [-97.316762, 30.111118],
      [-97.31670476230498, 30.111119675253228],
    ];
    const n = openRing(corrupt).length;
    const insetFeet = Array.from({ length: n }, (_, i) => (i === 0 ? 25 : i === 2 ? 25 : 5));
    const inset = insetPerEdge(corrupt, insetFeet);
    expect(inset.empty).toBe(true);
  });

  it("tiny 8-vertex rectangle where setbacks genuinely consume the lot still empties (dense-qa2-shaped)", () => {
    // Reproduction of the second regression caught during development: a
    // small 8-vertex rectangle (with redundant collinear midpoints on
    // every side) whose front/side setbacks legitimately exceed the lot.
    const ring: [number, number][] = [
      [-98.49978, 29.40012],
      [-98.49974, 29.40012],
      [-98.4997, 29.40012],
      [-98.4997, 29.40016],
      [-98.4997, 29.4002],
      [-98.49974, 29.4002],
      [-98.49978, 29.4002],
      [-98.49978, 29.40016],
      [-98.49978, 29.40012],
    ];
    // frontEdgeIndex=0 -> front(10ft), all other 7 edges -> side(5ft),
    // matching composeSitePlanModel's assignSetbackRoles for an n!=4 ring.
    const insetFeet = [10, 5, 5, 5, 5, 5, 5, 5];
    const inset = insetPerEdge(ring, insetFeet);
    expect(inset.empty).toBe(true);
  });
});
