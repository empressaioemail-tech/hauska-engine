/**
 * FIX 3 unit fixtures (2026-08-06 dispatch): 4-vertex rectangle, 6-vertex
 * collinear-split, 7-vertex non-rectangular, corner lot, and a
 * mixed-generation regression case for FIX 2.
 */
import { describe, expect, it } from "vitest";

import { checkEnvelopeGroundTruth } from "../envelope-ground-truth.js";
import { insetPerEdge, openRing } from "../../depth-warm/geometry.js";
import type { WarmEdgeRole, WarmRoadSource } from "../../depth-warm/types.js";
import type { JurisdictionDescriptor, SetbackTableDescriptor } from "../../property-reasoning/types.js";

function sb(value: number) {
  return { value, confidence: 1 };
}

function buildDescriptor(setback: {
  front: number;
  side: number;
  rear: number;
  sideCorner?: number;
}): JurisdictionDescriptor {
  const setbackTable: SetbackTableDescriptor = {
    rows: [
      {
        atom_did: "did:hauska:setback-rule:test",
        match_basis: "prefix",
        district_code: "SF-1",
        front_ft: sb(setback.front),
        side_ft: sb(setback.side),
        rear_ft: sb(setback.rear),
        side_corner_ft: sb(setback.sideCorner ?? setback.side),
      },
    ],
  };
  return {
    key: "test-jurisdiction",
    displayName: "Test Jurisdiction",
    jurisdictionTenant: "test-tx",
    parcelFips: "48021",
    defaultAccessPolicy: "public-free",
    setbackTable,
    sourceAdapter: "test",
    sourceUrl: "test://",
  };
}

const SOUTH_ROAD: WarmRoadSource = {
  osmWayId: 1,
  osmHighwayTag: "residential",
  name: "South Street",
  classification: "residential",
  polyline: [
    [-97.601, 29.89995],
    [-97.598, 29.89995],
  ],
};

describe("checkEnvelopeGroundTruth — Fix 3 unit fixtures", () => {
  it("4-vertex rectangle: correct envelope passes P1+P2, front-on-street resolves", () => {
    const parcelRing: [number, number][] = [
      [-97.6, 29.9],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    const descriptor = buildDescriptor({ front: 10, side: 5, rear: 10 });
    // Roles by index for this ring: 0=west(0,1) side, 1=north side, 2=east side, 3=south front.
    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "side"],
      [2, "side"],
      [3, "front"],
    ]);
    const insetFeet = [5, 5, 5, 10];
    const inset = insetPerEdge(parcelRing, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const result = checkEnvelopeGroundTruth({
      parcelRing,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [
        {
          osmWayId: 2,
          osmHighwayTag: "residential",
          name: "Test Front Rd",
          classification: "residential",
          polyline: [
            [-97.6005, 29.89995],
            [-97.5985, 29.89995],
          ],
        },
      ],
      edgeRoles,
    });

    expect(result.p1.pass).toBe(true);
    expect(result.p2.pass).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("4-vertex rectangle: WRONG envelope (leaked outside parcel) fails P1", () => {
    const parcelRing: [number, number][] = [
      [-97.6, 29.9],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    const descriptor = buildDescriptor({ front: 10, side: 5, rear: 10 });
    // Deliberately-leaked envelope: extends past the parcel's east edge.
    const leakedEnvelope: [number, number][] = [
      [-97.5995, 29.9005],
      [-97.5995, 29.9008],
      [-97.5988, 29.9008], // outside parcelRing (east bound is -97.599)
      [-97.5988, 29.9005],
      [-97.5995, 29.9005],
    ];

    const result = checkEnvelopeGroundTruth({
      parcelRing,
      envelopeRing: leakedEnvelope,
      descriptor,
      district: "SF-1",
      roads: [SOUTH_ROAD],
    });

    expect(result.p1.pass).toBe(false);
    expect(result.p1.outsideVertexCount).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
    expect(result.failureReason).toBe("p1-envelope-outside-parcel");
  });

  it("6-vertex collinear-split rectangle: predicate operates on the full-fidelity ring", () => {
    const splitRect: [number, number][] = [
      [-97.6, 29.9],
      [-97.6, 29.9005],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9005],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    expect(openRing(splitRect).length).toBe(6);
    const descriptor = buildDescriptor({ front: 10, side: 5, rear: 10 });
    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "side"],
      [2, "side"],
      [3, "side"],
      [4, "side"],
      [5, "front"],
    ]);
    const insetFeet = [5, 5, 5, 5, 5, 10];
    const inset = insetPerEdge(splitRect, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const result = checkEnvelopeGroundTruth({
      parcelRing: splitRect,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [SOUTH_ROAD],
      edgeRoles,
    });

    expect(result.p1.pass).toBe(true);
    expect(result.p2.pass).toBe(true);
  });

  it("7-vertex non-rectangular lot: geometrically-matched P2 correspondence, not index/label assumption", () => {
    const irregular7: [number, number][] = [
      [-97.6, 29.9],
      [-97.5996, 29.9002],
      [-97.5993, 29.9008],
      [-97.5995, 29.9015],
      [-97.6, 29.9018],
      [-97.6005, 29.9012],
      [-97.6004, 29.9004],
      [-97.6, 29.9],
    ];
    expect(openRing(irregular7).length).toBe(7);
    const descriptor = buildDescriptor({ front: 8, side: 5, rear: 8 });
    const insetFeet = [5, 5, 5, 5, 5, 5, 5];
    const inset = insetPerEdge(irregular7, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "side"],
      [2, "side"],
      [3, "side"],
      [4, "side"],
      [5, "side"],
      [6, "side"],
    ]);

    const result = checkEnvelopeGroundTruth({
      parcelRing: irregular7,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [],
      edgeRoles,
    });

    expect(result.p1.pass).toBe(true);
    expect(result.p2.pass).toBe(true);
    expect(result.p2.edges.length).toBe(7);
  });

  it("corner lot: front + sideCorner roles resolved to distinct district setbacks via P2", () => {
    const cornerLot: [number, number][] = [
      [-97.3268, 30.1066],
      [-97.3266, 30.1064],
      [-97.3263, 30.1064],
      [-97.3261, 30.1066],
      [-97.3261, 30.107],
      [-97.3265, 30.1072],
      [-97.3268, 30.107],
      [-97.3268, 30.1066],
    ];
    expect(openRing(cornerLot).length).toBe(7);
    const descriptor = buildDescriptor({ front: 25, side: 5, rear: 25, sideCorner: 15 });
    const insetFeet = [15, 25, 5, 5, 25, 15, 5];
    const inset = insetPerEdge(cornerLot, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const edgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side_corner"],
      [1, "front"],
      [2, "side"],
      [3, "side"],
      [4, "rear"],
      [5, "side_corner"],
      [6, "side"],
    ]);

    const result = checkEnvelopeGroundTruth({
      parcelRing: cornerLot,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [],
      edgeRoles,
    });

    expect(result.p1.pass).toBe(true);
    expect(result.p2.pass).toBe(true);
    const sideCornerEdges = result.p2.edges.filter((e) => e.role === "side_corner");
    expect(sideCornerEdges.length).toBe(2);
    for (const e of sideCornerEdges) {
      expect(e.expectedFt).toBe(15);
    }
  });

  it("mixed-generation regression (FIX 2): a 4-edge envelope built against a truncated ring fails P1 on the TRUE 5-vertex parcel", () => {
    // 48021:31308 raw parcel ring (D2 audit) and the historically-served
    // 4-edge inset (built from the WRONG truncated 4-vertex ring).
    const trueParcelRing: [number, number][] = [
      [-97.32653742899998, 30.10664583500005],
      [-97.32676392099995, 30.106643674000054],
      [-97.32681061299996, 30.106956840000066],
      [-97.32655329199997, 30.106996621000064],
      [-97.32650865799997, 30.106645721000064],
      [-97.32653742899998, 30.10664583500005],
    ];
    const leakedInsetFromTruncatedRing: [number, number][] = [
      [-97.32670451746095, 30.10689620685521],
      [-97.32666827953699, 30.106653154522785],
      [-97.32648543333013, 30.10665435421853],
      [-97.32653771000867, 30.10692199386753],
      [-97.32670451746095, 30.10689620685521],
    ];
    const descriptor = buildDescriptor({ front: 25, side: 5, rear: 25, sideCorner: 15 });

    const result = checkEnvelopeGroundTruth({
      parcelRing: trueParcelRing,
      envelopeRing: leakedInsetFromTruncatedRing,
      descriptor,
      district: "SF-1",
      roads: [],
    });

    expect(result.p1.pass).toBe(false);
    expect(result.p1.outsideVertexCount).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
    expect(result.failureReason).toBe("p1-envelope-outside-parcel");
  });

  it("P3: claimed front edge disagreeing with geometric street-adjacency fails closed", () => {
    const parcelRing: [number, number][] = [
      [-97.6, 29.9],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    // Symmetric setback (front === side === rear) so every role assignment
    // satisfies P2 identically — isolates P3 as the sole failing part.
    const descriptor = buildDescriptor({ front: 10, side: 10, rear: 10 });
    const insetFeet = [10, 10, 10, 10];
    const inset = insetPerEdge(parcelRing, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    // Road is adjacent to edge 3 (south) but the claimed role wrongly marks
    // edge 1 (north) as front.
    const wrongEdgeRoles = new Map<number, WarmEdgeRole>([
      [0, "side"],
      [1, "front"],
      [2, "side"],
      [3, "side"],
    ]);

    const result = checkEnvelopeGroundTruth({
      parcelRing,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [SOUTH_ROAD],
      edgeRoles: wrongEdgeRoles,
    });

    expect(result.p3.pass).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.failureReason).toBe("p3-front-not-street-adjacent");
  });

  it("P3 honestly undeterminable (no roads) does not fail the overall predicate", () => {
    const parcelRing: [number, number][] = [
      [-97.6, 29.9],
      [-97.6, 29.901],
      [-97.599, 29.901],
      [-97.599, 29.9],
      [-97.6, 29.9],
    ];
    const descriptor = buildDescriptor({ front: 10, side: 5, rear: 10 });
    const insetFeet = [5, 5, 5, 5];
    const inset = insetPerEdge(parcelRing, insetFeet);
    expect(inset.empty, inset.emptyReason).toBe(false);

    const result = checkEnvelopeGroundTruth({
      parcelRing,
      envelopeRing: inset.ring!,
      descriptor,
      district: "SF-1",
      roads: [],
      edgeRoles: new Map<number, WarmEdgeRole>([
        [0, "side"],
        [1, "side"],
        [2, "side"],
        [3, "side"],
      ]),
    });

    expect(result.p3.pass).toBeNull();
    expect(result.pass).toBe(true);
  });
});
