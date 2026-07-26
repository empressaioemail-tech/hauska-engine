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
): { points: PlanarPoint[] } | null {
  const pts = ccwRing;
  const n = pts.length;
  if (n < 3 || insetMetersPerEdge.length !== n) return null;

  for (const d of insetMetersPerEdge) {
    if (!Number.isFinite(d) || d < 0) return null;
  }

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(pts)];

  let forbidden: polygonClipping.MultiPolygon | null = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormal(a, b);
    if (!nrm) continue;
    const strip = setbackStrip(a, b, nrm, insetMetersPerEdge[i]!);
    if (!strip) continue;
    try {
      forbidden = forbidden ? polygonClipping.union(forbidden, strip) : [strip];
    } catch {
      return null;
    }
  }

  if (!forbidden) {
    return { points: pts.map((p) => ({ x: p.x, y: p.y })) };
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
  return { points: cleanClipRingArtifacts(best) };
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

/** Per-edge midpoint plausibility check (exported for geometryCorrectnessGate). */
export function perEdgeOffsetPlausible(
  orig: PlanarPoint[],
  inset: PlanarPoint[],
  insetMetersPerEdge: number[],
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
    const nrm = inwardNormal(a, b);
    if (!nrm) return false;
    const mid = midpoint(a, b);
    const justInsideBuildable = {
      x: mid.x + nrm.x * (d + 0.12),
      y: mid.y + nrm.y * (d + 0.12),
    };
    if (!pointInOrOnPolygon(justInsideBuildable, inset, 0.2)) return false;
    if (d > 0.25) {
      const stillForbidden = {
        x: mid.x + nrm.x * Math.max(0, d - 0.15),
        y: mid.y + nrm.y * Math.max(0, d - 0.15),
      };
      if (pointInOrOnPolygon(stillForbidden, inset, 0.05)) return false;
    }
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
): boolean {
  const insetArea = signedArea(inset);
  if (insetArea <= 0) return true;
  if (insetAreaTooSmall(orig, inset)) return true;
  if (ringSelfIntersects(inset)) return true;
  if (ringHasSelfTouch(inset)) return true;
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig)) return true;
  }
  if (!perEdgeOffsetPlausible(orig, inset, insetMetersPerEdge)) return true;
  return false;
}
