import { insetPerEdge, insetPerEdgeFromPrimitive } from "../depth-warm/geometry.js";
import {
  ensureCcwRing,
  insetRingMeters,
  isInsetDegenerate,
  signedArea,
} from "../geometry/polygon-inset.js";
import { projectWgs84ToLocalEnu } from "../parcel-terrain/mesh.js";
import type { BboxWgs84 } from "../site-topography/index.js";

export interface LocalPoint {
  x: number;
  y: number;
}

export interface RingSegment {
  a: LocalPoint;
  b: LocalPoint;
  lengthMeters: number;
}

const METERS_PER_FOOT = 0.3048;

/** Drops a duplicate closing vertex (GeoJSON rings repeat the first point). */
export function dedupeClosingVertex(ring: LocalPoint[]): LocalPoint[] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const closed = Math.hypot(last.x - first.x, last.y - first.y) < 1e-6;
  return closed ? ring.slice(0, -1) : ring;
}

export function ringSegments(ring: LocalPoint[]): RingSegment[] {
  const n = ring.length;
  const segments: RingSegment[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    segments.push({ a, b, lengthMeters: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  return segments;
}

export type SetbackRole = "front" | "side" | "rear" | "side_corner" | "unassigned";

/**
 * Minimal structural view of a persisted property-boundary-edge atom — the
 * fields the site-plan export consumes from the boundary primitive (S2-U2/U3).
 * `insetFeet` is the STORED resolved setback (0 when the atom carries an
 * honest absence — no-setback-row / unmapped-adjacency — never a fabricated
 * number), and `inwardNormal` is the STORED interior frame computed once at
 * bake time. The export never re-derives either.
 */
export interface BoundaryEdgeGeometryInput {
  edgeIndex: number;
  role: "front" | "side" | "rear" | "side_corner";
  /** Stored resolved setback feet; 0 when the atom's setback is an absence. */
  insetFeet: number;
  /**
   * True when the stored setback is an honest absence (`no-setback-row`,
   * `unmapped-adjacency`) — zero inset on this edge and the envelope is
   * labeled PROVISIONAL (operator ruling 2026-07-28: build-to-line governs;
   * never fabricate a side/rear value the code doesn't state).
   */
  setbackAbsent: boolean;
  inwardNormal: { x: number; y: number };
}

export interface SetbackAssignment {
  role: SetbackRole;
  /** Inset feet for geometry. Silent (not_specified) axes use 0 — never invent a dimension. */
  distanceFt: number;
  /** True when the code is silent on this axis (build-to-line governs). */
  notSpecified?: boolean;
}

export type NotSpecifiedAxesInput = {
  front?: boolean;
  side?: boolean;
  rear?: boolean;
};

function insetForRole(
  role: SetbackRole,
  setback: { front: number; side: number; rear: number },
  notSpecified?: NotSpecifiedAxesInput | null,
): SetbackAssignment {
  if (role === "front") {
    const silent = !!notSpecified?.front;
    return { role, distanceFt: silent ? 0 : setback.front, notSpecified: silent || undefined };
  }
  if (role === "rear") {
    const silent = !!notSpecified?.rear;
    return { role, distanceFt: silent ? 0 : setback.rear, notSpecified: silent || undefined };
  }
  // side + unassigned share the side axis
  const silent = !!notSpecified?.side;
  return { role, distanceFt: silent ? 0 : setback.side, notSpecified: silent || undefined };
}

/** True when the rule would inset at least one edge if the front edge were known. */
function anySpecifiedNonZeroAxis(
  setback: { front: number; side: number; rear: number },
  notSpecified?: NotSpecifiedAxesInput | null,
): boolean {
  if (!notSpecified?.front && setback.front > 0) return true;
  if (!notSpecified?.side && setback.side > 0) return true;
  if (!notSpecified?.rear && setback.rear > 0) return true;
  return false;
}

export type FrontEdgeBasis =
  | "boundary-primitive"
  | "front-edge-hint"
  | "unresolved-front-edge";

export interface SetbackOffsetResult {
  basis: FrontEdgeBasis;
  segments: Array<RingSegment & SetbackAssignment>;
  /** Inward-offset ring vertices, in the same order as `ring`. Null when the
   * offset degenerated (e.g. a setback that consumes the entire lot) —
   * callers must render that honestly, never a self-intersecting polygon. */
  offsetRing: LocalPoint[] | null;
  offsetDegenerate: boolean;
  offsetDegenerateReason?: string;
  /**
   * True when a setback rule exists but there is no boundary primitive and no
   * resolved front-edge anchor: NOTHING is drawn (offsetRing null, not
   * degenerate) rather than a per-edge guess. The envelope is provisional.
   */
  frontEdgeUnresolved?: boolean;
  /**
   * Boundary-primitive path only: true when any consumed edge carried a
   * stored setback ABSENCE (zero inset applied there) — the envelope draws
   * but is labeled PROVISIONAL per the 2026-07-28 build-to-line ruling.
   */
  primitiveEdgeAbsence?: boolean;
}

/** When `ringWgs84` + `bbox` are supplied, offset geometry uses depth-warm
 * `insetPerEdge` on the WGS84 ring (centroid projection frame), then projects
 * the result into the site-plan local-ENU frame for CAD. Role assignment still
 * uses the local ring passed as the first argument. */
export interface ComputeSetbackOffsetOptions {
  ringWgs84?: Array<[number, number]>;
  bbox?: BboxWgs84;
}

/**
 * Assigns front/side/rear to a ring's segments. Front-edge truth lives in the
 * BOUNDARY PRIMITIVE (property-boundary-edge atoms — see
 * `computeSetbackOffsetFromPrimitive`); this function only covers the two
 * remaining honest cases:
 *
 * 1. `frontEdgeIndex` hint supplied by the caller (e.g. a resolved
 *    front-edge-anchor atom) -> that segment is front, its opposite is rear,
 *    the remaining two are side.
 * 2. Otherwise: `unresolved-front-edge`. NO inset is fabricated on any edge —
 *    every assignment is `unassigned` at 0 ft and the caller draws nothing
 *    envelope-shaped, labeled provisional. The retired
 *    vertex-count fork (n==4 geometric front guess / n!=4 uniform-min
 *    fabrication) is deliberately gone: two independent per-edge computations
 *    "patched to agree" drift on the next county's ring shape (2026-07-28
 *    master review; THE BASTROP MOLD, PART 3 GEOMETRY).
 */
export function assignSetbackRoles(
  ring: LocalPoint[],
  setback: { front: number; side: number; rear: number },
  frontEdgeIndex?: number,
  notSpecified?: NotSpecifiedAxesInput | null,
): { basis: FrontEdgeBasis; assignments: SetbackAssignment[] } {
  const n = ring.length;
  const segments = ringSegments(ring);

  if (frontEdgeIndex !== undefined && frontEdgeIndex >= 0 && frontEdgeIndex < n) {
    const rearIndex = n === 4 ? (frontEdgeIndex + 2) % 4 : -1;
    const assignments: SetbackAssignment[] = segments.map((_, i) => {
      if (i === frontEdgeIndex) return insetForRole("front", setback, notSpecified);
      if (i === rearIndex) return insetForRole("rear", setback, notSpecified);
      return insetForRole("side", setback, notSpecified);
    });
    return { basis: "front-edge-hint", assignments };
  }

  // Honest-absent rule (every axis silent): zero inset everywhere is the
  // CORRECT geometry (no setback to draw), not a guess — keep the roles
  // unassigned and let the all-zero branch in computeSetbackOffset return the
  // property ring itself.
  return {
    basis: "unresolved-front-edge",
    assignments: segments.map(() => {
      const a = insetForRole("unassigned", setback, notSpecified);
      // Never fabricate a directional inset without a resolved front edge.
      return { ...a, distanceFt: 0 };
    }),
  };
}

/**
 * Offsets each edge inward by its assigned distance using the shared
 * polygon-clipping strip-union-difference path (same as depth-warm
 * `insetPerEdge`). Role assignment and segment metadata stay here;
 * geometry truth lives in `geometry/polygon-inset.ts`.
 */
function setbackConsumesLotReason(detail?: string): string {
  const base =
    "setback-consumes-lot: inward offset collapsed or inverted (no honest buildable margin to draw)";
  return detail ? `${base} (${detail})` : base;
}

export function computeSetbackOffset(
  ring: LocalPoint[],
  setback: { front: number; side: number; rear: number },
  frontEdgeIndex?: number,
  notSpecified?: NotSpecifiedAxesInput | null,
  options?: ComputeSetbackOffsetOptions,
): SetbackOffsetResult {
  const n = ring.length;
  const { basis, assignments } = assignSetbackRoles(ring, setback, frontEdgeIndex, notSpecified);
  const segments = ringSegments(ring);
  const withAssignment = segments.map((segment, i) => ({ ...segment, ...assignments[i]! }));

  // Unresolved front edge with a real (non-silent) rule on file: draw NOTHING
  // envelope-shaped rather than guess a per-edge assignment. Not degenerate —
  // the geometry did not collapse; the reasoning input (front edge) is simply
  // not resolved. Callers label the envelope provisional.
  if (basis === "unresolved-front-edge" && anySpecifiedNonZeroAxis(setback, notSpecified)) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: false,
      frontEdgeUnresolved: true,
    };
  }

  const insetFeetPerEdge = assignments.map((a) => Math.max(0, a.distanceFt));
  // All-zero inset (every axis silent / honest-absent — no setback to draw):
  // the "setback line" honestly coincides with the property line. This is NOT
  // a degenerate offset (nothing collapsed) and NOT a fabricated dimension —
  // it is the correct geometry when there is no setback rule to apply. Return
  // the property ring itself so the sheet draws no phantom inset, and never
  // trips the `offsetArea >= originalArea` consumes-lot guard below.
  if (insetFeetPerEdge.every((ft) => ft === 0)) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: dedupeClosingVertex(ring),
      offsetDegenerate: false,
    };
  }
  if (insetFeetPerEdge.some((ft) => !Number.isFinite(ft))) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: "non-finite setback distance",
    };
  }
  if (insetFeetPerEdge.length !== n) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: "edge/setback count mismatch",
    };
  }

  if (options?.ringWgs84 && options.bbox) {
    const insetResult = insetPerEdge(options.ringWgs84, insetFeetPerEdge);
    if (insetResult.empty || !insetResult.ring) {
      return {
        basis,
        segments: withAssignment,
        offsetRing: null,
        offsetDegenerate: true,
        offsetDegenerateReason: setbackConsumesLotReason(insetResult.emptyReason),
      };
    }

    const offsetRing = dedupeClosingVertex(
      insetResult.ring.map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, options.bbox!)),
    );
    if (offsetRing.length < 3) {
      return {
        basis,
        segments: withAssignment,
        offsetRing: null,
        offsetDegenerate: true,
        offsetDegenerateReason: setbackConsumesLotReason("projected offset ring is degenerate"),
      };
    }

    const originalArea = Math.abs(signedArea(ring));
    const offsetArea = Math.abs(signedArea(offsetRing));
    if (offsetArea <= 0 || offsetArea >= originalArea) {
      return {
        basis,
        segments: withAssignment,
        offsetRing: null,
        offsetDegenerate: true,
        offsetDegenerateReason: setbackConsumesLotReason(),
      };
    }

    return { basis, segments: withAssignment, offsetRing, offsetDegenerate: false };
  }

  const insetMetersPerEdge = insetFeetPerEdge.map((ft) => ft * METERS_PER_FOOT);
  const { points: ccwRing, insetMetersPerEdge: ccwInset, reversed } = ensureCcwRing(
    ring,
    insetMetersPerEdge,
  );

  const insetXY = insetRingMeters(ccwRing, ccwInset);
  if (!insetXY) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: setbackConsumesLotReason(),
    };
  }

  if (isInsetDegenerate(ccwRing, insetXY.points, ccwInset)) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: setbackConsumesLotReason(),
    };
  }

  let offsetRing: LocalPoint[] = insetXY.points;
  if (reversed) {
    offsetRing = offsetRing.slice().reverse();
  }

  const originalArea = Math.abs(signedArea(ring));
  const offsetArea = Math.abs(signedArea(offsetRing));
  if (offsetArea <= 0 || offsetArea >= originalArea) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: setbackConsumesLotReason(),
    };
  }

  return { basis, segments: withAssignment, offsetRing, offsetDegenerate: false };
}

/**
 * THE primitive-consuming offset (2026-07-28 architecture directive): the
 * site-plan export derives its envelope, setback lines, and edge-role labels
 * from the STORED boundary primitive — per-edge role + resolved setback +
 * interior inward normal baked once per parcel (S2-U2) — through the SAME
 * `insetPerEdgeFromPrimitive` engine depth-warm consumes (S2-U3,
 * `boundary-primitive/consume.ts`). One geometry, one truth, by construction:
 * the reconciliation gate (export area == depth-warm area on the same
 * ring+edges) passes because they are literally one computation, not two
 * per-edge paths patched to agree.
 *
 * Zero-inset edges (stored setback absence — build-to-line governs, or
 * unmapped adjacency) apply ZERO inset and flag `primitiveEdgeAbsence` so the
 * envelope is labeled PROVISIONAL; a value is never fabricated (operator
 * ruling 2026-07-28).
 */
export function computeSetbackOffsetFromPrimitive(input: {
  ringLocal: LocalPoint[];
  ringWgs84: Array<[number, number]>;
  bbox: BboxWgs84;
  boundaryEdges: ReadonlyArray<BoundaryEdgeGeometryInput>;
}): SetbackOffsetResult {
  const { ringLocal, ringWgs84, bbox, boundaryEdges } = input;
  const segments = ringSegments(ringLocal);
  const n = ringLocal.length;

  const byIndex = new Map(boundaryEdges.map((e) => [e.edgeIndex, e]));
  const withAssignment = segments.map((segment, i) => {
    const edge = byIndex.get(i);
    if (!edge) {
      return {
        ...segment,
        role: "unassigned" as SetbackRole,
        distanceFt: 0,
        notSpecified: true as const,
      };
    }
    return {
      ...segment,
      role: edge.role as SetbackRole,
      distanceFt: edge.setbackAbsent ? 0 : edge.insetFeet,
      notSpecified: edge.setbackAbsent || undefined,
    };
  });

  // A primitive that does not cover this ring's edges (baked against a
  // different ring vintage, or indices out of range) is NOT served by
  // guessing: fall back to the honest unresolved treatment.
  const outOfRange = boundaryEdges.some((e) => e.edgeIndex < 0 || e.edgeIndex >= n);
  if (outOfRange || boundaryEdges.length !== n) {
    return {
      basis: "unresolved-front-edge",
      segments: segments.map((segment) => ({
        ...segment,
        role: "unassigned" as SetbackRole,
        distanceFt: 0,
      })),
      offsetRing: null,
      offsetDegenerate: false,
      frontEdgeUnresolved: true,
    };
  }

  const primitiveEdgeAbsence = boundaryEdges.some((e) => e.setbackAbsent);
  const storedInset = boundaryEdges.map((e) => ({
    edgeIndex: e.edgeIndex,
    insetFeet: e.setbackAbsent ? 0 : e.insetFeet,
    inwardNormal: e.inwardNormal,
  }));

  // Same engine + same inputs as depth-warm's computeWarmCandidateFromBoundary.
  const inset = insetPerEdgeFromPrimitive(ringWgs84, storedInset);
  if (inset.empty || !inset.ring) {
    return {
      basis: "boundary-primitive",
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: setbackConsumesLotReason(inset.emptyReason),
      primitiveEdgeAbsence,
    };
  }

  const offsetRing = dedupeClosingVertex(
    inset.ring.map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, bbox)),
  );
  if (offsetRing.length < 3) {
    return {
      basis: "boundary-primitive",
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason: setbackConsumesLotReason("projected offset ring is degenerate"),
      primitiveEdgeAbsence,
    };
  }

  return {
    basis: "boundary-primitive",
    segments: withAssignment,
    offsetRing,
    offsetDegenerate: false,
    primitiveEdgeAbsence,
  };
}
