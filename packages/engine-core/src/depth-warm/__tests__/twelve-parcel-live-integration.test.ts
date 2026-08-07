/**
 * INTEGRATION-GRADE ACCEPTANCE HARNESS (2026-08-06 dispatch, third round).
 *
 * Runs the ACTUAL live candidate-build + verify pipeline — the same
 * functions depth-warm-bastrop-batch.mjs calls (labelEdgesFromRoads,
 * warmThenVerify -> computeWarmCandidate -> insetPerEdge ->
 * insetRingMetersWithNormals -> collapseNearCollinearOffsetNotches,
 * verifyWarmCandidateMechanically, checkEnvelopeGroundTruth) — against the
 * TWELVE REAL Jones/Higgins parcel rings pulled directly from
 * txgio_parcel.geometry (P:/tmp/twelve-live-rings.json, exact GeoJSON the
 * batch path consumes; NOT gt-audit-results.json local-frame data, NOT
 * synthetic).
 *
 * Road geometry: the batch script loads live road-node atoms from prod.
 * This machine has no prod access (CODE ONLY dispatch), so this harness
 * uses the REAL Jones Street / Higgins Street / Eskew Street OSM way
 * geometry (public data, the same upstream source road-intake ingests
 * from) fetched directly from the OSM API for way ids 15105940 (Jones),
 * 15109717 (Higgins), 15113705 (Eskew) — verified by coordinate match
 * against the block's actual parcel footprints (Jones runs along the
 * north row's north/front edge ~lat 30.1069-30.1073; Higgins along the
 * south row's south/front edge ~lat 30.1062; Eskew is the north-south
 * cross-street at the block's west end, giving 31308/31362 their
 * side_corner). No situs address roster was available for all twelve, so
 * front resolution runs on the adjacency-heuristic path (situsAddress:
 * null) — the same fallback the live pipeline itself uses when situs is
 * absent or ambiguous; R35 honestly declines the situs-dependent
 * orientation/facesAnswer axes in that case rather than fabricating a
 * comparison, exactly as it does live.
 *
 * SF-1 descriptor: F25 / S5 / R25, side_corner 15 (per dispatch).
 */
import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../edgeLabeling.js";
import { warmThenVerify } from "../warm-then-verify.js";
import type { WarmRoadSource } from "../types.js";
import type { Ring } from "../geometry.js";
import { checkEnvelopeGroundTruth } from "../../geometry/envelope-ground-truth.js";
import type { JurisdictionDescriptor, SetbackTableDescriptor } from "../../property-reasoning/types.js";
import twelveLiveRings from "./fixtures/twelve-live-rings.json" with { type: "json" };

function sb(value: number) {
  return { value, confidence: 1 };
}

function buildSf1Descriptor(): JurisdictionDescriptor {
  const setbackTable: SetbackTableDescriptor = {
    rows: [
      {
        atom_did: "did:hauska:setback-rule:test-sf1",
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
    key: "48021-jones-higgins-harness",
    displayName: "Bastrop 48021 (Jones/Higgins harness)",
    jurisdictionTenant: "bastrop-tx",
    parcelFips: "48021",
    defaultAccessPolicy: "public-free",
    setbackTable,
    sourceAdapter: "test-live-integration-harness",
    sourceUrl: "test://",
  };
}

// Real OSM way geometry for Jones Street (15105940), Higgins Street
// (15109717), Eskew Street (15113705) — fetched from the public OSM API,
// verified against the block's parcel coordinates. [lng, lat] order to
// match WarmRoadSource.polyline (Ring).
const ROADS: WarmRoadSource[] = [
  {
    osmWayId: 15105940,
    osmHighwayTag: "residential",
    name: "Jones Street",
    classification: "residential",
    polyline: [
      [-97.327145, 30.10696_8],
      [-97.3271087, 30.1069721],
      [-97.3269644, 30.1069885],
      [-97.3262876, 30.1071086],
      [-97.3259352, 30.1071829],
      [-97.3254679, 30.107324],
    ],
  },
  {
    osmWayId: 15109717,
    osmHighwayTag: "residential",
    name: "Higgins Street",
    classification: "residential",
    polyline: [
      [-97.325033, 30.1062044],
      [-97.325171, 30.1061978],
      [-97.3270891, 30.106243],
      [-97.327131, 30.106244],
    ],
  },
  {
    osmWayId: 15113705,
    osmHighwayTag: "residential",
    name: "Eskew Street",
    classification: "residential",
    polyline: [
      [-97.3271768, 30.1051908],
      [-97.327171, 30.1052803],
      [-97.327163, 30.1054031],
      [-97.327147, 30.105648],
      [-97.327143, 30.1057324],
      [-97.3271362, 30.1059556],
      [-97.327131, 30.106244],
      [-97.327145, 30.106968],
      [-97.327157, 30.107411],
      [-97.327175, 30.107513],
      [-97.327202, 30.107616],
      [-97.3272268, 30.1076884],
      [-97.327237, 30.107718],
      [-97.327263, 30.1077795],
      [-97.327338, 30.107916],
    ],
  },
];

const DISTRICT = "SF-1";

interface TwelveRingsFixture {
  [parcelNodeId: string]: {
    district: string;
    coordinates: Array<[number, number]>;
  };
}

const rings = twelveLiveRings as TwelveRingsFixture;

const OPERATOR_TWELVE = [
  "48021:31299",
  "48021:31308",
  "48021:31317",
  "48021:31326",
  "48021:31335",
  "48021:31344",
  "48021:31353",
  "48021:31362",
  "48021:31371",
  "48021:31380",
  "48021:31389",
  "48021:31398",
];

/**
 * Parcels whose verify-pass is currently a KNOWN, diagnosed defect rather
 * than an open question — tracked as an EXPLICIT expected-fail (visible red
 * ledger, not a silent skip) rather than a hard assert, per the master
 * planner's 2026-08-06 direction on PR #268: land the six net-positive
 * fixes now, do not trade a partial notch-collapse patch for a designed
 * fix, and keep this harness as the acceptance suite so the commissioned
 * redesign flips these to hard-pass later.
 *
 * Defect reference: OFFSET-CORE-VARIABLE-DISTANCE — single-miter notch
 * collapse cannot resolve near-collinear runs adjacent to genuine corners;
 * redesign commissioned (variable-distance inward polygon offset, follow-on
 * branch from post-#268 main).
 *
 * Root cause (function-level evidence, see PR #268 description):
 * collapseNearCollinearOffsetNotches collapses a short offset-space run to
 * the analytic miter of its two bounding strip edges. On 48021:31362's real
 * ring this collapse spans a genuine ~89-degree ORIGINAL parcel corner
 * (verified: nearest original vertex turn angle +88.77deg), not
 * offset-math noise (compare the working 31308 fixture's 0.89deg
 * near-collinear vertex) — a genuine N-way constraint a 2-edge analytic
 * miter cannot resolve without cutting across unrelated real geometry
 * elsewhere in the ring. Two guards (near-parallel bounding-edge angle;
 * real-corner turn-angle scan) were built and independently verified to
 * fix 31362 in isolation, but each regressed 31308 elsewhere in this
 * harness's broader role/inset matrix — reverted rather than trade a known
 * green case for an unresolved one.
 *
 * - 31326, 31371, 31380, 31389: non-convex / R5 near-rect gate failure —
 *   the collapse this ring needs is rejected or produces a fold.
 * - 31299, 31362, 31371, 31380: "setbacks exceed the lot" empty candidate —
 *   the collapse that should preserve real area instead discards it;
 *   isInsetDegenerate correctly rejects the resulting ring rather than
 *   promote an unverified envelope (perEdgeOffsetPlausible fails on the far
 *   side of the discarded area, not at the collapse site itself).
 * (31371 and 31380 each fail BOTH ways depending on role/inset ordering —
 * listed once below, tracked under the same defect.)
 */
const KNOWN_DEFECT_OFFSET_CORE_VARIABLE_DISTANCE = new Set([
  "48021:31299",
  "48021:31326",
  "48021:31362",
  "48021:31371",
  "48021:31380",
  "48021:31389",
]);

describe("twelve-parcel LIVE pipeline integration harness (real rings, real roads, SF-1 F25/S5/R25/SC15)", () => {
  const results: Record<string, { pass: boolean; reasons: string[] }> = {};

  for (const parcelNodeId of OPERATOR_TWELVE) {
    const isKnownDefect = KNOWN_DEFECT_OFFSET_CORE_VARIABLE_DISTANCE.has(parcelNodeId);
    const title = isKnownDefect
      ? `${parcelNodeId}: labelEdgesFromRoads -> warmThenVerify -> verify-pass [EXPECTED FAIL — OFFSET-CORE-VARIABLE-DISTANCE, redesign commissioned]`
      : `${parcelNodeId}: labelEdgesFromRoads -> warmThenVerify -> verify-pass`;
    const itFn = isKnownDefect ? it.fails : it;
    itFn(title, async () => {
      const fixture = rings[parcelNodeId];
      expect(fixture, `no fixture ring for ${parcelNodeId}`).toBeDefined();
      const parcelRing: Ring = fixture!.coordinates as Ring;

      const descriptor = buildSf1Descriptor();

      // Same call the batch script makes before warmThenVerify.
      const labelResult = labelEdgesFromRoads({
        parcelRing,
        roads: ROADS,
        situsAddress: null,
      });

      if (!labelResult.ok) {
        results[parcelNodeId] = { pass: false, reasons: [`label declined: ${labelResult.decline}`] };
        throw new Error(`${parcelNodeId}: labelEdgesFromRoads declined (${labelResult.decline})`);
      }

      const result = await warmThenVerify({
        parcelNodeId,
        district: DISTRICT,
        parcelRing,
        descriptor,
        roads: ROADS,
        edgeLabels: labelResult.edgeLabels,
        zoningFactAtomDid: `did:hauska:zoning-fact:${parcelNodeId}`,
        promote: false,
        situsAddress: null,
      });

      const reasons = [
        ...result.verify.gates.geometry.reasons,
        ...result.verify.gates.roadClassification.reasons,
        ...result.verify.gates.setbackEdgeDistance.reasons,
        ...result.verify.gates.frontOrientation.reasons,
        ...result.verify.gates.r32PerEdgeInset.reasons,
        ...result.verify.gates.facesAnswer.reasons,
      ];
      results[parcelNodeId] = { pass: result.verify.pass, reasons };

      // Cross-check with the shared ground-truth predicate (P1 containment)
      // independent of mechanical verify, when a candidate envelope exists.
      if (!result.candidate.empty && result.candidate.insetRing) {
        const edgeRoles = new Map(result.candidate.edges.map((e) => [e.index, e.label]));
        const groundTruth = checkEnvelopeGroundTruth({
          parcelRing,
          envelopeRing: result.candidate.insetRing,
          descriptor,
          district: DISTRICT,
          roads: ROADS,
          edgeRoles,
        });
        if (!groundTruth.p1.pass) {
          reasons.push(`ground-truth P1 containment fail: ${JSON.stringify(groundTruth.p1)}`);
        }
      }

      expect(
        result.verify.pass,
        `${parcelNodeId} verify-fail reasons: ${JSON.stringify(reasons, null, 2)}\ncandidate.empty=${result.candidate.empty} emptyReason=${result.candidate.emptyReason}`,
      ).toBe(true);
    });
  }
});
