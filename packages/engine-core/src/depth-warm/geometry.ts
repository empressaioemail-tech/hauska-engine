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

import {
  buildInsetClipperInput,
  insetRingMeters,
  insetRingMetersFromClipperInput,
  isInsetDegenerate,
  perEdgeOffsetPlausible,
  pointInOrOnPolygon,
  ringHasSelfTouch,
  ringSelfIntersects,
  signedArea,
} from "../geometry/polygon-inset.js";

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

/**
 * Project an ARBITRARY point list (not a ring — no closed/≥3-vertex
 * requirement, unlike openRing/projectRingInFrame) into an existing parcel
 * frame. Used for miterPoints, which is commonly just 1-2 points and would
 * be silently dropped by projectRingInFrame's openRing-based ring parsing.
 */
function projectPointsInFrame(points: Ring, frame: ProjectedRing): XY[] {
  return points
    .filter(
      (c): c is LngLat =>
        Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]),
    )
    .map(([lng, lat]) => ({
      x: (lng - frame.originLng) * frame.mPerDegLng,
      y: (lat - frame.originLat) * frame.mPerDegLat,
    }));
}

/** Variable-distance inset on a projected CCW ring (delegates to shared polygon-inset). */
function insetProjected(
  proj: ProjectedRing,
  insetMetersPerEdge: number[],
): { points: XY[]; miterPoints: XY[] } | null {
  return insetRingMeters(proj.points, insetMetersPerEdge);
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
  storedInwardNormals?: Array<{ x: number; y: number }>,
  /**
   * Miter points collapseNearCollinearOffsetNotches produced for THIS
   * inset, in WGS84 (Ring) — the SAME representation as parcelRing/
   * insetRing, so ANY caller holding onto a WarmCandidate's
   * miterPointsWgs84 field can pass it here without needing access to an
   * internal projected frame. Re-projected into this function's OWN
   * parcelProj frame below, so it is never subject to floating-point
   * frame drift against a caller's separately-computed projection (2026-08-06
   * live-pipeline fix: verifyWarmCandidateMechanically calls this gate a
   * SECOND time, independent of insetPerEdge's own internal call, and had
   * no access to insetXY.miterPoints at all before WarmCandidate carried
   * them — this parameter closes that gap. See perEdgeOffsetPlausible).
   */
  knownMiterPointsWgs84?: Ring,
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
  const knownMiterPoints =
    knownMiterPointsWgs84 && knownMiterPointsWgs84.length > 0
      ? projectPointsInFrame(knownMiterPointsWgs84, parcelProj)
      : undefined;
  if (!perEdgeOffsetPlausible(orig, inset, insetMeters, storedInwardNormals, knownMiterPoints)) {
    reasons.push("per-edge offset distance implausible");
  }
  if (Math.abs(signedArea(inset)) < Math.abs(signedArea(orig)) * 0.0025) {
    reasons.push("inset collapsed to a sliver relative to parcel");
  }
  return { pass: reasons.length === 0, reasons };
}

export interface InsetResult {
  ring: Ring | null;
  areaSqFt: number;
  parcelAreaSqFt: number;
  empty: boolean;
  emptyReason?: string;
  /**
   * Miter points collapseNearCollinearOffsetNotches produced building this
   * inset (WGS84). Present only when `empty` is false and at least one
   * notch was collapsed. Callers that re-run geometryCorrectnessGate
   * independently of this function's own internal call (e.g.
   * verifyWarmCandidateMechanically) MUST pass this through — without it,
   * the second gate call is blind to the collapse and can reject a
   * correct, already-validated envelope (2026-08-06 live-pipeline fix).
   */
  miterPointsWgs84?: Ring;
}

export interface StoredEdgeInsetInput {
  edgeIndex: number;
  insetFeet: number;
  inwardNormal: { x: number; y: number };
}

/**
 * Produce buildable envelope using STORED inward normals from the boundary
 * primitive (S2-U3). Orientation-invariant — does not re-derive inward at offset time.
 */
export function insetPerEdgeFromPrimitive(
  ring: Ring,
  storedEdges: ReadonlyArray<StoredEdgeInsetInput>,
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
  const insetFeetPerEdge = Array.from({ length: n }, () => 0);
  const inwardNormals = Array.from({ length: n }, () => ({ x: 0, y: 0 }));

  for (const edge of storedEdges) {
    if (edge.edgeIndex < 0 || edge.edgeIndex >= n) {
      return {
        ring: null,
        areaSqFt: 0,
        parcelAreaSqFt,
        empty: true,
        emptyReason: `stored edge index ${edge.edgeIndex} out of range (n=${n})`,
      };
    }
    insetFeetPerEdge[edge.edgeIndex] = edge.insetFeet;
    inwardNormals[edge.edgeIndex] = {
      x: edge.inwardNormal.x,
      y: edge.inwardNormal.y,
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
  // Joined-structure invariant (2026-08-07, master planner ruling — cheap
  // insurance against the parallel-array desync class of defect, see
  // buildInsetClipperInput's doc comment): validates ring/inset/normal
  // counts agree before they ever reach the clipper, rather than trusting
  // three separately-built arrays stay in lockstep by convention.
  const clipperInput = buildInsetClipperInput(
    proj.points,
    insetMeters,
    inwardNormals,
  );
  const insetXY = insetRingMetersFromClipperInput(
    clipperInput,
  );
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

  if (
    isInsetDegenerate(
      proj.points,
      insetXY.points,
      insetMeters,
      inwardNormals,
      insetXY.miterPoints,
    )
  ) {
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
  const miterPointsWgs84: Ring = insetXY.miterPoints.map((p) => unproject(p, proj));

  const fullGate = geometryCorrectnessGate(
    ring,
    closed,
    insetFeetPerEdge,
    inwardNormals,
    miterPointsWgs84,
  );
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
    miterPointsWgs84,
  };
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

  if (
    isInsetDegenerate(
      proj.points,
      insetXY.points,
      insetMeters,
      undefined,
      insetXY.miterPoints,
    )
  ) {
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
  const miterPointsWgs84: Ring = insetXY.miterPoints.map((p) => unproject(p, proj));

  const fullGate = geometryCorrectnessGate(
    ring,
    closed,
    insetFeetPerEdge,
    undefined,
    miterPointsWgs84,
  );
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
    miterPointsWgs84,
  };
}
