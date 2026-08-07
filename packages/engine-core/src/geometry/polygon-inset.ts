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
 * Variable-distance inset using STORED inward normals per edge (S2-U3).
 * Does not re-derive orientation from ring winding at offset time.
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

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(pts)];

  let forbidden: polygonClipping.MultiPolygon | null = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormalsPerEdge[i]!;
    if (!Number.isFinite(nrm.x) || !Number.isFinite(nrm.y)) return null;
    const len = Math.hypot(nrm.x, nrm.y);
    if (len < 1e-12) continue;
    const unit = { x: nrm.x / len, y: nrm.y / len };
    const strip = setbackStrip(a, b, unit, insetMetersPerEdge[i]!);
    if (!strip) continue;
    try {
      forbidden = forbidden ? polygonClipping.union(forbidden, strip) : [strip];
    } catch {
      return null;
    }
  }

  if (!forbidden) {
    return { points: pts.map((p) => ({ x: p.x, y: p.y })), miterPoints: [] };
  }

  let diff: polygonClipping.MultiPolygon;
  try {
    diff = polygonClipping.difference(parcelPoly, forbidden);
  } catch {
    return null;
  }
  if (!diff.length) return null;

  let best: PlanarPoint[] | null = null;
  let bestArea = 0;
  for (const poly of diff) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const open = xyFromClipRing(outer);
    if (open.length < 3) continue;
    const area = Math.abs(signedArea(open));
    if (area > bestArea) {
      bestArea = area;
      best = open;
    }
  }

  if (!best) return null;
  // polygon-clipping difference can retain the original edge as a zero-width
  // spike (self-touch) while the interior area is correct — clean before the
  // degeneracy guard sees the ring (PATCH-A). Guard stays strict on leftovers.
  const cleaned = cleanClipRingArtifacts(best);
  // 2026-08-06 robust-inward-offset fix: when two adjacent parcel edges meet
  // at a near-collinear vertex and carry DIFFERENT inset distances, the
  // strip-union boundary at that corner is not a clean miter join — it
  // retains a short reflex "step" (two short edges with a turn-sign flip
  // relative to the rest of the ring) instead of a single intersection
  // point. PATCH-A's spike cleanup does not catch this (it is not a U-turn
  // and does not touch a non-adjacent edge — it is a genuine small notch).
  // Collapse it IN OFFSET SPACE to the analytic miter point of the two
  // bounding (long) offset edges, never touching the original parcel ring.
  // The parcel ring is passed only as a miter-limit backstop (P1
  // containment) — a candidate miter point that would land outside the
  // parcel is rejected and that notch is left as a bevel instead.
  const collapsed = collapseNearCollinearOffsetNotches(cleaned, { parcelRing: pts });
  return { points: collapsed.points, miterPoints: collapsed.miterPoints };
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
    // created this run — never a length-based guess.
    if (!knownMiterPoints || knownMiterPoints.length === 0) return false;
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
    if (nearestMiterDist > maxInsetScale * 1.5 + 1.0) return false;

    // No separate "does the measured distance match THIS edge's own
    // nominal inset" check for an absorbed edge — by construction an
    // absorbed edge has no dedicated offset segment of its own; its area
    // was folded into the neighboring miter join, which is validated by
    // collapseNearCollinearOffsetNotches's own area-preservation,
    // containment, and self-intersection checks before it is ever
    // returned. Requiring the absorbed edge's own setback distance to
    // independently re-appear at its midpoint is incoherent — that is
    // precisely what absorption means it will NOT do (verified:
    // 48021:31308's edge 4, an absorbed 5ft side, measures ~7.69m from its
    // own midpoint to the nearest boundary point because that boundary is
    // dominated by its 25ft neighbor's setback, not because the offset is
    // wrong).
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
