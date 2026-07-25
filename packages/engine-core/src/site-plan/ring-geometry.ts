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

function signedArea(ring: LocalPoint[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
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
 * Offsets each edge inward by its assigned distance and intersects
 * consecutive offset lines to find the new vertex — the standard
 * edge-translate-and-intersect method for simple (ideally convex) polygons.
 * Detects gross degeneracy (offset area flips sign / collapses) rather than
 * emitting a self-intersecting "buildable envelope."
 */
export function computeSetbackOffset(
  ring: LocalPoint[],
  setback: { front: number; side: number; rear: number },
  frontEdgeIndex?: number,
  notSpecified?: NotSpecifiedAxesInput | null,
): SetbackOffsetResult {
  const n = ring.length;
  const { basis, assignments } = assignSetbackRoles(ring, setback, frontEdgeIndex, notSpecified);
  const segments = ringSegments(ring);
  const withAssignment = segments.map((segment, i) => ({ ...segment, ...assignments[i]! }));

  const orientation = signedArea(ring) >= 0 ? 1 : -1; // +1 = CCW, -1 = CW

  // For each edge, compute the inward-offset line as a point+direction.
  const offsetLines = withAssignment.map((seg) => {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;
    // Inward normal: rotate the edge direction +90 deg for a CCW ring
    // (interior is on the left of travel), -90 deg for a CW ring.
    const normalX = orientation >= 0 ? -dirY : dirY;
    const normalY = orientation >= 0 ? dirX : -dirX;
    const distanceMeters = seg.distanceFt * METERS_PER_FOOT;
    return {
      point: { x: seg.a.x + normalX * distanceMeters, y: seg.a.y + normalY * distanceMeters },
      dirX,
      dirY,
    };
  });

  const offsetRing: LocalPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = offsetLines[(i - 1 + n) % n]!;
    const cur = offsetLines[i]!;
    const intersection = intersectLines(prev, cur);
    if (!intersection) {
      return {
        basis,
        segments: withAssignment,
        offsetRing: null,
        offsetDegenerate: true,
        offsetDegenerateReason: "parallel-adjacent-edges-no-intersection",
      };
    }
    offsetRing.push(intersection);
  }

  const originalArea = Math.abs(signedArea(ring));
  const offsetArea = Math.abs(signedArea(offsetRing));
  const sameOrientation = Math.sign(signedArea(ring)) === Math.sign(signedArea(offsetRing));
  // A valid inward offset vertex can never legitimately fall outside the
  // original ring; opposite setback lines crossing past each other (the
  // "setback consumes the lot" case, e.g. forbidden demo parcel 48021:27303)
  // produces exactly that. Small-area-flip alone is not a reliable enough
  // signal (an inverted axis-aligned box can still integrate to a small
  // positive area), so this is the primary degeneracy check.
  const anyVertexEscapesOriginal = offsetRing.some((point) => !pointInPolygon(point, ring));
  if (!sameOrientation || offsetArea <= 0 || offsetArea >= originalArea || anyVertexEscapesOriginal) {
    return {
      basis,
      segments: withAssignment,
      offsetRing: null,
      offsetDegenerate: true,
      offsetDegenerateReason:
        "setback-consumes-lot: inward offset collapsed or inverted (no honest buildable margin to draw)",
    };
  }

  return { basis, segments: withAssignment, offsetRing, offsetDegenerate: false };
}

/** Standard ray-casting point-in-polygon test (boundary counts as outside). */
function pointInPolygon(point: LocalPoint, ring: LocalPoint[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function intersectLines(
  l1: { point: LocalPoint; dirX: number; dirY: number },
  l2: { point: LocalPoint; dirX: number; dirY: number },
): LocalPoint | null {
  const denom = l1.dirX * l2.dirY - l1.dirY * l2.dirX;
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const dx = l2.point.x - l1.point.x;
  const dy = l2.point.y - l1.point.y;
  const t = (dx * l2.dirY - dy * l2.dirX) / denom;
  return { x: l1.point.x + t * l1.dirX, y: l1.point.y + t * l1.dirY };
}
