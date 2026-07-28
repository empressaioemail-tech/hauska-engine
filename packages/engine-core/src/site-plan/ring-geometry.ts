import { insetPerEdge } from "../depth-warm/geometry.js";
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

export type SetbackRole = "front" | "side" | "rear" | "unassigned";

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

/** Min of specified axes only — silent 0s must not collapse a real front setback to uniform 0. */
function uniformSpecifiedMin(
  setback: { front: number; side: number; rear: number },
  notSpecified?: NotSpecifiedAxesInput | null,
): number {
  const candidates: number[] = [];
  if (!notSpecified?.front) candidates.push(setback.front);
  if (!notSpecified?.side) candidates.push(setback.side);
  if (!notSpecified?.rear) candidates.push(setback.rear);
  if (candidates.length === 0) return 0;
  return Math.min(...candidates);
}

export type FrontEdgeBasis =
  | "front-edge-hint"
  | "geometric-heuristic:shortest-edge-pair-south-most"
  | "unresolved-uniform-min";

export interface SetbackOffsetResult {
  basis: FrontEdgeBasis;
  segments: Array<RingSegment & SetbackAssignment>;
  /** Inward-offset ring vertices, in the same order as `ring`. Null when the
   * offset degenerated (e.g. a setback that consumes the entire lot) —
   * callers must render that honestly, never a self-intersecting polygon. */
  offsetRing: LocalPoint[] | null;
  offsetDegenerate: boolean;
  offsetDegenerateReason?: string;
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
 * Assigns front/side/rear to a 4-edge ring's segments. Front-edge is a
 * genuinely unresolved reasoning question in this engine today (the
 * buildable-envelope atom itself ships `provisional-front-edge` for this
 * exact reason — see `emit-buildable-envelope.ts`). Two disclosed bases:
 *
 * 1. `frontEdgeIndex` hint supplied by the caller (e.g. a resolved
 *    front-edge-anchor atom) -> that segment is front, its opposite is rear,
 *    the remaining two are side.
 * 2. No hint, exactly 4 edges: apply the common suburban-platting
 *    convention that the street-facing (front) edge is the shorter of the
 *    two roughly-parallel edge pairs, breaking the front/rear tie by
 *    picking the south-most of the pair. This is a disclosed geometric
 *    heuristic, not a street-verified determination — callers must carry
 *    `basis` through to CAD/PDF provenance rather than presenting it as
 *    certain.
 * 3. Otherwise (irregular ring, no hint): apply the MINIMUM of
 *    front/side/rear uniformly to every edge — a conservative under-
 *    estimate of the buildable area (safe direction), not an invented
 *    directional claim.
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

  if (n === 4) {
    const lengths = segments.map((s) => s.lengthMeters);
    const pairA = [0, 2];
    const pairB = [1, 3];
    const avgA = (lengths[0]! + lengths[2]!) / 2;
    const avgB = (lengths[1]! + lengths[3]!) / 2;
    const frontRearPair = avgA <= avgB ? pairA : pairB;
    const sidePair = avgA <= avgB ? pairB : pairA;
    const midY = (i: number) => (segments[i]!.a.y + segments[i]!.b.y) / 2;
    const frontIndex = midY(frontRearPair[0]!) <= midY(frontRearPair[1]!) ? frontRearPair[0]! : frontRearPair[1]!;
    const rearIndex = frontRearPair.find((i) => i !== frontIndex)!;
    const assignments: SetbackAssignment[] = segments.map((_, i) => {
      if (i === frontIndex) return insetForRole("front", setback, notSpecified);
      if (i === rearIndex) return insetForRole("rear", setback, notSpecified);
      if (sidePair.includes(i)) return insetForRole("side", setback, notSpecified);
      return insetForRole("unassigned", setback, notSpecified);
    });
    return { basis: "geometric-heuristic:shortest-edge-pair-south-most", assignments };
  }

  const uniformFt = uniformSpecifiedMin(setback, notSpecified);
  return {
    basis: "unresolved-uniform-min",
    assignments: segments.map(() => ({ role: "unassigned", distanceFt: uniformFt })),
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
