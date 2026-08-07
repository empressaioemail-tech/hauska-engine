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
 * side_corner).
 *
 * 2026-08-07 UPDATE (final round, coordinate-keyed acceptance): a verified
 * situs address roster (from the live txgio_parcel read done under the
 * arbitration dump, cross-checked coordinate-by-coordinate against the
 * auditor's independent rebuild) is now embedded per-parcel in
 * fixtures/twelve-live-rings.json for the four parcels where it was
 * needed to close the role-inversion gap (31317, 31326, 31362, 31389).
 * The harness reads fixture.situsAddress ?? null per parcel, so those four
 * now run the situs-match path instead of the adjacency-heuristic
 * fallback; the other eight parcels (no verified situs available) still
 * run the adjacency-heuristic path exactly as before — no fabricated data.
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
    situsAddress?: string;
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

describe("twelve-parcel LIVE pipeline integration harness (real rings, real roads, SF-1 F25/S5/R25/SC15)", () => {
  const results: Record<string, { pass: boolean; reasons: string[] }> = {};

  for (const parcelNodeId of OPERATOR_TWELVE) {
    it(`${parcelNodeId}: labelEdgesFromRoads -> warmThenVerify -> verify-pass`, async () => {
      const fixture = rings[parcelNodeId];
      expect(fixture, `no fixture ring for ${parcelNodeId}`).toBeDefined();
      const parcelRing: Ring = fixture!.coordinates as Ring;
      const situsAddress = fixture!.situsAddress ?? null;

      const descriptor = buildSf1Descriptor();

      // Same call the batch script makes before warmThenVerify.
      const labelResult = labelEdgesFromRoads({
        parcelRing,
        roads: ROADS,
        situsAddress,
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
        situsAddress,
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

      expect(
        result.verify.pass,
        `${parcelNodeId} verify-fail reasons: ${JSON.stringify(reasons, null, 2)}\ncandidate.empty=${result.candidate.empty} emptyReason=${result.candidate.emptyReason}`,
      ).toBe(true);

      // GROUND-TRUTH FRAME LAW (2026-08-07, master planner ruling) — the
      // full shared predicate (P1 containment, P2 inset distance, P3
      // front-on-street), measured against fixture.coordinates AS STORED
      // (the raw, unscrubbed txgio ring — this fixture has never been
      // scrubbed; 31299 in particular carries its full real 6-vertex/5-edge
      // ring including the true 2.428m/7.97ft jog edge). edgeRoles is
      // deliberately omitted (see promote.ts's identical reasoning) so P2's
      // role resolution comes from a FRESH labelEdgesFromRoads call on this
      // exact ring, never an index carried over from a different frame.
      // This is a hard assertion, not an informational cross-check: the
      // acceptance bar per the master planner's final ruling is the served
      // envelope must clear ground truth against the RAW ring, not merely
      // pass mechanical verify against whatever ring computed it.
      if (!result.candidate.empty && result.candidate.insetRing) {
        const groundTruth = checkEnvelopeGroundTruth({
          parcelRing,
          envelopeRing: result.candidate.insetRing,
          descriptor,
          district: DISTRICT,
          roads: ROADS,
          situsAddress,
          // Honor genuine notch-collapse absences (e.g. 48021:31308's real
          // 9.09ft corner-jog edge folded into a miter join) — see
          // envelope-ground-truth.ts's checkInsetDistances doc comment.
          miterPointsWgs84: result.candidate.miterPointsWgs84,
        });
        expect(
          groundTruth.pass,
          `${parcelNodeId} ground-truth (RAW ring) fail: ${JSON.stringify(
            {
              failureReason: groundTruth.failureReason,
              p1: groundTruth.p1,
              p2Fails: groundTruth.p2.edges.filter((e) => !e.pass),
              p3: groundTruth.p3,
            },
            null,
            2,
          )}`,
        ).toBe(true);
      }
    });
  }
});
