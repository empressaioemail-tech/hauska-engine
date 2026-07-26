/**
 * R3 warm-then-verify loop tests (27c WDLL 6 + WDLL 8 prep).
 */

import { describe, expect, it } from "vitest";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import type { Ring } from "../geometry.js";
import {
  PARCEL_714_SPRING_33512,
  PARCEL_BASTROP_47728,
} from "../fixtures/parcelRings.js";
import { edgeLabels714SpringHonest } from "../fixtures/edgeLabels714Spring.js";
import { emitDepthWarmPromotion } from "../promote.js";
import {
  DEPTH_WARM_PROMOTION_MARKER,
  DEPTH_WARM_SOURCE_CITATION,
} from "../types.js";
import { verifyWarmCandidateMechanically } from "../verify-mechanical.js";
import {
  computeWarmCandidate,
  injectBadWarmCandidate,
} from "../warm-compute.js";
import { warmThenVerify } from "../warm-then-verify.js";

const descriptor = bastropDescriptor as JurisdictionDescriptor;
const PARCEL_ID = "48021:33512";
const SPRING_ROAD = {
  osmWayId: 123456789,
  osmHighwayTag: "residential",
  name: "Spring Street",
  classification: "residential" as const,
  polyline: [
    [-97.3188, 30.1102],
    [-97.3182, 30.1105],
    [-97.3176, 30.1108],
  ] as [number, number][],
};

describe("depth-warm verify rejects bad warm (WDLL 6)", () => {
  it("geometry gate rejects parcel-as-inset inject", () => {
    const good = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    expect(good.empty).toBe(false);
    expect(good.insetRing).not.toBeNull();

    const bad = injectBadWarmCandidate(good);
    const verify = verifyWarmCandidateMechanically(bad, descriptor);
    expect(verify.pass).toBe(false);
    expect(verify.gates.geometry.pass).toBe(false);
    expect(verify.gates.geometry.reasons.length).toBeGreaterThan(0);
  });

  it("road classification gate rejects mismatched OSM tag", () => {
    const good = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    const tampered = {
      ...good,
      edges: good.edges.map((e) =>
        e.index === 0
          ? { ...e, roadClass: "alley" as const, osmHighwayTag: "residential" }
          : e,
      ),
    };
    const verify = verifyWarmCandidateMechanically(tampered, descriptor);
    expect(verify.pass).toBe(false);
    expect(verify.gates.roadClassification.pass).toBe(false);
  });

  it("service+unpaved surface passes verify as gravel (R4.2)", () => {
    const gravelService = {
      osmWayId: 15096758,
      osmHighwayTag: "service",
      surface: "unpaved",
      classification: "gravel" as const,
      polyline: [
        [-97.32, 30.11],
        [-97.319, 30.11],
      ] as [number, number][],
    };
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [gravelService],
      edgeLabels: [
        {
          index: 0,
          label: "front",
          roadClass: "gravel",
          osmHighwayTag: "service",
          osmSurfaceTag: "unpaved",
        },
      ],
    });
    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.gates.roadClassification.pass).toBe(true);
  });

  it("gravel front warm+verify pass at 15ft (R4.3)", () => {
    const ring: Ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const gravelService = {
      osmWayId: 15096758,
      osmHighwayTag: "service",
      surface: "unpaved",
      classification: "gravel" as const,
      polyline: [
        [-97.32, 30.11035],
        [-97.3197, 30.11035],
      ] as [number, number][],
    };
    const candidate = computeWarmCandidate({
      parcelNodeId: "48021:104985",
      district: "P-5",
      parcelRing: ring,
      descriptor,
      roads: [gravelService],
      edgeLabels: [
        {
          index: 0,
          label: "side",
        },
        {
          index: 1,
          label: "front",
          roadClass: "gravel",
          osmHighwayTag: "service",
          osmSurfaceTag: "unpaved",
        },
        { index: 2, label: "side" },
        { index: 3, label: "rear" },
      ],
    });
    expect(candidate.empty).toBe(false);
    const frontEdge = candidate.edges.find((e) => e.label === "front");
    expect(frontEdge?.insetFeet).toBe(15);
    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.pass).toBe(true);
  });
});

describe("depth-warm good warm promotes (WDLL 6 / WDLL 8)", () => {
  it("714 Spring warm → verify pass → emit depth-warm atoms", async () => {
    const result = await warmThenVerify({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
      promote: false,
    });

    expect(result.verify.pass).toBe(true);
    expect(result.candidate.empty).toBe(false);
    expect(result.candidate.edges.map((e) => e.insetFeet)).toEqual([
      0, 0, 0, 0, 0, 15,
    ]);
    const frontEdge = result.candidate.edges.find((e) => e.label === "front");
    expect(frontEdge?.insetFeet).toBe(15);
    for (const edge of result.candidate.edges.filter((e) => e.label !== "front")) {
      expect(edge.insetFeet).toBe(0);
    }

    expect(result.atoms).not.toBeNull();
    expect(result.atoms!.length).toBe(2);

    const envelope = result.atoms!.find((a) => a.entityType === "buildable-envelope");
    expect(envelope).toBeDefined();
    expect(envelope!.outcome?.kind).toBe("buildable");
    expect(envelope!.sourceCitation).toBe(DEPTH_WARM_SOURCE_CITATION);
    expect(
      (envelope as { depthWarmPromotion?: string }).depthWarmPromotion,
    ).toBe(DEPTH_WARM_PROMOTION_MARKER);
    expect(
      (envelope as { geojson?: { features: unknown[] } }).geojson?.features?.length,
    ).toBe(1);

    const setback = result.atoms!.find((a) => a.entityType === "setback-rule");
    expect(setback).toBeDefined();
    expect(setback!.front).toBe(15);
  });

  it("street front 15ft != alley rear 5ft on warm edges", () => {
    const ring: Ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const labels = [
      { index: 0, label: "front" as const, roadClass: "residential" as const, osmHighwayTag: "residential" },
      { index: 1, label: "side" as const },
      { index: 2, label: "rear" as const, roadClass: "alley" as const, osmHighwayTag: "service" },
      { index: 3, label: "side" as const },
    ];
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: ring,
      descriptor,
      roads: [
        SPRING_ROAD,
        {
          osmWayId: 999,
          osmHighwayTag: "service",
          classification: "alley",
          polyline: [
            [-97.3198, 30.11035],
            [-97.3197, 30.11035],
          ],
        },
      ],
      edgeLabels: labels,
    });
    const frontEdge = candidate.edges.find((e) => e.label === "front");
    const rearEdge = candidate.edges.find((e) => e.label === "rear");
    expect(frontEdge?.insetFeet).toBe(15);
    expect(rearEdge?.insetFeet).toBe(5);
    expect(frontEdge!.insetFeet).not.toBe(rearEdge!.insetFeet);

    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.pass).toBe(true);
  });
});

describe("honest partial inset (R4.1)", () => {
  it("47728: alley+front collapse retries to front-only inset", () => {
    const labels = [
      { index: 0, label: "rear" as const, roadClass: "alley" as const, osmHighwayTag: "service" },
      { index: 1, label: "front" as const, roadClass: "residential" as const, osmHighwayTag: "residential" },
      { index: 2, label: "side" as const },
      { index: 3, label: "side" as const },
    ];
    const candidate = computeWarmCandidate({
      parcelNodeId: "48021:47728",
      district: "P-5",
      parcelRing: PARCEL_BASTROP_47728,
      descriptor,
      roads: [],
      edgeLabels: labels,
    });
    expect(candidate.empty).toBe(false);
    expect(candidate.insetRing).not.toBeNull();
    expect(candidate.insetFeetPerEdge).toContain(15);
    expect(candidate.insetFeetPerEdge.filter((ft) => ft > 0).length).toBe(1);
    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.pass).toBe(true);
  });
});

describe("emitDepthWarmPromotion read-path marker", () => {
  it("stamps depth-warm citation for PE warm-read detection", () => {
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "P-5",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    const atoms = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
    });
    const env = atoms.find((a) => a.entityType === "buildable-envelope");
    expect(env?.sourceCitation).toContain("depth-warm-verified");
  });
});
