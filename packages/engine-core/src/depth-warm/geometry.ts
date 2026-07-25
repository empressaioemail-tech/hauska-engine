/**
 * Pure geometry core for the buildable-envelope derivation.
 *
 * Given a parcel polygon ring (lng/lat) and a PER-EDGE inset distance (feet),
 * produce the inset ("buildable") ring via per-edge inward setback STRIPS,
 * unioned and differenced from the parcel (variable-distance inset). A uniform
 * negative buffer of the whole polygon is WRONG for setbacks — front/side/rear
 * differ — so each labeled edge is offset independently and composed with
 * boolean ops (polygon-clipping).
 *
 * Projection + validation are implemented with plain math over a local
 * equirectangular frame about the ring centroid. At parcel scale the distortion
 * is negligible and keeps the offset in metres.
 *
 * Kept free of I/O, Express, and road/geocode signals so the offset math is
 * unit-testable in isolation. Edge LABELING lives in edgeLabeling.ts.
 */

import polygonClipping from "polygon-clipping";

const FEET_PER_METER = 3.280839895;
const EARTH_RADIUS_M = 6_378_137;

/** Minimum edge length treated as survey noise when inferring front from shape. */
export const SURVEY_NOISE_THRESHOLD_M = 1.5;

export type LngLat = [number, number];

/** A closed ring: first === last coordinate. lng/lat (WGS84). */
export type Ring = LngLat[];

/** Local planar point in metres, relative to the projection origin. */
interface XY {
  x: number;
  y: number;
}

export interface ProjectedRing {
  /** Open ring (no duplicated closing vertex) in local metres, CCW-oriented. */
  points: XY[];
  originLng: number;
  originLat: number;
  /** metres-per-degree scale used, kept so we can invert exactly. */
  mPerDegLng: number;
  mPerDegLat: number;
}

export interface GeometryCorrectnessResult {
  pass: boolean;
  reasons: string[];
}

export function feetToMeters(ft: number): number {
  return ft / FEET_PER_METER;
}

export function metersToFeet(m: number): number {
  return m * FEET_PER_METER;
}

/**
 * Strip a closed ring's duplicated last vertex (if present) and any exact
 * consecutive duplicates, returning an "open" vertex list. Returns [] when the
 * input cannot form a polygon (fewer than 3 distinct vertices).
 */
export function openRing(ring: Ring): LngLat[] {
  const pts: LngLat[] = [];
  for (const c of ring) {
    if (
      !Array.isArray(c) ||
      c.length < 2 ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    ) {
      continue;
    }
    const last = pts[pts.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    pts.push([c[0], c[1]]);
  }
  if (
    pts.length > 1 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
  ) {
    pts.pop();
  }
  return pts.length >= 3 ? pts : [];
}

/** Signed area (in local metres^2) of an open XY ring. Positive => CCW. */
function signedArea(points: XY[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Project a ring (lng/lat) into local metres about its centroid, orient CCW.
 * Returns null when the ring is degenerate (fewer than 3 distinct vertices).
 */
export function projectRing(ring: Ring): ProjectedRing | null {
  const open = openRing(ring);
  if (!open.length) return null;

  const originLng = open.reduce((s, p) => s + p[0], 0) / open.length;
  const originLat = open.reduce((s, p) => s + p[1], 0) / open.length;

  const latRad = (originLat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);

  let points: XY[] = open.map(([lng, lat]) => ({
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  }));

  if (signedArea(points) < 0) {
    points = points.slice().reverse();
  }

  return { points, originLng, originLat, mPerDegLng, mPerDegLat };
}

/** Invert a local XY point back to lng/lat. */
function unproject(p: XY, proj: ProjectedRing): LngLat {
  return [
    proj.originLng + p.x / proj.mPerDegLng,
    proj.originLat + p.y / proj.mPerDegLat,
  ];
}

/** Area (m^2) of a projected (CCW) ring. */
export function ringAreaM2(points: XY[]): number {
  return Math.abs(signedArea(points));
}

/**
 * Public: area in square feet of a lng/lat ring.
 */
export function ringAreaSqFt(ring: Ring): number {
  const proj = projectRing(ring);
  if (!proj) return 0;
  const m2 = ringAreaM2(proj.points);
  return m2 * FEET_PER_METER * FEET_PER_METER;
}

/** Project ring vertices into an existing parcel frame (metres). */
function projectRingInFrame(ring: Ring, frame: ProjectedRing): XY[] | null {
  const open = openRing(ring);
  if (!open.length) return null;
  return open.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

/** Unit inward normal (left of the CCW edge direction) for edge i -> i+1. */
function inwardNormal(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: -dy / len, y: dx / len };
}

function closeClipRing(points: XY[]): polygonClipping.Ring {
  const ring: polygonClipping.Ring = points.map((p) => [p.x, p.y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function xyFromClipRing(ring: polygonClipping.Ring): XY[] {
  const open =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring.slice();
  return open.map(([x, y]) => ({ x, y }));
}

/**
 * Inward setback strip for one edge: the band between the boundary segment and
 * its parallel offset at distance d (metres) inside the parcel.
 */
function setbackStrip(a: XY, b: XY, nrm: XY, distM: number): polygonClipping.Polygon | null {
  if (distM <= 1e-9) return null;
  const aOff: XY = { x: a.x + nrm.x * distM, y: a.y + nrm.y * distM };
  const bOff: XY = { x: b.x + nrm.x * distM, y: b.y + nrm.y * distM };
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
 * Variable-distance inset via strip union + difference (polygon-clipping).
 *
 * `insetMetersPerEdge[i]` is the inward offset for edge i (vertex i -> i+1).
 */
function insetProjected(
  proj: ProjectedRing,
  insetMetersPerEdge: number[],
): { points: XY[] } | null {
  const pts = proj.points;
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
      forbidden = forbidden
        ? polygonClipping.union(forbidden, strip)
        : [strip];
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

  let best: XY[] | null = null;
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
  return { points: best };
}

/** Ray-cast point-in-polygon with an on-edge tolerance (local metres). */
function pointInOrOnPolygon(p: XY, poly: XY[], tol = 0.05): boolean {
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

function pointOnSegment(p: XY, a: XY, b: XY, tol: number): boolean {
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

function segCrossProper(a: XY, b: XY, c: XY, d: XY): boolean {
  const cross = (o: XY, p: XY, q: XY) =>
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

function ringSelfIntersects(points: XY[]): boolean {
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

/** Vertex lying on a non-adjacent edge (self-touch / bowtie precursor). */
function ringHasSelfTouch(points: XY[]): boolean {
  const n = points.length;
  for (let v = 0; v < n; v++) {
    const p = points[v]!;
    for (let e = 0; e < n; e++) {
      if (e === v || (e + 1) % n === v || e === (v + 1) % n) continue;
      const a = points[e]!;
      const b = points[(e + 1) % n]!;
      if (pointOnSegment(p, a, b, 0.08)) return true;
    }
  }
  return false;
}

function midpoint(a: XY, b: XY): XY {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * For each parcel edge with setback d, the point d metres inward from the edge
 * midpoint must lie inside (or on) the inset ring; a point slightly farther
 * inward must remain inside the parcel but outside the inset.
 */
function perEdgeOffsetPlausible(
  orig: XY[],
  inset: XY[],
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

function insetIsDegenerate(
  orig: XY[],
  inset: XY[],
  insetMetersPerEdge: number[],
): boolean {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  if (insetArea <= 0) return true;
  if (insetArea < origArea * 0.0025) return true;
  if (ringSelfIntersects(inset)) return true;
  if (ringHasSelfTouch(inset)) return true;
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig)) return true;
  }
  if (!perEdgeOffsetPlausible(orig, inset, insetMetersPerEdge)) return true;
  return false;
}

/**
 * Mechanical geometry-correctness gate (27c WDLL 2). Exported for CI regression
 * tests — fails closed on self-intersection, containment violations, or
 * implausible per-edge offsets.
 */
export function geometryCorrectnessGate(
  parcelRing: Ring,
  insetRing: Ring | null,
  insetFeetPerEdge: number[],
): GeometryCorrectnessResult {
  const reasons: string[] = [];
  if (!insetRing) {
    return { pass: false, reasons: ["inset ring is null"] };
  }
  const parcelProj = projectRing(parcelRing);
  if (!parcelProj || !insetRing) {
    return { pass: false, reasons: ["parcel or inset is not a valid polygon"] };
  }
  const orig = parcelProj.points;
  const inset = projectRingInFrame(insetRing, parcelProj);
  if (!inset || inset.length < 3) {
    return { pass: false, reasons: ["inset is not a valid polygon"] };
  }
  if (insetFeetPerEdge.length !== orig.length) {
    reasons.push(
      `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${orig.length})`,
    );
  }
  const insetMeters = insetFeetPerEdge.map((ft) => feetToMeters(Math.max(0, ft)));
  if (signedArea(inset) <= 0) reasons.push("inset orientation flipped or zero area");
  if (ringSelfIntersects(inset)) reasons.push("inset ring self-intersects");
  if (ringHasSelfTouch(inset)) reasons.push("inset ring has self-touch");
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig, 0.12)) {
      reasons.push("inset vertex lies outside parcel");
      break;
    }
  }
  if (!perEdgeOffsetPlausible(orig, inset, insetMeters)) {
    reasons.push("per-edge offset distance implausible");
  }
  if (insetAreaTooSmall(orig, inset)) {
    reasons.push("inset collapsed to a sliver relative to parcel");
  }
  return { pass: reasons.length === 0, reasons };
}

function insetAreaTooSmall(orig: XY[], inset: XY[]): boolean {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  return insetArea < origArea * 0.0025;
}

export interface InsetResult {
  ring: Ring | null;
  areaSqFt: number;
  parcelAreaSqFt: number;
  empty: boolean;
  emptyReason?: string;
}

/**
 * Produce the buildable envelope for a parcel ring given a per-edge setback
 * distance in FEET. Preserves the public API; uses strip-union-difference
 * internally for variable-distance inset.
 */
export function insetPerEdge(
  ring: Ring,
  insetFeetPerEdge: number[],
): InsetResult {
  const proj = projectRing(ring);
  if (!proj) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt: 0,
      empty: true,
      emptyReason: "parcel geometry is not a valid polygon",
    };
  }
  const parcelAreaSqFt =
    ringAreaM2(proj.points) * FEET_PER_METER * FEET_PER_METER;

  const n = proj.points.length;
  if (insetFeetPerEdge.length !== n) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${n})`,
    };
  }

  if (insetFeetPerEdge.some((ft) => !Number.isFinite(ft))) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "non-finite setback distance",
    };
  }

  const insetMeters = insetFeetPerEdge.map((ft) =>
    feetToMeters(Math.max(0, ft)),
  );
  const insetXY = insetProjected(proj, insetMeters);
  if (!insetXY) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason:
        "setbacks leave no buildable area (offset lines did not close)",
    };
  }

  if (insetIsDegenerate(proj.points, insetXY.points, insetMeters)) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "setbacks exceed the lot — no buildable area remains",
    };
  }

  const insetArea =
    ringAreaM2(insetXY.points) * FEET_PER_METER * FEET_PER_METER;
  const closed: Ring = insetXY.points.map((p) => unproject(p, proj));
  closed.push([closed[0]![0], closed[0]![1]]);

  const fullGate = geometryCorrectnessGate(ring, closed, insetFeetPerEdge);
  if (!fullGate.pass) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `geometry failed correctness gate (${fullGate.reasons.join("; ")})`,
    };
  }

  return {
    ring: closed,
    areaSqFt: insetArea,
    parcelAreaSqFt,
    empty: false,
  };
}
