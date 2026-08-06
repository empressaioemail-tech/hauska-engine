/**
 * R3 warm-then-verify loop tests (27c WDLL 6 + WDLL 8 prep).
 * Post BDC STEP 3 + WDLL 7: districts are SF-x/RR; inset NUMBERS from flat table.
 */

import { describe, expect, it } from "vitest";

import { getSetbackTable } from "@hauska-engine/adapters";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { scrubLotLineRing } from "../../boundary-primitive/lot-line-scrub.js";
import { setbackTableDescriptorFromAdapter } from "../../property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import type { Ring } from "../geometry.js";
import {
  labelEdgesFromRoads,
} from "../edgeLabeling.js";
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

/** SURVIVOR overlay: adapter BDC setbackTable (WDLL STEP 3 dual-fork kill). */
function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  if (!adapterSetback) {
    throw new Error("bastrop-development-code adapter table required");
  }
  const base = bastropDescriptor as JurisdictionDescriptor;
  return {
    ...base,
    setbackTable: adapterSetback,
  };
}

const descriptor = buildDescriptor();
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
      district: "SF-1",
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
      district: "SF-1",
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
      district: "SF-1",
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

  it("gravel front warm+verify pass at 30ft SF-1 (BDC / WDLL 7)", () => {
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
    const freshLabels = labelEdgesFromRoads({
      parcelRing: ring,
      roads: [gravelService],
    });
    expect(freshLabels.ok).toBe(true);
    if (!freshLabels.ok) return;
    const candidate = computeWarmCandidate({
      parcelNodeId: "48021:104985",
      district: "SF-1",
      parcelRing: ring,
      descriptor,
      roads: [gravelService],
      edgeLabels: freshLabels.edgeLabels,
    });
    expect(candidate.empty).toBe(false);
    const frontEdge = candidate.edges.find((e) => e.label === "front");
    expect(frontEdge?.insetFeet).toBe(30);
    const verify = verifyWarmCandidateMechanically(candidate, descriptor, {
      roads: [gravelService],
    });
    expect(verify.pass).toBe(true);
  });
});

describe("depth-warm good warm promotes (WDLL 6 / WDLL 8)", () => {
  it("714 Spring warm → verify pass → emit depth-warm atoms", async () => {
    // R5 near-rect gate (added 6849e34) correctly rejects a NON-CONVEX inset.
    // The raw PARCEL_714_SPRING_33512 capture is a clean rectangle whose WEST
    // boundary carries collinear sub-survey micro-vertices (v3/v4 turn ~0°),
    // splitting one straight lot line into three segments. With rear-labeled
    // (30ft) and side-labeled (10ft) roles landing on that single straight run,
    // the inset develops a re-entrant 20ft step → a non-convex notch the R5 gate
    // rightly fails. The PRODUCTION warm path scrubs the ring first
    // (scrubLotLineRing, per depth-warm-bastrop-batch.mjs) BEFORE warmThenVerify;
    // this test previously skipped that step, so its verify.pass=true expectation
    // went stale when R5 landed. Scrub here to exercise the real production
    // geometry: scrubbing collapses the collinear west run 6→4 vertices, yielding
    // a convex envelope that passes. Labels reflect the 4-edge topology:
    // south=front (Spring St), north=rear, east/west=side.
    const scrubbedRing = scrubLotLineRing(PARCEL_714_SPRING_33512);
    const scrubbedLabels = [
      { index: 0, label: "side" as const },
      { index: 1, label: "rear" as const },
      { index: 2, label: "side" as const },
      {
        index: 3,
        label: "front" as const,
        roadClass: "residential" as const,
        osmHighwayTag: "residential",
      },
    ];
    const result = await warmThenVerify({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: scrubbedRing,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: scrubbedLabels,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
      promote: false,
    });

    expect(result.verify.pass).toBe(true);
    expect(result.candidate.empty).toBe(false);
    const frontEdge = result.candidate.edges.find((e) => e.label === "front");
    expect(frontEdge?.insetFeet).toBe(30);
    for (const edge of result.candidate.edges.filter((e) => e.label === "side")) {
      expect(edge.insetFeet).toBe(10);
    }
    for (const edge of result.candidate.edges.filter((e) => e.label === "rear")) {
      expect(edge.insetFeet).toBe(30);
    }

    expect(result.atoms).not.toBeNull();
    expect(result.atoms!.boundaryEdges.length).toBeGreaterThan(0);
    expect(result.atoms!.propertyAtoms.filter((a) => a.entityType === "setback-rule")).toHaveLength(1);
    expect(result.atoms!.propertyAtoms.filter((a) => a.entityType === "buildable-envelope")).toHaveLength(1);

    const envelope = result.atoms!.propertyAtoms.find((a) => a.entityType === "buildable-envelope");
    expect(envelope).toBeDefined();
    expect(envelope!.outcome?.kind).toBe("buildable");
    expect(envelope!.sourceCitation).toBe(DEPTH_WARM_SOURCE_CITATION);
    expect(
      (envelope as { depthWarmPromotion?: string }).depthWarmPromotion,
    ).toBe(DEPTH_WARM_PROMOTION_MARKER);
    expect(
      (envelope as { geojson?: { features: unknown[] } }).geojson?.features?.length,
    ).toBe(1);

    const setback = result.atoms!.propertyAtoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toBeDefined();
    expect(setback!.front).toBe(30);
  });

  it("street front 30ft; alley rear uses flat rear 30 (WDLL 7, no invented alley feet)", () => {
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
      district: "SF-1",
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
    // WDLL 7: NUMBER from flat SF-1 table (30/10/20/30). Alley labels the rear EDGE only.
    expect(frontEdge?.insetFeet).toBe(30);
    expect(rearEdge?.insetFeet).toBe(30);
    expect(rearEdge?.roadClass).toBe("alley");

    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.gates.setbackEdgeDistance.pass).toBe(true);
  });
});

describe("honest partial inset (R4.1)", () => {
  it("47728: alley+front draws (PATCH-A); contains front 30' SF-1 and verifies", () => {
    const labels = [
      { index: 0, label: "rear" as const, roadClass: "alley" as const, osmHighwayTag: "service" },
      { index: 1, label: "front" as const, roadClass: "residential" as const, osmHighwayTag: "residential" },
      { index: 2, label: "side" as const },
      { index: 3, label: "side" as const },
    ];
    const candidate = computeWarmCandidate({
      parcelNodeId: "48021:47728",
      district: "SF-1",
      parcelRing: PARCEL_BASTROP_47728,
      descriptor,
      roads: [],
      edgeLabels: labels,
    });
    expect(candidate.empty).toBe(false);
    expect(candidate.insetRing).not.toBeNull();
    expect(candidate.insetFeetPerEdge).toContain(30);
    expect(candidate.insetFeetPerEdge.filter((ft) => ft > 0).length).toBeGreaterThanOrEqual(1);
    const verify = verifyWarmCandidateMechanically(candidate, descriptor);
    expect(verify.pass).toBe(true);
  });
});

describe("emitDepthWarmPromotion read-path marker", () => {
  it("stamps depth-warm citation for PE warm-read detection", () => {
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    const emitted = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
    });
    const env = emitted.propertyAtoms.find((a) => a.entityType === "buildable-envelope");
    expect(env?.sourceCitation).toContain("depth-warm-verified");
  });
});

describe("emitDepthWarmPromotion boundary-edge persist (WS1 Option A)", () => {
  it("writes boundary-edge atoms whose roles match warm verify labels (conclusion-string gate)", () => {
    const edgeLabels = edgeLabels714SpringHonest();
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels,
    });

    const emitted = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
    });
    const boundaryEdges = emitted.boundaryEdges;
    expect(boundaryEdges.length).toBe(candidate.parcelRing.length - 1);

    for (const warmEdge of candidate.edges) {
      const atom = boundaryEdges.find((b) => b.edgeIndex === warmEdge.index);
      expect(atom?.role).toBe(warmEdge.label);
    }

    expect(boundaryEdges.every((e) => e.sourceAdapter === "depth-warm-verify-promote")).toBe(true);
    expect(boundaryEdges.every((e) => e.sourceCitation.includes(DEPTH_WARM_PROMOTION_MARKER))).toBe(
      true,
    );
  });
});
