/**
 * R28 — recompute boundary primitive against a swapped (reversed-winding) ring.
 *
 * Reproduces the BCAD-swap failure class: the stored primitive is built against
 * one ring; a same-vertex-count ring with the OPPOSITE winding is swapped in.
 * Applying stored normals by edgeIndex lands them on the wrong edges → the
 * offset never closes → inset null. Recomputing the primitive against the
 * swapped ring restores a valid envelope with roles re-indexed to the new edges.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

import { computeParcelInteriorFacts } from "../interior.js";
import {
  NORMAL_AGREEMENT_DOT_MIN,
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../recompute-for-ring.js";
import { computeWarmCandidateFromBoundary } from "../consume.js";
import type { Ring } from "../../depth-warm/geometry.js";

const COUNTY_FIPS = "48021";
const PROP = "99999";
const PARCEL_NODE_ID = `${COUNTY_FIPS}:${PROP}`;

/**
 * ~30m x 30m square near Bastrop, CCW in lng/lat. Edges (CCW):
 *   0 bottom (inward +y / north), 1 right (inward -x / west),
 *   2 top (inward -y / south),   3 left (inward +x / east).
 */
const RING_CCW: Ring = [
  [-97.31, 30.11],
  [-97.3097, 30.11],
  [-97.3097, 30.1103],
  [-97.31, 30.1103],
  [-97.31, 30.11],
];

/** Same square, REVERSED winding (CW) — the "swapped BCAD ring" analog. */
const RING_CW: Ring = [...RING_CCW].reverse();

function roleFor(index: number): BoundaryEdgeAtomInstance["role"] {
  // bottom=front, top=rear, sides=side (arbitrary but distinct).
  if (index === 0) return "front";
  if (index === 2) return "rear";
  return "side";
}

function setbackFor(role: BoundaryEdgeAtomInstance["role"]): number {
  if (role === "front") return 20;
  if (role === "rear") return 20;
  return 5;
}

/** Build stored boundary atoms against a given ring (normals from that ring). */
function buildStoredEdges(ring: Ring): BoundaryEdgeAtomInstance[] {
  const facts = computeParcelInteriorFacts(ring)!;
  return facts.edges.map((e) => {
    const role = roleFor(e.edgeIndex);
    const boundaryEdgeId = `${COUNTY_FIPS}:${PROP}:boundary:${e.edgeIndex}`;
    return {
      entityType: "property-boundary-edge",
      atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: PARCEL_NODE_ID,
      countyFips: COUNTY_FIPS,
      propId: PROP,
      edgeIndex: e.edgeIndex,
      role,
      adjacencyKind: "ROW",
      parcelNeighborPropId: null,
      facingRoad: null,
      setback: {
        feet: setbackFor(role),
        provenance: "district-setback-table",
        atomCitation: "test",
      },
      interior: {
        ringCcw: e.ringCcw,
        centroidInside: e.centroidInside,
        inwardNormal: e.inwardNormal,
        edgeEndpoints: e.edgeEndpoints,
      },
      effectiveDate: "2026-07-30",
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy: "platform-internal",
      sourceCitation: "R28 test fixture",
      extractedAt: "2026-07-30T00:00:00.000Z",
      atomTier: "data",
      jurisdictionTenant: "bastrop-tx",
      fetchedAt: "2026-07-30T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "test://",
      contentHash: "fixture",
    } satisfies BoundaryEdgeAtomInstance;
  });
}

describe("R28 recompute boundary primitive for swapped ring", () => {
  it("stored (CCW-built) normals DISAGREE with the reversed (CW) swapped ring", () => {
    const stored = buildStoredEdges(RING_CCW);
    const agree = primitiveNormalsAgreeWithRing(stored, RING_CW);
    expect(agree.ok).toBe(false);
    // At least one edge normal is anti-parallel / orthogonal on the reversed ring.
    expect(agree.perEdgeDot.some((d) => d < NORMAL_AGREEMENT_DOT_MIN)).toBe(true);
  });

  it("BEFORE recompute: stored primitive + swapped ring yields NO inset (bug)", () => {
    const stored = buildStoredEdges(RING_CCW);
    const before = computeWarmCandidateFromBoundary({
      parcelNodeId: PARCEL_NODE_ID,
      district: "GC",
      parcelRing: RING_CW,
      boundaryEdges: stored,
    });
    expect(before.empty).toBe(true);
    expect(before.insetRing).toBeNull();
  });

  it("AFTER recompute: primitive rebuilt for the swapped ring insets cleanly", () => {
    const stored = buildStoredEdges(RING_CCW);
    const rebuilt = recomputeBoundaryEdgesForRing({
      storedEdges: stored,
      ring: RING_CW,
    });

    // Rebuilt normals now agree with the swapped ring (dot ≈ 1.0 per edge).
    const agree = primitiveNormalsAgreeWithRing(rebuilt, RING_CW);
    expect(agree.ok, JSON.stringify(agree.perEdgeDot)).toBe(true);
    expect(agree.perEdgeDot.every((d) => d >= NORMAL_AGREEMENT_DOT_MIN)).toBe(true);

    const after = computeWarmCandidateFromBoundary({
      parcelNodeId: PARCEL_NODE_ID,
      district: "GC",
      parcelRing: RING_CW,
      boundaryEdges: rebuilt,
    });
    expect(after.empty, after.emptyReason).toBe(false);
    expect(after.insetRing).not.toBeNull();
    expect(after.buildableAreaSqFt).toBeGreaterThan(0);
  });

  it("roles are re-indexed to the new edges, not applied by stale index", () => {
    const stored = buildStoredEdges(RING_CCW);
    const rebuilt = recomputeBoundaryEdgesForRing({
      storedEdges: stored,
      ring: RING_CW,
    });

    // Same multiset of roles is preserved (front, rear, side, side).
    const count = (arr: BoundaryEdgeAtomInstance[], role: string) =>
      arr.filter((e) => e.role === role).length;
    expect(count(rebuilt, "front")).toBe(1);
    expect(count(rebuilt, "rear")).toBe(1);
    expect(count(rebuilt, "side")).toBe(2);

    // The front edge's inward normal on the rebuilt primitive points to the SAME
    // physical direction as the stored front edge (parcel is unchanged).
    const storedFront = stored.find((e) => e.role === "front")!;
    const rebuiltFront = rebuilt.find((e) => e.role === "front")!;
    const d =
      storedFront.interior.inwardNormal.x * rebuiltFront.interior.inwardNormal.x +
      storedFront.interior.inwardNormal.y * rebuiltFront.interior.inwardNormal.y;
    expect(d).toBeGreaterThan(NORMAL_AGREEMENT_DOT_MIN);
  });

  it("normal-agreement gate passes for a same-winding (non-swapped) ring", () => {
    const stored = buildStoredEdges(RING_CCW);
    const agree = primitiveNormalsAgreeWithRing(stored, RING_CCW);
    expect(agree.ok).toBe(true);
    expect(agree.perEdgeDot.every((d) => d >= NORMAL_AGREEMENT_DOT_MIN)).toBe(true);
  });
});
