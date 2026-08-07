/**
 * Shared per-edge polygon inset via strip-union-difference (polygon-clipping).
 *
 * Used by depth-warm `insetPerEdge` (lng/lat rings) and site-plan setback
 * offset (local-ENU metre rings). ONE implementation — R0 geometry truth.
 */

import polygonClipping from "polygon-clipping";

/** Planar point in metres (local ENU or projected lng/lat frame). */
export interface PlanarPoint {
  x: number;
  y: number;
}

/**
 * One clipper-input edge record: a ring vertex plus the inset distance and
 * inward normal that apply to the edge STARTING at that vertex — all three
 * fields for one physical edge, together, so they can never be indexed
 * against different enumerations.
 *
 * 2026-08-07 (master planner ruling, cheap-insurance invariant): three
 * separate error-species this week (a strip-union/notch-collapse defect
 * fixed in the OFFSET-CORE-VARIABLE-DISTANCE redesign; an R32
 * ownership-arbitration defect fixed the same day; and a genuine
 * arbitration-tooling bug in a diagnostic script — see the
 * OFFSET_CORE_REDESIGN_DESIGN_NOTE.md history and this file's
 * insetRingMetersWithNormals doc comment) all traced back to the SAME root
 * shape: a ring/role/distance triple threaded through the pipeline as
 * separate parallel arrays or separately-transformed indices, which
 * silently desynchronize when any one array is built, filtered, or
 * reordered independently of the others. `buildInsetClipperInput` is the
 * single place that assembles this joined structure FROM parallel
 * per-edge inputs (every current caller still starts from a `WarmEdgeInfo`
 * array or a stored-boundary-primitive edge list, both naturally
 * index-keyed), so the join happens ONCE, at one call site each, with a
 * runtime-checked invariant — not implicitly, per call to the clipper.
 */
export interface InsetClipperEdge {
  /** Ring vertex this edge starts at (edge i runs vertex[i] -> vertex[(i+1) % n]). */
  vertex: PlanarPoint;
  /** This edge's own inset distance, metres. */
  insetMeters: number;
  /** This edge's own inward normal (need not be pre-normalized; insetRingMetersWithNormals normalizes it). */
  inwardNormal: PlanarPoint;
}

/**
 * Build and validate a joined clipper-input structure from parallel
 * per-edge arrays. Fails loudly (throws) rather than silently returning a
 * degenerate/empty result on a length mismatch — the FAIL-CLOSED posture
 * a parallel-array bug would otherwise hide as an ordinary "setbacks
 * exceed the lot" honest-empty result, indistinguishable from a real
 * degenerate lot without this check.
 */
export function buildInsetClipperInput(
  ring: PlanarPoint[],
  insetMetersPerEdge: number[],
  inwardNormalsPerEdge: PlanarPoint[],
): InsetClipperEdge[] {
  const n = ring.length;
  if (insetMetersPerEdge.length !== n || inwardNormalsPerEdge.length !== n) {
    throw new Error(
      `buildInsetClipperInput: joined-structure invariant violated — ring has ${n} vertices but ` +
        `insetMetersPerEdge has ${insetMetersPerEdge.length} and inwardNormalsPerEdge has ` +
        `${inwardNormalsPerEdge.length}. All three must derive from the SAME ring enumeration; a ` +
        `length mismatch here means two of the three were built or filtered independently and have ` +
        `silently desynchronized (the exact defect class this invariant exists to make unrepresentable).`,
    );
  }
  return ring.map((vertex, i) => ({
    vertex,
    insetMeters: insetMetersPerEdge[i]!,
    inwardNormal: inwardNormalsPerEdge[i]!,
  }));
}

/** Split a joined clipper-input structure back into the parallel arrays insetRingMetersWithNormals consumes. */
function splitInsetClipperInput(
  edges: InsetClipperEdge[],
): { ring: PlanarPoint[]; insetMetersPerEdge: number[]; inwardNormalsPerEdge: PlanarPoint[] } {
  return {
    ring: edges.map((e) => e.vertex),
    insetMetersPerEdge: edges.map((e) => e.insetMeters),
    inwardNormalsPerEdge: edges.map((e) => e.inwardNormal),
  };
}

/**
 * Variable-distance inset from a JOINED clipper-input structure — the
 * invariant-checked entry point new call sites should prefer over the
 * three-parallel-array insetRingMetersWithNormals. Existing call sites
 * (depth-warm/geometry.ts, site-plan/ring-geometry.ts) keep using their
 * own parallel-array construction for now (their arrays are built by a
 * single index-keyed loop each, already the safer pattern), but route
 * through buildInsetClipperInput's validation by calling this wrapper.
 */
export function insetRingMetersFromClipperInput(
  edges: InsetClipperEdge[],
): { points: PlanarPoint[]; miterPoints: PlanarPoint[] } | null {
  const { ring, insetMetersPerEdge, inwardNormalsPerEdge } = splitInsetClipperInput(edges);
  return insetRingMetersWithNormals(ring, insetMetersPerEdge, inwardNormalsPerEdge);
}

/** Signed area of an open ring. Positive => CCW. */
export function signedArea(points: PlanarPoint[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Ensure CCW orientation; reverse per-edge inset distances when the ring flips. */
export function ensureCcwRing<T extends PlanarPoint>(
  points: T[],
  insetMetersPerEdge: number[],
): { points: T[]; insetMetersPerEdge: number[]; reversed: boolean } {
  if (signedArea(points) >= 0) {
    return { points, insetMetersPerEdge, reversed: false };
  }
  return {
    points: points.slice().reverse(),
    insetMetersPerEdge: insetMetersPerEdge.slice().reverse(),
    reversed: true,
  };
}

function inwardNormal(a: PlanarPoint, b: PlanarPoint): PlanarPoint | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: -dy / len, y: dx / len };
}

function closeClipRing(points: PlanarPoint[]): polygonClipping.Ring {
  const ring: polygonClipping.Ring = points.map((p) => [p.x, p.y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function xyFromClipRing(ring: polygonClipping.Ring): PlanarPoint[] {
  const open =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring.slice();
  return open.map(([x, y]) => ({ x, y }));
}

function setbackStrip(
  a: PlanarPoint,
  b: PlanarPoint,
  nrm: PlanarPoint,
  distM: number,
): polygonClipping.Polygon | null {
  if (distM <= 1e-9) return null;
  const aOff: PlanarPoint = { x: a.x + nrm.x * distM, y: a.y + nrm.y * distM };
  const bOff: PlanarPoint = { x: b.x + nrm.x * distM, y: b.y + nrm.y * distM };
  return [
    [
      [a.x, a.y],
      [b.x, b.y],
      [bOff.x, bOff.y],
      [aOff.x, aOff.y],
      [a.x, a.y],
    ],
  ];
}

/**
 * Variable-distance inset on an open CCW ring in metres.
 * `insetMetersPerEdge[i]` applies to edge vertex i -> i+1.
 */
export function insetRingMeters(
  ccwRing: PlanarPoint[],
  insetMetersPerEdge: number[],
): { points: PlanarPoint[]; miterPoints: PlanarPoint[] } | null {
  const n = ccwRing.length;
  const normals: PlanarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = ccwRing[i]!;
    const b = ccwRing[(i + 1) % n]!;
    const nrm = inwardNormal(a, b);
    if (!nrm) return null;
    normals.push(nrm);
  }
  return insetRingMetersWithNormals(ccwRing, insetMetersPerEdge, normals);
}

/**
 * Minimum |turn angle| (degrees) at an ORIGINAL parcel vertex for it to be
 * treated as a genuine reflex corner (real concave notch) rather than
 * near-collinear survey/digitization noise. 2026-08-07
 * OFFSET-CORE-VARIABLE-DISTANCE redesign: verified against all twelve real
 * Jones/Higgins parcel rings — every near-collinear "noise" vertex in that
 * dataset measures under 4 degrees, while every genuine lot corner measures
 * 70+ degrees. 15 sits comfortably between the two clusters.
 */
const REFLEX_VERTEX_MIN_TURN_DEG = 15;

/**
 * Signed turn angle (degrees) at ring vertex i against a KNOWN dominant
 * winding sign (positive = matches dominant winding, i.e. a normal convex
 * turn; negative = disagrees, i.e. reflex). Returns 0 for a degenerate
 * (near-zero-length) edge pair, which is treated as "not reflex."
 */
function turnAngleDegAtIndex(ring: PlanarPoint[], i: number): number {
  const n = ring.length;
  const p = ring[(i + n - 1) % n]!;
  const q = ring[i]!;
  const r = ring[(i + 1) % n]!;
  const v1x = q.x - p.x;
  const v1y = q.y - p.y;
  const v2x = r.x - q.x;
  const v2y = r.y - q.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-9 || len2 < 1e-9) return 0;
  const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
  const cross = v1x * v2y - v1y * v2x;
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  return Math.sign(cross) * angle;
}

/**
 * Indices of genuine reflex vertices in a CCW ring — vertices whose turn
 * sign disagrees with the ring's dominant winding AND whose magnitude
 * exceeds REFLEX_VERTEX_MIN_TURN_DEG (a real concave corner, not
 * near-collinear noise). Empty for a convex-modulo-noise ring (the common
 * case for every real parcel checked in this dataset).
 */
function findGenuineReflexVertices(ring: PlanarPoint[]): number[] {
  const dominantSign = ringDominantTurnSign(ring);
  if (dominantSign === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const turn = turnAngleDegAtIndex(ring, i);
    if (Math.sign(turn) !== 0 && Math.sign(turn) !== dominantSign && Math.abs(turn) >= REFLEX_VERTEX_MIN_TURN_DEG) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Split a CCW ring into convex-modulo-noise sub-polygons at its genuine
 * reflex vertices (2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign).
 * Each returned polygon carries its own vertex indices INTO THE ORIGINAL
 * ring (so callers can look up the matching per-edge inset distance for
 * each edge of each piece). Zero reflex vertices returns the whole ring as
 * a single piece — the common, trivial path.
 *
 * Uses a simple ear-adjacent diagonal split: for each reflex vertex, cut a
 * diagonal to the nearest OTHER vertex (by Euclidean distance) that yields
 * two simple, non-self-intersecting pieces, each containing strictly fewer
 * reflex vertices than the whole (guaranteeing termination). This is not a
 * general Hertel-Mehlhorn-optimal decomposition — it does not minimize
 * piece count — but every residential-lot reflex case this codebase
 * anticipates (an L-shaped/notched lot, e.g. the pre-existing 48021:34121
 * fixture referenced in verify-mechanical.ts) has one or two reflex
 * vertices, where a minimal-piece-count guarantee buys nothing a
 * correctness-first split does not already provide.
 */
function splitAtReflexVertices(ring: PlanarPoint[]): Array<{ points: PlanarPoint[]; originalIndices: number[] }> {
  const reflex = findGenuineReflexVertices(ring);
  if (reflex.length === 0) {
    return [{ points: ring, originalIndices: ring.map((_, i) => i) }];
  }
  return splitPolygonAtReflexVertex(ring, ring.map((_, i) => i));
}

/**
 * Recursive worker for splitAtReflexVertices. `indices` maps each point in
 * `points` back to its vertex index in the ORIGINAL ring (needed so a
 * caller can look up per-edge inset distances after the split).
 */
function splitPolygonAtReflexVertex(
  points: PlanarPoint[],
  indices: number[],
): Array<{ points: PlanarPoint[]; originalIndices: number[] }> {
  const reflexLocal = findGenuineReflexVertices(points);
  if (reflexLocal.length === 0 || points.length < 4) {
    return [{ points, originalIndices: indices }];
  }
  const n = points.length;
  const reflexIdx = reflexLocal[0]!;
  const reflexPt = points[reflexIdx]!;

  // Candidate diagonal targets: every other non-adjacent vertex.
  // 2026-08-07 fix: order by whether the diagonal introduces a NEW reflex
  // vertex in either resulting piece — prefer candidates that introduce
  // none, and among those prefer topological proximity (fewest ring-steps
  // from the reflex vertex) as a tiebreak. A naive Euclidean-nearest sort
  // picked, on a verified L-shaped hexagon fixture, a target that happened
  // to sit physically close to the reflex vertex but cut across at an
  // angle that introduced a FRESH reflex vertex in the larger piece
  // (verified: the diagonal's own endpoint measured a new -45deg turn),
  // forcing an unnecessary second recursive split that fragmented the
  // polygon into three overlapping-adjacency pieces and corrupted the
  // final unioned area (the correct ~5535 sqft L-shape area collapsed to
  // a false empty result). Checking "does this diagonal keep both
  // resulting pieces genuinely convex-modulo-noise" directly is the
  // robust fix — no heuristic proxy (distance, step count) reliably
  // predicts it on its own.
  const dominantSignOuter = ringDominantTurnSign(points);
  const candidates: number[] = [];
  for (let k = 2; k < n - 1; k++) {
    candidates.push((reflexIdx + k) % n);
  }
  const introducesNewReflex = (targetIdx: number): boolean => {
    const pieceA: number[] = [];
    for (let i = reflexIdx; ; i = (i + 1) % n) {
      pieceA.push(i);
      if (i === targetIdx) break;
    }
    const pieceB: number[] = [];
    for (let i = targetIdx; ; i = (i + 1) % n) {
      pieceB.push(i);
      if (i === reflexIdx) break;
    }
    for (const piece of [pieceA, pieceB]) {
      if (piece.length < 3) continue;
      const piecePts = piece.map((i) => points[i]!);
      // Only the two NEW vertices (the diagonal's own endpoints, at
      // piece-local index 0 and piece.length-1) can introduce a reflex
      // angle that wasn't already in the original ring — every other
      // vertex keeps its original two neighbors' directions on at least
      // one side... except the immediate neighbors of the diagonal
      // endpoints also gain a new adjacent edge, so check every vertex in
      // the piece to be safe (piece sizes here are always small).
      for (let k = 0; k < piecePts.length; k++) {
        const turn = turnAngleDegAtIndex(piecePts, k);
        // Reflex relative to a LOCALLY convex expectation: any turn whose
        // sign disagrees with the ORIGINAL ring's dominant sign and whose
        // magnitude clears the same real-corner floor counts.
        if (Math.abs(turn) >= REFLEX_VERTEX_MIN_TURN_DEG && Math.sign(turn) !== dominantSignOuter) {
          return true;
        }
      }
    }
    return false;
  };
  candidates.sort((a, b) => {
    const badA = introducesNewReflex(a) ? 1 : 0;
    const badB = introducesNewReflex(b) ? 1 : 0;
    if (badA !== badB) return badA - badB;
    const stepsA = Math.min((a - reflexIdx + n) % n, (reflexIdx - a + n) % n);
    const stepsB = Math.min((b - reflexIdx + n) % n, (reflexIdx - b + n) % n);
    return stepsA - stepsB;
  });

  for (const targetIdx of candidates) {
    const mid = midpoint(reflexPt, points[targetIdx]!);
    if (!pointInOrOnPolygon(mid, points, -1e-6)) continue; // must be a strict-interior diagonal
    let crosses = false;
    for (let e = 0; e < n && !crosses; e++) {
      const ea = e;
      const eb = (e + 1) % n;
      if (ea === reflexIdx || eb === reflexIdx || ea === targetIdx || eb === targetIdx) continue;
      if (segCrossProper(reflexPt, points[targetIdx]!, points[ea]!, points[eb]!)) crosses = true;
    }
    if (crosses) continue;

    // Build the two pieces by walking the ring in each direction between
    // reflexIdx and targetIdx (inclusive of both endpoints on each side).
    const pieceA: number[] = [];
    for (let i = reflexIdx; ; i = (i + 1) % n) {
      pieceA.push(i);
      if (i === targetIdx) break;
    }
    const pieceB: number[] = [];
    for (let i = targetIdx; ; i = (i + 1) % n) {
      pieceB.push(i);
      if (i === reflexIdx) break;
    }
    if (pieceA.length < 3 || pieceB.length < 3) continue;

    const piecePointsA = pieceA.map((i) => points[i]!);
    const piecePointsB = pieceB.map((i) => points[i]!);
    const originalA = pieceA.map((i) => indices[i]!);
    const originalB = pieceB.map((i) => indices[i]!);

    return [
      ...splitPolygonAtReflexVertex(piecePointsA, originalA),
      ...splitPolygonAtReflexVertex(piecePointsB, originalB),
    ];
  }

  // No valid diagonal found (should not happen for a simple polygon with a
  // genuine reflex vertex, but fail closed rather than loop or throw): treat
  // as unsplit — the caller's half-plane clip will be run on the whole
  // ring, which is a convex-hull-style OVER-approximation for a reflex
  // ring; downstream containment checks (geometryCorrectnessGate's
  // vertex-in-parcel test) are the backstop that must reject a bulge this
  // produces, same backstop that exists today for any other path that
  // fails to model a reflex corner correctly.
  return [{ points, originalIndices: indices }];
}

/**
 * Clip a convex polygon (points, CCW) against a single inward half-plane:
 * keep only the region on the polygon-interior side of the line through
 * (a + nrm*dist) with direction (b-a), i.e. the Sutherland-Hodgman clip
 * step for one edge's inward-offset supporting line. `nrm` must be the
 * UNIT inward normal for edge a->b; `dist` is that edge's own inset
 * distance in the same units as `points`.
 */
function clipConvexAgainstHalfPlane(
  points: PlanarPoint[],
  a: PlanarPoint,
  b: PlanarPoint,
  nrm: PlanarPoint,
  dist: number,
): PlanarPoint[] {
  if (points.length === 0) return points;
  const lineA = { x: a.x + nrm.x * dist, y: a.y + nrm.y * dist };
  const lineB = { x: b.x + nrm.x * dist, y: b.y + nrm.y * dist };
  const dirx = lineB.x - lineA.x;
  const diry = lineB.y - lineA.y;
  // Signed distance along the inward normal: positive = inside (buildable) side.
  const side = (p: PlanarPoint): number => (p.x - lineA.x) * nrm.x + (p.y - lineA.y) * nrm.y;

  const out: PlanarPoint[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const curSide = side(cur);
    const nextSide = side(next);
    const curIn = curSide >= -1e-9;
    const nextIn = nextSide >= -1e-9;
    if (curIn) out.push(cur);
    if (curIn !== nextIn) {
      // Edge crosses the clip line — intersect the polygon edge (cur->next)
      // against the clip line (lineA + t*dir).
      const ex = next.x - cur.x;
      const ey = next.y - cur.y;
      const denom = ex * (-diry) - ey * (-dirx);
      let hit: PlanarPoint | null = null;
      if (Math.abs(denom) >= 1e-12) {
        hit = lineIntersection(cur, next, lineA, lineB);
      }
      if (hit) out.push(hit);
    }
  }
  return out;
}

/**
 * Sequential per-edge half-plane clipping on a single CONVEX (or
 * convex-modulo-near-collinear-noise) piece: intersect the piece against
 * every edge's own inward-offset half-plane in turn. Correct by
 * construction for a convex polygon — a convex polygon IS the intersection
 * of the half-planes bounded by its own edges, so offsetting each
 * supporting line inward by that edge's own setback and re-intersecting
 * yields exactly the correct inset region, with every corner computed AS
 * the pairwise half-plane intersection rather than repaired after the
 * fact. `edgeIndices[i]` is edge i's index into the caller's full
 * `insetMetersPerEdge`/`inwardNormalsPerEdge` arrays (a piece produced by
 * splitAtReflexVertices carries a SUBSET of the original ring's edges plus
 * the new diagonal edges, which get an inset distance of 0 — a diagonal is
 * interior to the parcel, not a real setback-bearing boundary).
 */
function clipPieceSequentialHalfPlanes(
  piece: PlanarPoint[],
  originalIndices: number[],
  insetMetersPerEdge: number[],
  inwardNormalsPerEdge: PlanarPoint[],
  fullOriginalRing?: PlanarPoint[],
): PlanarPoint[] {
  let current = piece;
  const n = piece.length;
  for (let i = 0; i < n && current.length > 0; i++) {
    const a = piece[i]!;
    const b = piece[(i + 1) % n]!;
    const origA = originalIndices[i]!;
    const origB = originalIndices[(i + 1) % n]!;
    // An edge is a real parcel boundary edge only when its two endpoints
    // are ADJACENT in the original ring (origB = origA + 1 mod ring
    // length) — anything else is a diagonal introduced by the reflex
    // split, which bounds no setback and must not be clipped.
    const isOriginalEdge = (origB - origA + insetMetersPerEdge.length) % insetMetersPerEdge.length === 1;
    if (!isOriginalEdge) continue;
    const dist = insetMetersPerEdge[origA]!;
    if (dist <= 1e-9) continue;
    const nrm = inwardNormalsPerEdge[origA]!;
    const len = Math.hypot(nrm.x, nrm.y);
    if (len < 1e-12) continue;
    const unit = { x: nrm.x / len, y: nrm.y / len };
    current = clipConvexAgainstHalfPlane(current, a, b, unit, dist);
  }

  // 2026-08-07 fix: a reflex-split piece must ALSO be clipped against
  // every OTHER original edge in the ring, not just the subset it happens
  // to carry. Verified on the L-shaped hexagon fixture: two pieces
  // independently clipped against only their OWN edges converged to
  // DIFFERENT positions along their shared (unconstrained) diagonal —
  // ~0.44m apart, a real geometric gap, not floating-point noise —
  // because each piece never "felt" the other piece's constraints near
  // the shared reflex vertex. A convex piece intersected with EVERY
  // original edge's half-plane (not just its own subset) can only shrink
  // further or stay the same — never incorrectly expand — because the
  // TRUE buildable envelope must satisfy every edge's setback everywhere,
  // not just within the piece each edge originated from. This forces both
  // pieces to converge on the SAME true boundary near their shared
  // diagonal, so the subsequent union merges them into one connected
  // ring instead of two disjoint components with a false gap between
  // them.
  if (fullOriginalRing && current.length > 0) {
    const fullN = fullOriginalRing.length;
    for (let i = 0; i < fullN && current.length > 0; i++) {
      const dist = insetMetersPerEdge[i]!;
      if (dist <= 1e-9) continue;
      const a = fullOriginalRing[i]!;
      const b = fullOriginalRing[(i + 1) % fullN]!;
      const nrm = inwardNormalsPerEdge[i]!;
      const len = Math.hypot(nrm.x, nrm.y);
      if (len < 1e-12) continue;
      const unit = { x: nrm.x / len, y: nrm.y / len };
      current = clipConvexAgainstHalfPlane(current, a, b, unit, dist);
    }
  }

  return current;
}

/**
 * Variable-distance inset using STORED inward normals per edge (S2-U3).
 * Does not re-derive orientation from ring winding at offset time.
 *
 * 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign: replaces the prior
 * strip-union-difference + notch-collapse implementation (which repaired
 * near-collinear corner artifacts via a post-hoc analytic-miter collapse
 * pass, verified to genuinely fail on 48021:31362's real ~89-degree corner
 * — see the design note at OFFSET_CORE_REDESIGN_DESIGN_NOTE.md) with
 * sequential per-edge half-plane clipping: every corner is computed
 * DIRECTLY as the intersection of two adjacent half-planes, never
 * approximated and repaired. Genuine reflex vertices in the ORIGINAL
 * parcel ring (real concave corners, not near-collinear noise — see
 * REFLEX_VERTEX_MIN_TURN_DEG) are handled by convex-decomposing the parcel
 * at those vertices first and unioning the independently-clipped convex
 * pieces back together; the common case (zero reflex vertices, verified
 * true for all twelve real parcels this redesign targets) skips
 * decomposition entirely and clips the whole ring in one pass.
 */
export function insetRingMetersWithNormals(
  ccwRing: PlanarPoint[],
  insetMetersPerEdge: number[],
  inwardNormalsPerEdge: PlanarPoint[],
): { points: PlanarPoint[]; miterPoints: PlanarPoint[] } | null {
  const pts = ccwRing;
  const n = pts.length;
  if (n < 3 || insetMetersPerEdge.length !== n) return null;
  if (inwardNormalsPerEdge.length !== n) return null;

  for (const d of insetMetersPerEdge) {
    if (!Number.isFinite(d) || d < 0) return null;
  }
  if (insetMetersPerEdge.every((d) => d <= 1e-9)) {
    return { points: pts.map((p) => ({ x: p.x, y: p.y })), miterPoints: [] };
  }

  const pieces = splitAtReflexVertices(pts);

  const clippedPieces: PlanarPoint[][] = [];
  for (const piece of pieces) {
    const clipped = clipPieceSequentialHalfPlanes(
      piece.points,
      piece.originalIndices,
      insetMetersPerEdge,
      inwardNormalsPerEdge,
      pieces.length > 1 ? pts : undefined,
    );
    if (clipped.length >= 3 && Math.abs(signedArea(clipped)) > 1e-9) {
      clippedPieces.push(clipped);
    }
  }

  if (clippedPieces.length === 0) return null;

  // Single piece (the common, no-reflex case) — this IS the result.
  let best: PlanarPoint[];
  if (clippedPieces.length === 1) {
    best = clippedPieces[0]!;
  } else {
    // Multiple reflex-split pieces survived clipping — union them back
    // into one ring via polygon-clipping (each piece is itself already a
    // correct convex intersection-of-half-planes result, now ALSO clipped
    // against every other original edge — see clipPieceSequentialHalfPlanes
    // — so adjacent pieces converge on the SAME true boundary near their
    // shared diagonal, meeting it almost exactly, not overlapping in area).
    // 2026-08-07 fix: polygon-clipping's union treats two polygons that
    // only TOUCH along a shared edge (zero area overlap) as topologically
    // separate output components — correct library behavior, but wrong
    // for this caller, which needs one connected ring. Verified on the
    // L-shaped hexagon fixture: two pieces met within 1e-14m (pure
    // floating-point noise) yet still returned as 2 disjoint polygons,
    // and picking only the larger one discarded real buildable area
    // (127.4 sqm kept vs the true combined ~197.6 sqm, confirmed by
    // independent brute-force grid sampling). Scale each piece up by a
    // negligible factor around ITS OWN centroid before unioning — turns a
    // zero-width shared-edge touch into a genuine (imperceptibly small)
    // area overlap so polygon-clipping merges them into one component,
    // then use the ORIGINAL (unscaled) pieces' true union boundary by
    // re-computing area from the unscaled pieces' actual shared vertices
    // (the scale factor is only a merge trigger, never applied to the
    // returned geometry).
    const EXPAND_FACTOR = 1 + 1e-6;
    const expand = (piece: PlanarPoint[]): PlanarPoint[] => {
      let cx = 0;
      let cy = 0;
      for (const p of piece) {
        cx += p.x;
        cy += p.y;
      }
      cx /= piece.length;
      cy /= piece.length;
      return piece.map((p) => ({
        x: cx + (p.x - cx) * EXPAND_FACTOR,
        y: cy + (p.y - cy) * EXPAND_FACTOR,
      }));
    };
    let unioned: polygonClipping.MultiPolygon = [[closeClipRing(expand(clippedPieces[0]!))]];
    for (let i = 1; i < clippedPieces.length; i++) {
      try {
        unioned = polygonClipping.union(unioned, [closeClipRing(expand(clippedPieces[i]!))]);
      } catch {
        return null;
      }
    }
    let bestArea = 0;
    let chosen: PlanarPoint[] | null = null;
    for (const poly of unioned) {
      const outer = poly[0];
      if (!outer || outer.length < 4) continue;
      const open = xyFromClipRing(outer);
      if (open.length < 3) continue;
      const area = Math.abs(signedArea(open));
      if (area > bestArea) {
        bestArea = area;
        chosen = open;
      }
    }
    if (!chosen) return null;
    best = chosen;
  }

  // polygon-clipping's union step (multi-piece path only) can retain a
  // zero-width spike (self-touch) while the interior area is correct —
  // clean before the degeneracy guard sees the ring. Single-piece
  // (no-reflex, common) path also runs this: cheap, and harmless when
  // there is nothing to clean.
  const cleaned = cleanClipRingArtifacts(best);

  // miterPoints (2026-08-07 redesign): under half-plane clipping there is
  // no separate "collapse" step — every surviving vertex IS a genuine
  // half-plane intersection. The one case perEdgeOffsetPlausible's
  // downstream fallback (and R32's edgeMidpointNearKnownMiterPoint) still
  // needs to know about is a genuinely SHORT original edge whose own
  // setback strip contributed ZERO length to the final boundary (its two
  // neighbors' half-planes fully absorbed it) — report that edge's own
  // ENDPOINTS as miterPoints so those downstream fallbacks, unchanged from
  // PR #268, keep working exactly as before for this one case.
  const miterPoints: PlanarPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (insetMetersPerEdge[i]! <= 1e-9) continue;
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormalsPerEdge[i]!;
    const len = Math.hypot(nrm.x, nrm.y);
    if (len < 1e-12) continue;
    const unit = { x: nrm.x / len, y: nrm.y / len };
    const d = insetMetersPerEdge[i]!;
    const targetMid = {
      x: (a.x + b.x) / 2 + unit.x * d,
      y: (a.y + b.y) / 2 + unit.y * d,
    };
    const nearestOnRing = minDistanceToRingBoundary(targetMid, cleaned);
    if (nearestOnRing > Math.max(1.0, d * 0.5)) {
      // This edge's own offset segment does not appear on the final
      // boundary within a reasonable tolerance of its own setback — it was
      // absorbed by its neighbors. Surface its endpoints so the existing
      // miter-proximity fallback (PR #268, unchanged) recognizes it.
      miterPoints.push({ x: a.x, y: a.y }, { x: b.x, y: b.y });
    }
  }

  return { points: cleaned, miterPoints };
}

/**
 * Drop clip-artifact spikes: consecutive near-duplicates, collinear middles,
 * U-turn vertices (out-and-back along the same edge), and vertices that lie on
 * a non-adjacent edge when removing them preserves area (≥99%).
 * Does NOT weaken ringHasSelfTouch — genuinely load-bearing self-touches remain
 * for the guard to reject.
 */
export function cleanClipRingArtifacts(
  points: PlanarPoint[],
  options?: { touchTolM?: number; minAreaKeepRatio?: number },
): PlanarPoint[] {
  const touchTol = options?.touchTolM ?? 0.08;
  const minKeep = options?.minAreaKeepRatio ?? 0.99;
  let pts = dedupeConsecutivePoints(points, 1e-9);
  pts = removeCollinearPoints(pts, 1e-7);
  if (pts.length < 3) return pts;

  const targetArea = Math.abs(signedArea(pts));
  if (targetArea <= 1e-12) return pts;

  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 64) {
    changed = false;
    const n = pts.length;
    for (let v = 0; v < n; v++) {
      const prev = pts[(v + n - 1) % n]!;
      const cur = pts[v]!;
      const nextPt = pts[(v + 1) % n]!;
      const uTurn = isNearUTurn(prev, cur, nextPt);
      const touches = vertexTouchesNonAdjacentEdge(pts, v, touchTol);
      if (!uTurn && !touches) continue;

      const next = pts.filter((_, i) => i !== v);
      if (next.length < 3) continue;
      const nextArea = Math.abs(signedArea(next));
      // Clip spikes: area must stay ~same (within 1%). Reject removals that
      // carve real area (load-bearing self-touch / real notches).
      if (nextArea < targetArea * minKeep) continue;
      if (nextArea > targetArea * (2 - minKeep)) continue;
      if (ringSelfIntersects(next)) continue;
      pts = next;
      changed = true;
      break;
    }
    if (!changed && !ringHasSelfTouch(pts, touchTol)) break;
  }

  pts = dedupeConsecutivePoints(pts, 1e-9);
  pts = removeCollinearPoints(pts, 1e-7);
  return pts;
}

/** Line-line intersection of two infinite lines (p1->p2) and (p3->p4). Null when parallel. */
function lineIntersection(
  p1: PlanarPoint,
  p2: PlanarPoint,
  p3: PlanarPoint,
  p4: PlanarPoint,
): PlanarPoint | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

// The absolute cap is a coarse pre-filter only — the RELATIVE check
// (NOTCH_MAX_RUN_TO_BOUNDING_RATIO, below) is the real discriminator
// between a corner-offset artifact and a genuine short edge on a small
// lot; runEdgesRelativelyShort rejects any run whose edges are not
// genuinely short relative to their OWN bounding edges regardless of what
// this cap allows through. 2026-08-06 live-pipeline harness fix: raised
// from 10m to 20m — verified against 48021:31326's real ring, whose
// notch-run second edge (11.71m) exceeded the prior 10m cap. The relative
// check remains the actual gate; this value only controls how far the
// initial run-extension search is allowed to look.
const NOTCH_MAX_EDGE_LEN_M = 20;
const NOTCH_MIN_BOUNDING_EDGE_LEN_M = 6;
const NOTCH_AREA_TOL_RATIO = 0.02;
const NOTCH_MAX_RUN_EDGES = 3;
/** A run edge must also be at most this fraction of the shorter bounding edge — keeps the absolute cap from ever firing on a genuinely small lot's real short edge. */
const NOTCH_MAX_RUN_TO_BOUNDING_RATIO = 0.35;

/**
 * Collapse a short reflex "notch" run in an offset (strip-union) ring to
 * the analytic miter intersection of its two bounding (long) edges.
 *
 * Root cause (2026-08-06 robust-inward-offset fix): when two adjacent
 * parcel edges meeting at a near-collinear vertex carry DIFFERENT inset
 * distances, insetRingMetersWithNormals's strip-union-difference boundary
 * at that corner is not a single miter point — it retains a short chain of
 * 1-3 edges whose vertices include a turn-sign flip relative to the ring's
 * dominant winding (a genuine geometric artifact of the union operation,
 * not real parcel geometry; the true parcel corner there is a single
 * point). This is invisible to cleanClipRingArtifacts's spike removal (not
 * a near-180deg U-turn, does not touch a non-adjacent edge — it is a
 * short, real-looking notch/step).
 *
 * Detection is EDGE-based, not vertex-based: find a maximal run of
 * consecutive short edges (each <= maxEdgeLenM, AND each at most
 * NOTCH_MAX_RUN_TO_BOUNDING_RATIO of the shorter bounding edge — the
 * relative check is the real discriminator, the absolute cap is only a
 * coarse pre-filter) bracketed on both sides by long edges (each >=
 * minBoundingEdgeLenM), where at least one vertex spanned by the run
 * (including its start/end vertices, which are also collapsed) is reflex
 * relative to the ring's dominant turn sign. Every vertex spanned by the
 * run is replaced by the single line-line intersection of the two
 * bounding (long) edges' supporting lines — i.e. the analytic miter point
 * — PROVIDED that point (a) falls within the true parcel ring when one is
 * supplied (miter-limit backstop — an over-extended miter is rejected and
 * the notch left as a bevel, mirroring CSS/SVG stroke miter-limit
 * fallback), (b) preserves ring area within NOTCH_AREA_TOL_RATIO, and (c)
 * introduces no self-intersection/self-touch. A REAL short edge on a REAL
 * small lot survives untouched whenever
 * collapsing it would fail any of those checks (wrong area, crossing,
 * etc.) — the loop simply moves on and leaves it as-is.
 */
export interface CollapseNotchesResult {
  points: PlanarPoint[];
  /**
   * Every miter point this function created, in the SAME coordinate frame
   * as `points`. Callers (perEdgeOffsetPlausible) use this to scope their
   * own leniency STRICTLY to points this function actually produced —
   * never a heuristic re-guess by edge length, which cannot distinguish a
   * genuine corner-offset artifact from unrelated short/noisy geometry
   * (e.g. a corrupt digitization-noise ring with its own short edges that
   * must still fail plausibility). See perEdgeOffsetPlausible's doc.
   */
  miterPoints: PlanarPoint[];
}

export function collapseNearCollinearOffsetNotches(
  points: PlanarPoint[],
  options?: {
    maxEdgeLenM?: number;
    minBoundingEdgeLenM?: number;
    areaTolRatio?: number;
    /**
     * Miter-limit backstop (P1 containment): when supplied, a candidate
     * miter point that lands outside this ring (beyond containmentTolM) is
     * rejected — that notch is left as-is (bevel) rather than forcing an
     * over-extended miter join outside the true parcel boundary. Mirrors
     * the classic SVG/CSS stroke miter-limit-then-bevel-fallback pattern.
     */
    parcelRing?: PlanarPoint[];
    containmentTolM?: number;
  },
): CollapseNotchesResult {
  const maxEdgeLen = options?.maxEdgeLenM ?? NOTCH_MAX_EDGE_LEN_M;
  const minBoundingLen = options?.minBoundingEdgeLenM ?? NOTCH_MIN_BOUNDING_EDGE_LEN_M;
  const areaTolRatio = options?.areaTolRatio ?? NOTCH_AREA_TOL_RATIO;
  const containmentTol = options?.containmentTolM ?? 0.12;

  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  const miterPoints: PlanarPoint[] = [];
  if (pts.length < 5) return { points: pts, miterPoints }; // need room to drop vertices and stay a polygon

  const targetArea = Math.abs(signedArea(pts));
  if (targetArea <= 1e-12) return { points: pts, miterPoints };

  const dominantSign = ringDominantTurnSign(pts);
  if (dominantSign === 0) return { points: pts, miterPoints };

  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 32) {
    changed = false;
    const n = pts.length;

    // edgeLen(i) = length of edge pts[i] -> pts[i+1].
    const edgeLen = (i: number): number => {
      const a = pts[i % n]!;
      const b = pts[(i + 1) % n]!;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };

    outer: for (let edgeStart = 0; edgeStart < n; edgeStart++) {
      if (edgeLen(edgeStart) > maxEdgeLen) continue; // run must start at a short edge

      // Extend the run while edges stay short (cap NOTCH_MAX_RUN_EDGES to
      // avoid ever collapsing a large fraction of the ring).
      let runEdgeCount = 1;
      while (
        runEdgeCount < NOTCH_MAX_RUN_EDGES &&
        runEdgeCount < n - 2 &&
        edgeLen(edgeStart + runEdgeCount) <= maxEdgeLen
      ) {
        runEdgeCount++;
      }

      // The run spans edges [edgeStart, edgeStart+runEdgeCount) and
      // VERTICES [beforeIdx, afterIdx] inclusive (runEdgeCount+1 vertices
      // total) — every one of them is replaced by a single miter point.
      // Need at least 2 edges (3 vertices) for this to be a genuine notch;
      // a single short edge alone is not a step artifact.
      const beforeIdx = edgeStart % n;
      const afterIdx = (edgeStart + runEdgeCount) % n;
      if (afterIdx === beforeIdx) continue;
      if (runEdgeCount < 2) continue;

      // At least one vertex IN THE RUN (beforeIdx..afterIdx inclusive) must
      // be reflex relative to the ring's dominant winding — the artifact
      // signature (a real corner never flips winding sign locally).
      let anyReflex = false;
      for (let k = 0; k <= runEdgeCount; k++) {
        const idx = (edgeStart + k) % n;
        const p = pts[(idx + n - 1) % n]!;
        const q = pts[idx]!;
        const r = pts[(idx + 1) % n]!;
        const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        if (Math.sign(cross) !== 0 && Math.sign(cross) !== dominantSign) anyReflex = true;
      }
      if (!anyReflex) continue;

      // Bounding edges (the long edges immediately before/after the run)
      // must be substantial — never collapse a genuinely tiny lot feature.
      const priorToBeforeIdx = (beforeIdx + n - 1) % n;
      const afterNextIdx = (afterIdx + 1) % n;
      const priorToBefore = pts[priorToBeforeIdx]!;
      const before = pts[beforeIdx]!;
      const after = pts[afterIdx]!;
      const afterNext = pts[afterNextIdx]!;
      const boundingLenA = Math.hypot(before.x - priorToBefore.x, before.y - priorToBefore.y);
      const boundingLenB = Math.hypot(afterNext.x - after.x, afterNext.y - after.y);
      if (boundingLenA < minBoundingLen || boundingLenB < minBoundingLen) continue;

      // Every edge IN the run must also be small relative to its bounding
      // edges (not just below the absolute cap) — this is what
      // distinguishes a corner-offset artifact from a real short edge on a
      // genuinely small lot feature, where the "short" edge could still be
      // a meaningful fraction of the surrounding edges' length.
      const minBounding = Math.min(boundingLenA, boundingLenB);
      let runEdgesRelativelyShort = true;
      for (let k = 0; k < runEdgeCount; k++) {
        if (edgeLen(edgeStart + k) > minBounding * NOTCH_MAX_RUN_TO_BOUNDING_RATIO) {
          runEdgesRelativelyShort = false;
          break;
        }
      }
      if (!runEdgesRelativelyShort) continue;

      const miter = lineIntersection(priorToBefore, before, after, afterNext);
      if (!miter || !Number.isFinite(miter.x) || !Number.isFinite(miter.y)) continue;

      // Miter-limit backstop: never let the analytic intersection land
      // outside the true parcel ring (classic miter-join over-extension —
      // the SAME failure mode CSS/SVG stroke miter joins guard against
      // with a miter-limit-then-bevel fallback). Skip this notch (bevel:
      // leave it as-is) when a parcel ring was supplied and the miter
      // point falls outside it.
      if (options?.parcelRing && !pointInOrOnPolygon(miter, options.parcelRing, containmentTol)) {
        continue;
      }

      // Rebuild: keep every vertex from `after` around to `before`
      // inclusive (ring order), splicing the miter point in between them
      // (i.e. replacing before/after and all interior run vertices with a
      // single point) — before and after themselves are also folded into
      // the miter since they bound the SHORT run on both sides and a
      // proper miter join replaces the whole short chain with one point.
      const keep = n - runEdgeCount - 1; // vertices strictly outside [before..after] inclusive
      const rebuilt: PlanarPoint[] = [miter];
      for (let k = 0; k < keep; k++) {
        const idx = (afterNextIdx + k) % n;
        rebuilt.push(pts[idx]!);
      }

      if (rebuilt.length < 3) continue outer;
      const candArea = Math.abs(signedArea(rebuilt));
      if (Math.abs(candArea - targetArea) > targetArea * areaTolRatio) continue;
      if (ringSelfIntersects(rebuilt)) continue;
      if (ringHasSelfTouch(rebuilt)) continue;

      pts = rebuilt;
      miterPoints.push({ x: miter.x, y: miter.y });
      changed = true;
      break;
    }
  }

  return { points: pts, miterPoints };
}

/** Dominant turn sign across a ring's significant (non-collinear) vertices. */
function ringDominantTurnSign(points: PlanarPoint[]): number {
  const n = points.length;
  let posCount = 0;
  let negCount = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross > 1e-9) posCount++;
    else if (cross < -1e-9) negCount++;
  }
  if (posCount === 0 && negCount === 0) return 0;
  return posCount >= negCount ? 1 : -1;
}

/** True when path a→b→c nearly reverses (clip out-and-back spike). */
function isNearUTurn(
  a: PlanarPoint,
  b: PlanarPoint,
  c: PlanarPoint,
  cosTol = -0.85,
): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const lab = Math.hypot(abx, aby);
  const lbc = Math.hypot(bcx, bcy);
  if (lab < 1e-9 || lbc < 1e-9) return true;
  const cos = (abx * bcx + aby * bcy) / (lab * lbc);
  return cos < cosTol;
}

function dedupeConsecutivePoints(
  points: PlanarPoint[],
  tol: number,
): PlanarPoint[] {
  if (points.length === 0) return [];
  const out: PlanarPoint[] = [{ x: points[0]!.x, y: points[0]!.y }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > tol) {
      out.push({ x: p.x, y: p.y });
    }
  }
  if (
    out.length > 2 &&
    Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) <=
      tol
  ) {
    out.pop();
  }
  return out;
}

function removeCollinearPoints(points: PlanarPoint[], tol: number): PlanarPoint[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const out: PlanarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > tol) {
      out.push({ x: b.x, y: b.y });
    }
  }
  return out.length >= 3 ? out : points.map((p) => ({ x: p.x, y: p.y }));
}

function vertexTouchesNonAdjacentEdge(
  points: PlanarPoint[],
  v: number,
  tol: number,
): boolean {
  const n = points.length;
  const p = points[v]!;
  for (let e = 0; e < n; e++) {
    if (e === v || (e + 1) % n === v || e === (v + 1) % n) continue;
    if (pointOnSegment(p, points[e]!, points[(e + 1) % n]!, tol)) return true;
  }
  return false;
}

function pointOnSegment(p: PlanarPoint, a: PlanarPoint, b: PlanarPoint, tol: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y) <= tol;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy) <= tol;
}

/** Ray-cast point-in-polygon with an on-edge tolerance (local metres). */
export function pointInOrOnPolygon(p: PlanarPoint, poly: PlanarPoint[], tol = 0.05): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (pointOnSegment(p, a, b, tol)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segCrossProper(a: PlanarPoint, b: PlanarPoint, c: PlanarPoint, d: PlanarPoint): boolean {
  const cross = (o: PlanarPoint, p: PlanarPoint, q: PlanarPoint) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (
    ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) &&
    ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))
  ) {
    return true;
  }
  return false;
}

export function ringSelfIntersects(points: PlanarPoint[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === n - 1) continue;
      const c = points[j]!;
      const d = points[(j + 1) % n]!;
      if (segCrossProper(a, b, c, d)) return true;
    }
  }
  return false;
}

export function ringHasSelfTouch(
  points: PlanarPoint[],
  touchTolM = 0.08,
): boolean {
  const n = points.length;
  for (let v = 0; v < n; v++) {
    if (vertexTouchesNonAdjacentEdge(points, v, touchTolM)) return true;
  }
  return false;
}

function midpoint(a: PlanarPoint, b: PlanarPoint): PlanarPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** True when every significant turn is consistently signed (convex polygon). */
export function isConvexPlanarRing(
  points: PlanarPoint[],
  minTurnDeg = 12,
): boolean {
  const n = points.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (ab < 1e-6 || bc < 1e-6) continue;
    const sin = cross / (ab * bc);
    const turnDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, sin))) * (180 / Math.PI));
    if (turnDeg < minTurnDeg) continue;
    const s = Math.sign(cross);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Minimum distance from point p to the ring boundary (nearest point on any edge). */
function minDistanceToRingBoundary(p: PlanarPoint, ring: PlanarPoint[]): number {
  const n = ring.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let cx: number;
    let cy: number;
    if (len2 < 1e-12) {
      cx = a.x;
      cy = a.y;
    } else {
      let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      cx = a.x + t * abx;
      cy = a.y + t * aby;
    }
    const dist = Math.hypot(p.x - cx, p.y - cy);
    if (dist < best) best = dist;
  }
  return best;
}

/** Nearest distance from point p to any point in a candidate set. */
function nearestDistanceToPointSet(p: PlanarPoint, candidates: PlanarPoint[]): number {
  let best = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Per-original-edge offset plausibility. For a normal edge, verifies the
 * strict pair of just-inside/just-outside midpoint tests against the inset
 * boundary. For an edge whose dedicated offset segment was absorbed into a
 * neighboring notch-collapse miter join (collapseNearCollinearOffsetNotches
 * — 2026-08-06 robust-inward-offset fix), the strict midpoint-in-polygon
 * test can legitimately fail even though the offset is correct: there is
 * no longer a dedicated inset EDGE sitting at distance `d` from this
 * original edge's own midpoint, because it was folded into a single miter
 * point shared with an adjacent edge.
 *
 * The leniency for that case is scoped STRICTLY to points
 * collapseNearCollinearOffsetNotches actually produced (`knownMiterPoints`)
 * — never re-derived heuristically from edge length. An earlier version of
 * this function used a length-relative heuristic ("this edge is short
 * relative to its neighbors, so maybe it was absorbed") and that heuristic
 * cannot distinguish a genuine corner-offset artifact from an unrelated
 * short/noisy edge on a corrupt or digitization-noise ring (verified
 * regression: PARCEL_34073_CORRUPT_TXGIO, whose own noise vertices are
 * near-collinear and produce short edges by the SAME signature, yet must
 * still fail plausibility before scrubbing). Requiring proximity to an
 * ACTUAL miter point this run created eliminates that ambiguity entirely.
 */
export function perEdgeOffsetPlausible(
  orig: PlanarPoint[],
  inset: PlanarPoint[],
  insetMetersPerEdge: number[],
  inwardNormalsPerEdge?: PlanarPoint[],
  knownMiterPoints?: PlanarPoint[],
): boolean {
  const n = orig.length;
  for (let i = 0; i < n; i++) {
    const d = insetMetersPerEdge[i]!;
    if (d <= 1e-6) continue;
    const a = orig[i]!;
    const b = orig[(i + 1) % n]!;
    const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLen < 1e-6) return false;
    if (d >= edgeLen * 0.95) continue;
    const stored = inwardNormalsPerEdge?.[i];
    const nrm = stored
      ? (() => {
          const len = Math.hypot(stored.x, stored.y);
          return len < 1e-12 ? null : { x: stored.x / len, y: stored.y / len };
        })()
      : inwardNormal(a, b);
    if (!nrm) return false;
    const mid = midpoint(a, b);
    const justInsideBuildable = {
      x: mid.x + nrm.x * (d + 0.12),
      y: mid.y + nrm.y * (d + 0.12),
    };
    const strictPass = pointInOrOnPolygon(justInsideBuildable, inset, 0.2);
    const strictForbiddenOk =
      strictPass && d > 0.25
        ? !pointInOrOnPolygon(
            { x: mid.x + nrm.x * Math.max(0, d - 0.15), y: mid.y + nrm.y * Math.max(0, d - 0.15) },
            inset,
            0.05,
          )
        : true;

    if (strictPass && strictForbiddenOk) continue;

    // Notch-collapse fallback, scoped to edges whose nearest inset-boundary
    // vertex is an ACTUAL miter point collapseNearCollinearOffsetNotches
    // created this run — never a length-based guess. 2026-08-07 fix: this
    // is no longer the ONLY fallback (see the containment-satisfied check
    // below) — under the half-plane-clipping offset core, many genuinely
    // dominated edges produce NO miterPoints at all (verified: 48021:31317's
    // real ring, front(25ft) absorbed by an adjacent rear(25ft) at a
    // near-collinear vertex with zero reflex split, has an empty
    // knownMiterPoints array), so an empty/absent knownMiterPoints must
    // fall through to the containment check rather than fail closed here.
    if (knownMiterPoints && knownMiterPoints.length > 0) {
      const nearestMiterDist = nearestDistanceToPointSet(mid, knownMiterPoints);
      // 2026-08-06 live-pipeline harness fix: the miter point is the
      // intersection of the TWO BOUNDING edges' offset lines — its distance
      // from the absorbed edge's own (tiny) midpoint scales with the
      // BOUNDING edges' setback distances, not with the absorbed edge's own
      // length. Verified against 48021:31308's real ring across two
      // different role/inset assignments: dist-to-miter / max(insetMetersPerEdge)
      // measured 1.01 in both cases (4.63m / 4.57m and 7.69m / 7.62m) — a
      // tight, physically-motivated ratio. An edge-length-based cap (the
      // prior version of this check) was an untested assumption that broke
      // on live geometry with a larger front/rear setback delta at the
      // near-collinear corner; this replaces it with the verified relation,
      // with generous slack for off-axis corners.
      const maxInsetScale = Math.max(...insetMetersPerEdge.filter((x) => Number.isFinite(x) && x > 0), 0);
      if (nearestMiterDist <= maxInsetScale * 1.5 + 1.0) continue;
    }

    // Containment-satisfied fallback (2026-08-07 OFFSET-CORE-VARIABLE-
    // DISTANCE redesign, master planner ruling 2 principle applied here
    // too): when the miter-distance check above still rejects the edge
    // (e.g. a reflex-vertex-adjacent edge absorbed by TWO or more
    // neighboring constraints at once, whose combined effect places it
    // farther from any single miter point than the miter-distance cap
    // anticipates — verified on a synthetic L-shaped hexagon fixture,
    // front(20ft)/side(5ft) roles, where an absorbed side edge near the
    // reflex corner measured 11.0m from its nearest miter point against a
    // 10.14m cap, an 8% miss, while the final ring's true area matched
    // independent brute-force ground truth (~197.6 sqm) almost exactly),
    // fall back to the more fundamental question this whole check exists
    // to answer: is this edge's own setback constraint ACTUALLY satisfied
    // everywhere on the final ring, even without a dedicated boundary
    // segment of its own? An edge is satisfied by containment when EVERY
    // vertex of the final inset ring already lies on the buildable side of
    // this edge's own offset line (i.e. the final shape never comes
    // closer to this edge than its own nominal setback requires) — this
    // is a direct geometric fact about the returned ring, not a
    // proximity guess, and can only ever be MORE permissive to a
    // genuinely-dominated edge, never to a genuinely wrong offset (a
    // wrong offset produces a ring with at least one vertex violating the
    // edge's own line, which fails this check exactly like it fails the
    // strict test above).
    let allVerticesSatisfyOwnLine = true;
    for (const p of inset) {
      const side = (p.x - mid.x) * nrm.x + (p.y - mid.y) * nrm.y;
      if (side < d - 0.15) {
        allVerticesSatisfyOwnLine = false;
        break;
      }
    }
    // No separate "does the measured distance match THIS edge's own
    // nominal inset" check for an absorbed edge — by construction an
    // absorbed edge has no dedicated offset segment of its own; its area
    // was folded into the neighboring miter join (or, under the
    // half-plane-clipping core, into a neighboring constraint's
    // dominance), which is validated by the offset core's own
    // area-preservation, containment, and self-intersection checks before
    // it is ever returned. Requiring the absorbed edge's own setback
    // distance to independently re-appear at its midpoint is incoherent —
    // that is precisely what absorption means it will NOT do (verified:
    // 48021:31308's edge 4, an absorbed 5ft side, measures ~7.69m from its
    // own midpoint to the nearest boundary point because that boundary is
    // dominated by its 25ft neighbor's setback, not because the offset is
    // wrong). The containment check above is the SAME principle made
    // direct: rather than inferring domination from proximity to a miter
    // point, it checks domination as a fact about the returned ring.
    if (allVerticesSatisfyOwnLine) continue;
    return false;
  }
  return true;
}

function insetAreaTooSmall(orig: PlanarPoint[], inset: PlanarPoint[]): boolean {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  return insetArea < origArea * 0.0025;
}

/**
 * Mechanical degeneracy check shared by depth-warm and site-plan paths.
 */
export function isInsetDegenerate(
  orig: PlanarPoint[],
  inset: PlanarPoint[],
  insetMetersPerEdge: number[],
  inwardNormalsPerEdge?: PlanarPoint[],
  knownMiterPoints?: PlanarPoint[],
): boolean {
  const insetArea = signedArea(inset);
  if (insetArea <= 0) return true;
  if (insetAreaTooSmall(orig, inset)) return true;
  if (ringSelfIntersects(inset)) return true;
  if (ringHasSelfTouch(inset)) return true;
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig)) return true;
  }
  if (
    !perEdgeOffsetPlausible(orig, inset, insetMetersPerEdge, inwardNormalsPerEdge, knownMiterPoints)
  ) {
    return true;
  }
  return false;
}
