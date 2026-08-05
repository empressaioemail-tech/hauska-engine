/**
 * 2026-08-05 edge-role defect family fix — regression coverage for
 * `prepareBoundaryEdgesForExport`.
 *
 * ROOT CAUSE (verified): `composeSitePlanModelForParcel` loaded stored
 * property-boundary-edge atoms and mapped them by `edgeIndex` WITHOUT the
 * cert-grade path's R28 (`primitiveNormalsAgreeWithRing` +
 * `recomputeBoundaryEdgesForRing`) or R30 (`labelEdgesFromRoads` +
 * `relabelBoundaryEdgesFromRoadLabels`) freshness gates. Stale boundary edges
 * (descriptor-fixture, 2026-07-29) carried wrong setback feet (15/0/0 vs the
 * card's F25/S5/R25); a ring-winding mismatch could put the front role on the
 * wrong physical edge in the exported PDF.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance, SetbackRuleAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

import { computeParcelInteriorFacts } from "../../boundary-primitive/interior.js";
import { primitiveNormalsAgreeWithRing } from "../../boundary-primitive/recompute-for-ring.js";
import type { Ring } from "../../depth-warm/geometry.js";
import type { WarmRoadSource } from "../../depth-warm/types.js";
import { prepareBoundaryEdgesForExport } from "../prepare-boundary-edges-for-export.js";
import { boundaryEdgesToGeometryInput } from "../author.js";
import { composeSitePlanModel } from "../site-model.js";

// ── shared fixture builders ──────────────────────────────────────────────

const BASTROP_COUNTY_FIPS = "48021";
const BASE_LNG = -97.32;
const BASE_LAT = 30.1;
const DEG_PER_FT_LAT = 1 / 364000;
const DEG_PER_FT_LNG = 1 / (364000 * Math.cos((BASE_LAT * Math.PI) / 180));

/** Convert a closed ft-space polygon (first point repeated) to a WGS84 ring. */
function ftRing(pts: Array<[number, number]>): Ring {
  const ring = pts.map(
    ([x, y]) => [BASE_LNG + x * DEG_PER_FT_LNG, BASE_LAT + y * DEG_PER_FT_LAT] as [number, number],
  );
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/** Convert an open ft-space polyline to a WGS84 polyline (roads — not closed). */
function ftLine(pts: Array<[number, number]>): Array<[number, number]> {
  return pts.map(([x, y]) => [BASE_LNG + x * DEG_PER_FT_LNG, BASE_LAT + y * DEG_PER_FT_LAT]);
}

interface StoredEdgeSpec {
  role: BoundaryEdgeAtomInstance["role"];
  feet?: number;
  absent?: boolean;
}

/** Build stored (possibly stale) boundary-edge atoms against `ring`. */
function buildStoredEdges(
  ring: Ring,
  countyFips: string,
  propId: string,
  specs: ReadonlyArray<StoredEdgeSpec>,
  opts?: { sourceAdapter?: string; jurisdictionTenant?: string },
): BoundaryEdgeAtomInstance[] {
  const facts = computeParcelInteriorFacts(ring)!;
  if (facts.edges.length !== specs.length) {
    throw new Error(`spec count ${specs.length} != ring edge count ${facts.edges.length}`);
  }
  const sourceAdapter = opts?.sourceAdapter ?? "test";
  const jurisdictionTenant = opts?.jurisdictionTenant ?? "bastrop-city-tx";
  return specs.map((spec, i) => {
    const edgeInterior = facts.edges.find((e) => e.edgeIndex === i)!;
    const boundaryEdgeId = `${countyFips}:${propId}:boundary:${i}`;
    return {
      entityType: "property-boundary-edge",
      atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: `${countyFips}:${propId}`,
      countyFips,
      propId,
      edgeIndex: i,
      role: spec.role,
      adjacencyKind: "ROW",
      parcelNeighborPropId: null,
      facingRoad: null,
      setback: spec.absent
        ? { kind: "no-setback-row" as const, reason: "fixture: stale/unresolved" }
        : { feet: spec.feet ?? 0, provenance: "stale-fixture", atomCitation: "test" },
      interior: {
        ringCcw: edgeInterior.ringCcw,
        centroidInside: edgeInterior.centroidInside,
        inwardNormal: edgeInterior.inwardNormal,
        edgeEndpoints: edgeInterior.edgeEndpoints,
      },
      effectiveDate: "2026-07-29",
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy: "platform-internal",
      sourceCitation: "test fixture",
      extractedAt: "2026-07-29T00:00:00.000Z",
      atomTier: "data",
      jurisdictionTenant,
      fetchedAt: "2026-07-29T00:00:00.000Z",
      sourceAdapter,
      sourceUrl: "test://",
      contentHash: "fixture",
    } satisfies BoundaryEdgeAtomInstance;
  });
}

function sf1SetbackRule(parcelNodeId: string): SetbackRuleAtomInstance & { sourceCodeAtomRef: { atomDid: string } } {
  return {
    entityType: "setback-rule",
    atomDid: `bastrop-tx/setback/${parcelNodeId}/1`,
    entityId: `${parcelNodeId}:setback:1`,
    jurisdictionTenant: "bastrop-city-tx",
    parcelNodeId,
    fetchedAt: new Date().toISOString(),
    extractedAt: new Date().toISOString(),
    sourceAdapter: "bastrop-per-parcel-record-layer-23",
    sourceUrl: "https://bastrop-tx.example/layer-23",
    sourceCitation: "SF-1 per-parcel setback record (layer 23)",
    accessPolicy: "platform-internal",
    atomTier: "data",
    status: "active",
    districtCode: "SF-1",
    front: 25,
    side: 5,
    sideInteriorFt: 5,
    sideCornerFt: 10,
    rear: 25,
    sourceCodeAtomRef: { atomDid: "bastrop-tx/layer-23/SF-1" },
  } as unknown as SetbackRuleAtomInstance & { sourceCodeAtomRef: { atomDid: string } };
}

function feetOf(edge: BoundaryEdgeAtomInstance): number | "absent" {
  return "kind" in edge.setback ? "absent" : edge.setback.feet;
}

// ── Fixture 1: mid-block rectangular lot on Higgins St ──────────────────
// 100ft (E-W) x 60ft (N-S) rectangle; south edge (index 0) fronts Higgins.
// Depth kept inside the road-proximity threshold (25 m / ~82 ft) so the
// rear edge is unambiguously the farthest road-adjacent edge from front —
// a lot deeper than that needs a rear-anchoring road (alley), covered by
// the flag-lot fixture below.

const RECT_RING = ftRing([
  [0, 0],
  [100, 0],
  [100, 60],
  [0, 60],
]);
// edge0: south (front) · edge1: east (side) · edge2: north (rear) · edge3: west (side)

const HIGGINS_ST: WarmRoadSource = {
  osmWayId: 500001,
  osmHighwayTag: "residential",
  name: "Higgins Street",
  classification: "residential",
  polyline: ftLine([
    [-500, 0],
    [600, 0],
  ]),
};

// ── Fixture 2: flag-lot shape (narrow front-street neck + wide rear body
// backing to an alley — the 80577/80578 defect class: representative
// synthetic geometry, since the live TxGIO/BCAD ring for those parcels is
// not available outside the production spine). ────────────────────────────

const FLAG_LOT_RING = ftRing([
  [0, 0],
  [20, 0],
  [20, 20],
  [80, 20],
  [80, 120],
  [0, 120],
]);
// edge0: neck front (street) · edge1: side · edge2: side (jog/shoulder)
// edge3: side · edge4: rear (backs to alley) · edge5: side

const MESQUITE_LN: WarmRoadSource = {
  osmWayId: 500002,
  osmHighwayTag: "residential",
  name: "Mesquite Lane",
  classification: "residential",
  polyline: ftLine([
    [-500, 0],
    [600, 0],
  ]),
};

const REAR_ALLEY: WarmRoadSource = {
  osmWayId: 500003,
  osmHighwayTag: "service",
  name: undefined,
  classification: "alley",
  polyline: ftLine([
    [-500, 120],
    [600, 120],
  ]),
};

describe("prepareBoundaryEdgesForExport — R28/R30 freshness + setback-value refresh", () => {
  it("mid-block rectangular lot: Higgins St wins front via situs match; SF-1 F25/S5/R25 applied (never stale 15/0/0)", async () => {
    const parcelNodeId = `${BASTROP_COUNTY_FIPS}:70001`;

    // Stale primitive (descriptor-fixture, 2026-07-29 class): front role
    // wrongly stored on the NORTH edge (index 2) with the retired 15/0/0
    // scalar pattern instead of the card's F25/S5/R25.
    const stale = buildStoredEdges(
      RECT_RING,
      BASTROP_COUNTY_FIPS,
      "70001",
      [
        { role: "side", feet: 0 },
        { role: "side", feet: 0 },
        { role: "front", feet: 15 },
        { role: "rear", feet: 0 },
      ],
      { sourceAdapter: "descriptor-fixture" },
    );

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId,
      storedEdges: stale,
      ringWgs84: RECT_RING,
      roads: [HIGGINS_ST],
      situsAddress: "123 HIGGINS ST , BASTROP, TX 78602",
      setback: sf1SetbackRule(parcelNodeId),
      notSpecified: null,
    });

    expect(result.reason).toBeUndefined();
    expect(result.edges).not.toBeNull();
    expect(result.relabeledFromRoads).toBe(true);
    expect(result.setbackValuesRefreshed).toBe(true);

    const edges = result.edges!;
    const front = edges.find((e) => e.role === "front")!;
    const rear = edges.find((e) => e.role === "rear")!;
    const sides = edges.filter((e) => e.role === "side");

    // The physically-south edge (index 0, adjacent to Higgins St) wins front —
    // not the stale north edge (index 2) the descriptor-fixture had stored.
    expect(front.edgeIndex).toBe(0);
    expect(rear.edgeIndex).toBe(2);
    expect(sides.map((e) => e.edgeIndex).sort()).toEqual([1, 3]);

    // Authoritative SF-1 values from the setback-rule atom — never the stale
    // 15/0/0 scalar the descriptor-fixture primitive carried.
    expect(feetOf(front)).toBe(25);
    expect(feetOf(rear)).toBe(25);
    for (const side of sides) {
      expect(feetOf(side)).toBe(5);
    }
  });

  it("flag lot (80577/80578-class shape): side vs rear roles correct after relabel", async () => {
    const parcelNodeId = `${BASTROP_COUNTY_FIPS}:80577`;

    // Stale primitive: the jog/shoulder edge (index 2) wrongly stored as
    // rear, and the true rear (index 4, backs to the alley) wrongly stored
    // as side — the exact role-swap class this fix targets.
    const stale = buildStoredEdges(
      FLAG_LOT_RING,
      BASTROP_COUNTY_FIPS,
      "80577",
      [
        { role: "side", feet: 0 },
        { role: "side", feet: 0 },
        { role: "rear", feet: 0 }, // stale: jog mislabeled rear
        { role: "side", feet: 0 },
        { role: "side", feet: 0 }, // stale: true rear mislabeled side
        { role: "side", feet: 0 },
      ],
      { sourceAdapter: "descriptor-fixture" },
    );

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId,
      storedEdges: stale,
      ringWgs84: FLAG_LOT_RING,
      roads: [MESQUITE_LN, REAR_ALLEY],
      situsAddress: "500 MESQUITE LN , BASTROP, TX 78602",
      setback: null,
      notSpecified: null,
    });

    expect(result.edges).not.toBeNull();
    expect(result.relabeledFromRoads).toBe(true);

    const edges = result.edges!;
    expect(edges.find((e) => e.edgeIndex === 0)!.role).toBe("front");
    expect(edges.find((e) => e.edgeIndex === 4)!.role).toBe("rear");
    for (const i of [1, 2, 3, 5]) {
      expect(edges.find((e) => e.edgeIndex === i)!.role, `edge ${i}`).toBe("side");
    }
  });

  it("ring winding reversal: stored front remapped to the correct physical edge (R28 recompute)", async () => {
    const parcelNodeId = `${BASTROP_COUNTY_FIPS}:90001`;

    const RING_CCW: Ring = [
      [-97.31, 30.11],
      [-97.3097, 30.11],
      [-97.3097, 30.1103],
      [-97.31, 30.1103],
      [-97.31, 30.11],
    ];
    /** Same physical square, opposite winding — the "swapped BCAD ring" class. */
    const RING_CW: Ring = [...RING_CCW].reverse();

    const storedAgainstCcw = buildStoredEdges(RING_CCW, BASTROP_COUNTY_FIPS, "90001", [
      { role: "front", feet: 20 },
      { role: "side", feet: 5 },
      { role: "rear", feet: 20 },
      { role: "side", feet: 5 },
    ]);
    const storedFront = storedAgainstCcw.find((e) => e.role === "front")!;

    // Prove the "before" defect: applying the CCW-built primitive straight
    // onto the swapped (CW) ring by edgeIndex disagrees on normals — this is
    // exactly the state the export previously served without recomputing.
    expect(primitiveNormalsAgreeWithRing(storedAgainstCcw, RING_CW).ok).toBe(false);

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId,
      storedEdges: storedAgainstCcw,
      ringWgs84: RING_CW,
      roads: [],
      situsAddress: null,
      setback: null,
      notSpecified: null,
    });

    expect(result.reason).toBeUndefined();
    expect(result.edges).not.toBeNull();
    expect(result.recomputedForRingWinding).toBe(true);

    const rebuiltFront = result.edges!.find((e) => e.role === "front")!;
    // The front role now sits on whichever new edge is physically the SAME
    // edge (inward normal parallel to the ORIGINAL stored front edge),
    // rather than staying pinned to the stale edgeIndex.
    const dot =
      storedFront.interior.inwardNormal.x * rebuiltFront.interior.inwardNormal.x +
      storedFront.interior.inwardNormal.y * rebuiltFront.interior.inwardNormal.y;
    expect(dot).toBeGreaterThan(0.9);

    // The rebuilt primitive is now internally consistent with the ring it
    // will actually be inset against.
    expect(primitiveNormalsAgreeWithRing(result.edges!, RING_CW).ok).toBe(true);
  });

  it("honest absence: not_specified side axis stays an absence, never a fabricated SIDE 0'", async () => {
    const parcelNodeId = `${BASTROP_COUNTY_FIPS}:70099`;

    const stale = buildStoredEdges(
      RECT_RING,
      BASTROP_COUNTY_FIPS,
      "70099",
      [
        { role: "front", feet: 15 },
        { role: "side", feet: 0 },
        { role: "rear", feet: 0 },
        { role: "side", feet: 0 },
      ],
      { sourceAdapter: "descriptor-fixture" },
    );

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId,
      storedEdges: stale,
      ringWgs84: RECT_RING,
      roads: [HIGGINS_ST],
      situsAddress: "123 HIGGINS ST , BASTROP, TX 78602",
      setback: sf1SetbackRule(parcelNodeId),
      notSpecified: { side: true },
    });

    expect(result.setbackValuesRefreshed).toBe(true);
    const edges = result.edges!;
    const front = edges.find((e) => e.role === "front")!;
    const rear = edges.find((e) => e.role === "rear")!;
    const sides = edges.filter((e) => e.role === "side");

    // Specified axes still get their authoritative values.
    expect(feetOf(front)).toBe(25);
    expect(feetOf(rear)).toBe(25);
    // The silent (not_specified) side axis is an honest absence, not 0 ft.
    for (const side of sides) {
      expect(feetOf(side)).toBe("absent");
    }

    // Prove the DOWNSTREAM geometry consumer renders this as
    // `segment.notSpecified`, never a fabricated "SIDE 0'" line.
    const geometryInput = boundaryEdgesToGeometryInput(edges);
    for (const g of geometryInput.filter((e) => e.role === "side")) {
      expect(g.setbackAbsent).toBe(true);
      expect(g.insetFeet).toBe(0);
    }

    const DEM = {
      width: 2,
      height: 2,
      values: new Float32Array([200, 200, 200, 200]),
      minElevation: 200,
      maxElevation: 200,
      nodataCount: 0,
    };
    const bbox = {
      westLng: Math.min(...RECT_RING.map(([lng]) => lng)),
      eastLng: Math.max(...RECT_RING.map(([lng]) => lng)),
      southLat: Math.min(...RECT_RING.map(([, lat]) => lat)),
      northLat: Math.max(...RECT_RING.map(([, lat]) => lat)),
    };
    const model = composeSitePlanModel({
      parcelNodeId,
      bbox,
      ringWgs84: RECT_RING,
      dem: DEM,
      contourIntervalMeters: 1,
      setback: {
        front: 25,
        side: 5,
        rear: 25,
        sourceCodeAtomRef: { atomDid: "bastrop-tx/layer-23/SF-1", role: "rule" },
      },
      boundaryEdges: geometryInput,
    });

    const sideSegments = model.setback.segments.filter((s) => s.role === "side");
    expect(sideSegments.length).toBeGreaterThan(0);
    for (const seg of sideSegments) {
      expect(seg.notSpecified).toBe(true);
      expect(seg.distanceFt).toBe(0);
    }
    const frontSegment = model.setback.segments.find((s) => s.role === "front")!;
    expect(frontSegment.notSpecified).toBeUndefined();
    expect(frontSegment.distanceFt).toBe(25);
  });
});
