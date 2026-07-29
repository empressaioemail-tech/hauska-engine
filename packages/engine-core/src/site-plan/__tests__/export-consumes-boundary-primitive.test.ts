/**
 * RECONCILIATION GATE (2026-07-28 architecture directive): the site-plan
 * export CONSUMES the boundary primitive — the same stored per-edge
 * role/setback/inward-normal truth, through the same offset engine
 * (`insetPerEdgeFromPrimitive`) — that depth-warm consumes
 * (`computeWarmCandidateFromBoundary`). This gate runs BOTH computations on
 * the same parcel and asserts the SAME envelope: it passes because export and
 * depth-warm are literally one computation, not two per-edge paths patched to
 * agree.
 *
 * Fixtures:
 *  - gold parcel 48021:28286 (live TxGIO ring; boundary shape verified by the
 *    planner U2 pass: rear/side/front(ROW,15ft)/side_corner),
 *  - a 34177-shaped jog ring (rect with a 19 ft jog edge) — the ring class
 *    the retired export heuristic FALSE-degenerated on (unresolved-uniform-min
 *    fabricated the front value onto every edge, including the 19 ft jog)
 *    while depth-warm computed it fine.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";

import { computeWarmCandidateFromBoundary } from "../../boundary-primitive/consume.js";
import { ringAreaSqFt, type Ring } from "../../depth-warm/geometry.js";
import { PARCEL_28286_LIVE_TXGIO } from "../../depth-warm/fixtures/parcelRings.js";
import { boundaryEdgesToGeometryInput } from "../author.js";
import { composeSitePlanModel } from "../site-model.js";
import { boundaryAtomInstancesForRing, type BoundaryAtomSpec } from "./boundary-edge-fixture.js";

// ── shared fixture builders ──────────────────────────────────────────────

const DEM = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2,
    199.8, 200.2, 200.7, 201.0,
    199.5, 200.0, 200.4, 200.8,
    199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};

function bboxOf(ring: Ring) {
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  return {
    westLng: Math.min(...lngs),
    eastLng: Math.max(...lngs),
    southLat: Math.min(...lats),
    northLat: Math.max(...lats),
  };
}

/** Runs BOTH consumers on the same ring+edges and returns their envelopes. */
function reconcile(parcelNodeId: string, ring: Ring, atoms: BoundaryEdgeAtomInstance[]) {
  const warm = computeWarmCandidateFromBoundary({
    parcelNodeId,
    district: "P-3",
    parcelRing: ring,
    boundaryEdges: atoms,
  });

  const model = composeSitePlanModel({
    parcelNodeId,
    bbox: bboxOf(ring),
    ringWgs84: ring,
    dem: DEM,
    contourIntervalMeters: 0.5,
    setback: {
      front: 15,
      side: 0,
      rear: 0,
      sourceCodeAtomRef: { atomDid: "fixture/setback", role: "rule" },
    },
    boundaryEdges: boundaryEdgesToGeometryInput(atoms),
  });

  return { warm, model };
}

// ── gold parcel 48021:28286 (live TxGIO ring) ────────────────────────────

const GOLD_SPECS: BoundaryAtomSpec[] = [
  { role: "rear", adjacencyKind: "unmapped", absent: true },
  { role: "side", adjacencyKind: "neighbor-parcel", setbackFeet: 0 },
  { role: "front", adjacencyKind: "ROW", setbackFeet: 15 },
  { role: "side_corner", adjacencyKind: "ROW", setbackFeet: 0 },
];

// ── 34177-shaped jog ring: 100x160 ft rect with a 50x19 ft notch ─────────
// The 19 ft jog edge (x=50, y 160→141) is the short-edge artifact class that
// FALSE-degenerated through the retired export heuristic while depth-warm
// computed the same ring fine.

const BASE_LNG = -97.32;
const BASE_LAT = 30.1;
const DEG_PER_FT_LAT = 1 / 364000;
const DEG_PER_FT_LNG = 1 / (364000 * Math.cos((BASE_LAT * Math.PI) / 180));

function ftRing(pts: Array<[number, number]>): Ring {
  const ring = pts.map(
    ([x, y]) => [BASE_LNG + x * DEG_PER_FT_LNG, BASE_LAT + y * DEG_PER_FT_LAT] as [number, number],
  );
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

const JOG_RING_34177_SHAPE = ftRing([
  [0, 0],
  [100, 0],
  [100, 160],
  [50, 160],
  [50, 141], // ← the 19 ft jog edge follows this vertex
  [0, 141],
]);

const JOG_SPECS: BoundaryAtomSpec[] = [
  { role: "front", adjacencyKind: "ROW", setbackFeet: 15 },
  { role: "side", adjacencyKind: "neighbor-parcel", setbackFeet: 0 },
  { role: "rear", adjacencyKind: "unmapped", absent: true },
  { role: "rear", adjacencyKind: "unmapped", absent: true }, // 19 ft jog edge
  { role: "side", adjacencyKind: "neighbor-parcel", setbackFeet: 0 },
  { role: "side", adjacencyKind: "neighbor-parcel", setbackFeet: 0 },
];

describe("RECONCILIATION GATE — export consumes the boundary primitive (one envelope truth)", () => {
  it("gold 48021:28286: export envelope == depth-warm envelope (same computation)", () => {
    const atoms = boundaryAtomInstancesForRing("48021", "28286", PARCEL_28286_LIVE_TXGIO, GOLD_SPECS);
    const { warm, model } = reconcile("48021:28286", PARCEL_28286_LIVE_TXGIO, atoms);

    expect(warm.empty, warm.emptyReason).toBe(false);
    expect(model.setback.basis).toBe("boundary-primitive");
    expect(model.setback.degenerate).toBe(false);
    expect(model.summary.buildableAreaSqFt).not.toBeNull();

    // SAME envelope area (one computation; final CAD-frame projection only).
    const exportArea = model.summary.buildableAreaSqFt!;
    const warmArea = warm.buildableAreaSqFt!;
    expect(Math.abs(exportArea - warmArea) / warmArea).toBeLessThan(0.002);

    // SAME per-edge insets and roles.
    expect(model.setback.segments.map((s) => s.distanceFt)).toEqual(warm.insetFeetPerEdge);
    expect(model.setback.segments.map((s) => s.role)).toEqual(
      atoms.map((a) => a.role),
    );

    // Planner U3.1 envelope band for the gold shape (~7316 sqft).
    expect(exportArea).toBeGreaterThan(7000);
    expect(exportArea).toBeLessThan(7600);
  });

  it("34177-shaped jog ring: export path is NON-degenerate and equals depth-warm (false-degenerate class eliminated)", () => {
    const atoms = boundaryAtomInstancesForRing("48021", "34177shape", JOG_RING_34177_SHAPE, JOG_SPECS);
    const { warm, model } = reconcile("48021:34177shape", JOG_RING_34177_SHAPE, atoms);

    // Depth-warm computed this ring class fine on live (34177 → 16,046 sqft);
    // the export must agree, not false-degenerate on the 19 ft jog.
    expect(warm.empty, warm.emptyReason).toBe(false);
    expect(model.setback.basis).toBe("boundary-primitive");
    expect(model.setback.degenerate, model.setback.degenerateReason).toBe(false);
    expect(model.summary.buildableAreaSqFt).not.toBeNull();

    const exportArea = model.summary.buildableAreaSqFt!;
    const warmArea = warm.buildableAreaSqFt!;
    expect(Math.abs(exportArea - warmArea) / warmArea).toBeLessThan(0.002);

    // Front-only 15 ft on a 15,050 sqft lot: envelope ≈ lot − 100ft × 15ft.
    const lot = ringAreaSqFt(JOG_RING_34177_SHAPE);
    expect(lot).toBeGreaterThan(14_900);
    expect(lot).toBeLessThan(15_300);
    expect(exportArea).toBeGreaterThan(13_400);
    expect(exportArea).toBeLessThan(13_800);

    // Absence edges (incl. the jog) carry ZERO inset + provisional label —
    // never a fabricated value (2026-07-28 build-to-line ruling).
    expect(model.setback.segments[3]!.distanceFt).toBe(0);
    expect(model.setback.segments[3]!.notSpecified).toBe(true);
    expect(model.setback.primitiveEdgeAbsence).toBe(true);
    expect(model.summary.buildableAreaHonestNote).toMatch(/provisional/i);
  });

  it("genuine degeneracy stays detected through the shared engine (setbacks consume the jog lot)", () => {
    const consuming: BoundaryAtomSpec[] = JOG_SPECS.map((spec, i) =>
      i === 0 ? { ...spec, setbackFeet: 200 } : { role: spec.role, adjacencyKind: spec.adjacencyKind, setbackFeet: 100 },
    );
    const atoms = boundaryAtomInstancesForRing("48021", "34177shape", JOG_RING_34177_SHAPE, consuming);
    const { warm, model } = reconcile("48021:34177shape", JOG_RING_34177_SHAPE, atoms);

    // BOTH consumers refuse identically — one degeneracy verdict, not two.
    expect(warm.empty).toBe(true);
    expect(model.setback.degenerate).toBe(true);
    expect(model.setback.offsetRingLocal).toBeNull();
    expect(model.summary.buildableAreaSqFt).toBeNull();
  });
});
