/**
 * WDLL 7 / STEP 4: setback NUMBER from flat district table; road class must not
 * invent a different number. Front EDGE labeling still works via roads.
 * Bastrop descriptor setbackTable (SF-1 BDC rows) is STEP 3 ownership — this
 * suite uses a synthetic SF-1 fixture so STEP 4 can merge independently.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { resolveDistrictEdgeSetback } from "../../property-reasoning/resolve-road-class-setback.js";
import {
  buildFlatSetbackFallback,
  computeWarmCandidate,
  resolveInsetFeetForEdge,
} from "../warm-compute.js";
import type { Ring } from "../geometry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Synthetic SF-1 district: flat front=30; poison roadClassSetbackTable front=15 must lose. */
const SF1_DESCRIPTOR: JurisdictionDescriptor = {
  key: "synthetic_sf1",
  displayName: "Synthetic SF-1 (STEP 4 decouple fixture)",
  jurisdictionTenant: "test_sf1",
  parcelFips: "48021",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "test",
  sourceUrl: "test://wdll7",
  setbackTable: {
    rows: [
      {
        atom_did: "test/bdc/14.02.003",
        match_basis: "exact",
        district_code: "SF-1",
        front_ft: {
          value: 30,
          confidence: 0.95,
          verification_state: "human-verified",
        },
        side_ft: {
          value: 10,
          confidence: 0.95,
          verification_state: "human-verified",
        },
        rear_ft: {
          value: 20,
          confidence: 0.95,
          verification_state: "human-verified",
        },
        side_corner_ft: {
          value: 30,
          confidence: 0.95,
          verification_state: "human-verified",
        },
      },
    ],
  },
  // Poison: if any resolver still prefers road-class VALUES, front becomes 15.
  roadClassSetbackTable: {
    rows: [
      {
        atom_did: "test/poison/road-class",
        match_basis: "exact",
        district_code: "SF-1",
        entries: [
          {
            road_class: "residential",
            edge_role: "front",
            setback_ft: {
              value: 15,
              confidence: 0.99,
              verification_state: "transcribed",
            },
          },
          {
            road_class: "highway",
            edge_role: "front",
            setback_ft: {
              value: 99,
              confidence: 0.99,
              verification_state: "transcribed",
            },
          },
        ],
      },
    ],
  },
  assumedRowWidthFt: {
    highway: 100,
    major_collector: 60,
    minor_collector: 50,
    residential: 50,
    alley: 20,
    gravel: 30,
    unclassified: 40,
  },
};

const RECT: Ring = [
  [-97.32, 30.11],
  [-97.3195, 30.11],
  [-97.3195, 30.1104],
  [-97.32, 30.1104],
  [-97.32, 30.11],
];

describe("WDLL 7 road-setback VALUE decouple", () => {
  it("kills silent front:15 hardcode in buildFlatSetbackFallback source", () => {
    const src = readFileSync(join(__dirname, "../warm-compute.ts"), "utf8");
    // Exact legacy ternary / object literal — not prose mentions.
    expect(src).not.toMatch(/front:\s*"kind"\s+in\s+\w+\s*\?\s*15/);
    expect(src).not.toMatch(/\bfront:\s*15\b/);
    expect(src).toMatch(/"kind" in hit \? 0 : hit\.value/);
  });

  it("SF-1 flat front=30 wins over poison roadClassSetbackTable front=15", () => {
    const hit = resolveDistrictEdgeSetback(SF1_DESCRIPTOR, "SF-1", "front");
    if ("kind" in hit) throw new Error("expected setback");
    expect(hit.value).toBe(30);

    const flat = buildFlatSetbackFallback(SF1_DESCRIPTOR, "SF-1");
    expect(flat.front).toBe(30);
    expect(flat.side).toBe(10);
    expect(flat.rear).toBe(20);
    expect(flat.sideCorner).toBe(30);

    const highwayFront = resolveInsetFeetForEdge(
      SF1_DESCRIPTOR,
      "SF-1",
      { label: "front", roadClass: "highway" },
      flat,
    );
    expect(highwayFront).toBe(30);
    expect(highwayFront).not.toBe(15);
    expect(highwayFront).not.toBe(99);
  });

  it("missing district does not invent front:15", () => {
    const flat = buildFlatSetbackFallback(SF1_DESCRIPTOR, "NO-SUCH-DISTRICT");
    expect(flat.front).toBe(0);
    expect(flat.side).toBe(0);
    expect(flat.rear).toBe(0);
  });

  it("warm-compute applies flat front=30; front EDGE labeling still works", () => {
    const road = {
      osmWayId: 1,
      osmHighwayTag: "residential",
      name: "Jefferson St",
      classification: "residential" as const,
      polyline: [
        [-97.3202, 30.11],
        [-97.3193, 30.11],
      ] as [number, number][],
    };
    const candidate = computeWarmCandidate({
      parcelNodeId: "48021:test-sf1",
      district: "SF-1",
      parcelRing: RECT,
      descriptor: SF1_DESCRIPTOR,
      roads: [road],
      edgeLabels: [
        {
          index: 0,
          label: "front",
          roadClass: "residential",
          osmHighwayTag: "residential",
        },
        { index: 1, label: "side", roadClass: "residential" },
        { index: 2, label: "rear" },
        { index: 3, label: "side" },
      ],
    });

    const front = candidate.edges.find((e) => e.label === "front");
    expect(front).toBeDefined();
    expect(front!.insetFeet).toBe(30);
    expect(front!.roadClass).toBe("residential");
    expect(candidate.edges.find((e) => e.label === "side")?.insetFeet).toBe(10);
    expect(candidate.edges.find((e) => e.label === "rear")?.insetFeet).toBe(20);
  });
});
