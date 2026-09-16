/**
 * P-262 — ring validation, artifact scrub, and logical-edge grouping.
 *
 * WHY THIS EXISTS. A county ring is a digitised boundary, not a surveyed lot
 * line: it carries extra vertices that no lot line has (a run of chords at a
 * 0-degree turn where one straight line exists, and duplicate vertices a metre
 * apart). The depth-warm labeller labels CHORDS, so two chords of ONE lot line
 * can be handed two different setbacks — and the offset of a 3 m chord by a
 * 15 ft setback folds, because the chord is shorter than the setback it was
 * given. Measured on the dispatch's own parcel (48209:97658, see
 * fixtures/p262Parcels.ts): the same-street corner-clip rule fires on the 3.44 m
 * and 3.53 m artifact chords of the two LONG side lines and gives each a
 * 15 ft (4.57 m) side-corner setback — deeper than the chord is long — while
 * the far end line gets `rear` on one chord and `side` on its 5.29 m
 * line-mate. The parcel's buildable envelope comes back empty. LDT's labeller
 * avoids the same class by a different route (it refuses a unique
 * globally-shortest eligible edge as front on shape-only signal); the engine
 * has no grouping at all.
 *
 * WHAT THIS MODULE PROVIDES, in the order the dispatch asks for it:
 *   1. validateParcelRing      — a ring that cannot be labelled says why.
 *   2. scrubRingForLabeling    — drop duplicate and artifact vertices, with the
 *                                tolerances named as exported constants.
 *   3. groupRingChordsIntoLogicalEdges — chords that belong to one lot line.
 *   4. logicalLineProjection / expandLineRolesOntoChords — run the rules on the
 *                                line view, then give EVERY chord of a logical
 *                                line that line's own role.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not re-derive the front, rear or
 * corner rules: those stay in edgeLabeling.ts, unchanged, on the raw chord
 * index space they were written and ruled against. This module only stops a
 * chord from carrying a role its own line contradicts.
 *
 * THE ONE TOLERANCE THAT DECIDES BEHAVIOUR, and why it is this number:
 *
 *   P262_LOGICAL_EDGE_MAX_TURN_DEG = 10.0. Every turn INSIDE an artifact run on
 *   the fixture parcels measures 0.01-0.03 degrees (48209:97658's runs of
 *   2.10/3.43/3.53/5.28 m and their line-mates; 48453:427599 has no artifact
 *   run at all). Across the fourteen real rings this lane tests (the two
 *   fixtures plus the twelve-parcel live harness) the largest turn at or below
 *   this threshold is 4.276 degrees (48021:31317's shallow bend) and the
 *   smallest turn above it is 74.409 degrees (48021:31335). So 10 degrees sits
 *   2.3x above every artifact turn actually measured and 7.4x below the nearest
 *   real corner, and the test suite sweeps 2..45 degrees to show the answers do
 *   not move across that whole band — a measured margin, not a guess.
 *
 *   P262_DUPLICATE_VERTEX_TOL_M = 0.5 and P262_COLLINEAR_VERTEX_TOL_DEG = 1.0
 *   govern scrubRingForLabeling. They are of the same order as the existing
 *   boundary-primitive scrub's own law (an absolute sub-survey-length test plus
 *   an exact cross-product collinearity test) and are NOT a second,
 *   competing scrub: this one works on the ring the labeller labels and never
 *   touches the boundary-primitive path, which keeps its own parameters.
 */

import { openRing, projectRing, type ProjectedRing, type Ring } from "./geometry.js";
import type { WarmEdgeRole } from "./types.js";

/** Duplicate-vertex collapse tolerance, metres (about 20 inches). */
export const P262_DUPLICATE_VERTEX_TOL_M = 0.5;

/** Near-collinear vertex collapse tolerance, degrees. */
export const P262_COLLINEAR_VERTEX_TOL_DEG = 1.0;

/** A turn at or below this joins two chords into ONE logical edge (degrees). */
export const P262_LOGICAL_EDGE_MAX_TURN_DEG = 10.0;

/** Minimum area for a ring to be a polygon at all, square metres. */
const MIN_RING_AREA_M2 = 1e-6;

export type RingValidationFailure =
  | "ring-too-few-vertices"
  | "ring-non-finite-coordinate"
  | "ring-zero-area"
  | "ring-self-intersecting";

export interface RingLogicalEdgeOptions {
  /** Turn at or below this joins two chords into one logical edge. */
  maxTurnDeg?: number;
}

interface XY {
  x: number;
  y: number;
}

/* --------------------------------- ring validation ------------------------- */

function orientation(a: XY, b: XY, c: XY): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

function segmentsProperlyIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  // Exclude the shared-endpoint cases (adjacent chords legitimately touch).
  if (o1 !== o2 && o3 !== o4) {
    const touchesSharedEndpoint =
      (a.x === c.x && a.y === c.y) ||
      (a.x === d.x && a.y === d.y) ||
      (b.x === c.x && b.y === c.y) ||
      (b.x === d.x && b.y === d.y);
    return !touchesSharedEndpoint;
  }
  return false;
}

/**
 * Validate a parcel ring for labelling. Returns null when the ring is usable,
 * otherwise the FIRST reason it is not. A ring that fails here must reach a
 * NAMED decline, never an empty label set (the dispatch's item 5, and what
 * P-249 relies on).
 */
export function validateParcelRing(ring: Ring): RingValidationFailure | null {
  if (!Array.isArray(ring)) return "ring-too-few-vertices";
  for (const c of ring) {
    if (!Array.isArray(c) || c.length < 2) return "ring-non-finite-coordinate";
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return "ring-non-finite-coordinate";
  }
  const proj = projectRing(ring);
  if (!proj || proj.points.length < 3) return "ring-too-few-vertices";
  const pts = proj.points;
  const n = pts.length;

  let twiceArea = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(twiceArea) / 2 <= MIN_RING_AREA_M2) return "ring-zero-area";

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip chords that share a vertex.
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue;
      if (
        segmentsProperlyIntersect(
          pts[i]!,
          pts[(i + 1) % n]!,
          pts[j]!,
          pts[(j + 1) % n]!,
        )
      ) {
        return "ring-self-intersecting";
      }
    }
  }
  return null;
}

/* ------------------------------------ turn --------------------------------- */

/** Length of chord i (vertex i -> i+1) in the projected frame, metres. */
export function chordLengthM(proj: ProjectedRing, i: number): number {
  const n = proj.points.length;
  const a = proj.points[i]!;
  const b = proj.points[(i + 1) % n]!;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Unsigned turn at vertex v, in degrees: 0 means chord v-1 and chord v point
 * the same way (one straight line runs through v).
 */
export function turnAtVertexDeg(proj: ProjectedRing, v: number): number {
  const n = proj.points.length;
  const prev = proj.points[(v + n - 1) % n]!;
  const a = proj.points[v]!;
  const b = proj.points[(v + 1) % n]!;
  const v1x = a.x - prev.x;
  const v1y = a.y - prev.y;
  const v2x = b.x - a.x;
  const v2y = b.y - a.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 0;
  const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/* --------------------------------- logical edges ---------------------------- */

export interface LogicalEdgeGroup {
  /** Chord indices (into the projected ring's edge space), in ring order. */
  chordIndices: number[];
  /** Index of the longest chord — the one whose role the line carries. */
  dominantChordIndex: number;
  /** Total length of the line, metres. */
  lengthM: number;
}

/**
 * Group chords that belong to ONE lot line: a maximal run of consecutive
 * chords whose turn at every shared vertex is at or below `maxTurnDeg`.
 *
 * The ring's chord order is preserved and every chord lands in exactly one
 * group, so a caller can map roles back by index without a frame transform
 * (the binding "index transform across frames" rule).
 */
export function groupRingChordsIntoLogicalEdges(
  proj: ProjectedRing,
  opts: RingLogicalEdgeOptions = {},
): LogicalEdgeGroup[] {
  const maxTurnDeg = opts.maxTurnDeg ?? P262_LOGICAL_EDGE_MAX_TURN_DEG;
  const n = proj.points.length;
  if (n < 3) return [];

  const turns = Array.from({ length: n }, (_, v) => turnAtVertexDeg(proj, v));
  // A run boundary is a vertex whose turn is a real corner: chord v-1 and
  // chord v are then different lines.
  const boundaries = turns.map((t, v) => (t > maxTurnDeg ? v : -1)).filter((v) => v >= 0);

  const buildGroup = (startChord: number): LogicalEdgeGroup => {
    const chordIndices = [startChord];
    let chord = startChord;
    for (;;) {
      const nextChord = (chord + 1) % n;
      const nextVertex = nextChord; // turn at the vertex that JOINS chord and nextChord
      if (chordIndices.length >= n) break;
      if (turns[nextVertex]! > maxTurnDeg) break;
      chordIndices.push(nextChord);
      chord = nextChord;
    }
    let dominant = chordIndices[0]!;
    let lengthM = 0;
    for (const c of chordIndices) {
      const len = chordLengthM(proj, c);
      lengthM += len;
      if (len > chordLengthM(proj, dominant)) dominant = c;
    }
    return { chordIndices, dominantChordIndex: dominant, lengthM };
  };

  if (boundaries.length === 0) {
    // No corner at all: a smooth closed curve. One line.
    return [buildGroup(0)];
  }
  const groups: LogicalEdgeGroup[] = [];
  const startChords = [...boundaries].sort((a, b) => a - b);
  for (const start of startChords) {
    groups.push(buildGroup(start));
  }
  // Every chord must be accounted for exactly once.
  const seen = new Set<number>();
  for (const g of groups) for (const c of g.chordIndices) seen.add(c);
  if (seen.size !== n) {
    // A pathological grouping (should not happen: boundaries are per-vertex).
    // Fall back to singleton groups so no chord is ever silently dropped.
    return Array.from({ length: n }, (_, i) => {
      const len = chordLengthM(proj, i);
      return { chordIndices: [i], dominantChordIndex: i, lengthM: len };
    });
  }
  return groups;
}

/* ---------------------------- role expansion ------------------------------- */

/**
 * The line view of a projected ring: one vertex per logical line, at the
 * line's START vertex, so a rule written against an EDGE walks the parcel's
 * lot lines instead of the county's digitised chords.
 *
 * Same origin, same scale and same vertex order as the input, so the road frame
 * derived from it is the chord frame (projectPolylineInFrame needs nothing else)
 * and no caller transforms a coordinate. The point set is a subset of the
 * ring's own vertices taken in ring order, so the line view is CCW and
 * non-self-intersecting whenever the ring was.
 *
 * Identity — the SAME object — when every chord is already its own line, which
 * is what makes a ring with no artifact run (48453:427599: every internal turn
 * measures 89.4-95.0 degrees) follow the arithmetic path it followed before
 * P-262, point for point.
 */
export function logicalLineProjection(
  proj: ProjectedRing,
  groups: readonly LogicalEdgeGroup[],
): ProjectedRing {
  const n = proj.points.length;
  const identity =
    groups.length === n &&
    groups.every((g, i) => g.chordIndices.length === 1 && g.chordIndices[0] === i);
  if (identity) return proj;

  const points: XY[] = [];
  for (const group of groups) {
    const first = group.chordIndices[0];
    if (first == null) continue;
    const p = proj.points[first]!;
    points.push({ x: p.x, y: p.y });
  }
  if (points.length < 3) return proj;
  return { points, originLng: proj.originLng, originLat: proj.originLat, mPerDegLng: proj.mPerDegLng, mPerDegLat: proj.mPerDegLat };
}

/**
 * Expand the LINE decisions back onto the raw chord index space, so a caller's
 * labels still index the parcel ring: every chord of a logical line takes that
 * line's role and road attributes — one lot line, one setback.
 *
 * This is the whole of item 2. The chord-level pass is NOT consulted for the
 * chords inside a line, and that was measured, not assumed: the alternative
 * (keep a long chord's own chord-level role, absorb only chords under an
 * artifact length cap) was implemented and swept. It leaves the dispatch's own
 * parcel broken — 48209:97658's far-end line is two chords of 5.29 m and
 * 11.50 m, and the 11.50 m chord's own role is `side` while its line's is
 * `rear`, so the cap keeps 5 ft on half a 20 ft line and P2 still fails on that
 * edge. With the cap removed, all twelve live Jones/Higgins parcels (including
 * every master-planner-ruled one: 31317's corner clip, 31362/31371's rear
 * lines, 31344's front) still pass BOTH mechanical verify and the full P1-P3
 * ground-truth predicate, because the line view — not the cap — is what
 * preserves their rulings.
 *
 * A ring whose groups are all singletons is returned unchanged in content.
 */
export function expandLineRolesOntoChords<T extends { index: number; label: WarmEdgeRole }>(
  chordLabels: ReadonlyArray<T>,
  lineLabels: ReadonlyArray<T>,
  groups: readonly LogicalEdgeGroup[],
): T[] {
  const n = chordLabels.length;
  const out = new Map<number, T>();
  for (let lineIndex = 0; lineIndex < lineLabels.length; lineIndex++) {
    const line = lineLabels[lineIndex]!;
    const group = groups[lineIndex];
    if (!group) {
      out.set(line.index, line);
      continue;
    }
    for (const chordIndex of group.chordIndices) {
      out.set(chordIndex, { ...line, index: chordIndex });
    }
  }

  // Any chord the grouping did not cover keeps its chord-level role: never
  // silently drop a label (chordLabels covers every chord of the ring).
  for (const l of chordLabels) {
    if (!out.has(l.index)) out.set(l.index, l);
  }

  const ordered: T[] = [];
  for (let i = 0; i < n; i++) {
    const l = out.get(i);
    if (l) ordered.push(l);
  }
  return ordered;
}

/* ------------------------------------ scrub -------------------------------- */

export interface ScrubResult {
  ok: boolean;
  /** Open (unclosed) vertex list in WGS84 when ok. */
  vertices: Ring;
  /** Index into the input ring's open vertex list for each surviving vertex. */
  keptOriginalVertexIndices: number[];
  duplicateVerticesRemoved: number;
  collinearVerticesRemoved: number;
  reason?: RingValidationFailure;
}

/**
 * Drop duplicate and near-collinear (artifact) vertices so a ring keeps its
 * real corners and no others. Returns the surviving vertices in WGS84 with the
 * index of each back into the input ring, so a caller can map anything keyed to
 * the raw ring without a frame transform.
 *
 * This is a labelling-time scrub. It is NOT a replacement for
 * boundary-primitive/lot-line-scrub.ts and does not change its parameters.
 */
export function scrubRingForLabeling(
  ring: Ring,
  opts: {
    duplicateTolM?: number;
    collinearTolDeg?: number;
  } = {},
): ScrubResult {
  const failure = validateParcelRing(ring);
  const empty: ScrubResult = {
    ok: false,
    vertices: [],
    keptOriginalVertexIndices: [],
    duplicateVerticesRemoved: 0,
    collinearVerticesRemoved: 0,
    ...(failure ? { reason: failure } : {}),
  };
  if (failure) return empty;

  const open = openRing(ring);
  const proj = projectRing(ring);
  if (!proj) return empty;

  const dupTol = opts.duplicateTolM ?? P262_DUPLICATE_VERTEX_TOL_M;
  const collinearTol = opts.collinearTolDeg ?? P262_COLLINEAR_VERTEX_TOL_DEG;

  // Work in the projected frame so the tolerances are metres and degrees, then
  // map the surviving indices back to the input ring's own vertex order.
  //
  // projectRing may reverse the vertex order (it orients CCW), so resolve the
  // correspondence through the coordinates rather than assuming identity.
  const n = proj.points.length;
  const projectOne = (lng: number, lat: number) => ({
    x: (lng - proj.originLng) * proj.mPerDegLng,
    y: (lat - proj.originLat) * proj.mPerDegLat,
  });
  const projectedOpen = open.map(([lng, lat]) => projectOne(lng, lat));
  // projectRing may REVERSE the vertex order (it orients CCW). Its projection
  // uses this same formula, so the correspondence is exact and there are only
  // two candidates: same order, or reversed. Take the one that actually lands on
  // the projected points rather than guessing — a wrong mapping here would
  // mis-attribute every surviving vertex.
  const alignmentError = (mapIndex: (i: number) => number): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = proj.points[i]!;
      const q = projectedOpen[mapIndex(i)];
      if (!q) return Number.POSITIVE_INFINITY;
      total += Math.hypot(q.x - p.x, q.y - p.y);
    }
    return total;
  };
  const sameOrder = alignmentError((i) => i);
  const reversedOrder = alignmentError((i) => n - 1 - i);
  const perm: number[] = [];
  const useReversed = reversedOrder < sameOrder;
  for (let i = 0; i < n; i++) perm.push(useReversed ? n - 1 - i : i);

  const dropped = new Array<boolean>(n).fill(false);

  // 1. Duplicate / near-duplicate vertices.
  let duplicateVerticesRemoved = 0;
  for (let i = 0; i < n; i++) {
    if (dropped[i]) continue;
    const j = (i + 1) % n;
    if (dropped[j]) continue;
    const a = proj.points[i]!;
    const b = proj.points[j]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) <= dupTol) {
      dropped[j] = true;
      duplicateVerticesRemoved++;
    }
  }

  // 2. Near-collinear vertices: the turn through the vertex is ~0 degrees, so
  //    the two chords are one line.
  let collinearVerticesRemoved = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (dropped[i]) continue;
      let prev = (i + n - 1) % n;
      while (dropped[prev] && prev !== i) prev = (prev + n - 1) % n;
      let next = (i + 1) % n;
      while (dropped[next] && next !== i) next = (next + 1) % n;
      if (prev === i || next === i || prev === next) continue;
      const a = proj.points[prev]!;
      const b = proj.points[i]!;
      const c = proj.points[next]!;
      const v1x = b.x - a.x;
      const v1y = b.y - a.y;
      const v2x = c.x - b.x;
      const v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
      const turn = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      if (turn <= collinearTol) {
        dropped[i] = true;
        collinearVerticesRemoved++;
      }
    }
  }

  const survivors: number[] = [];
  for (let i = 0; i < n; i++) if (!dropped[i]) survivors.push(i);
  if (survivors.length < 3) {
    return { ...empty, reason: "ring-zero-area" };
  }

  return {
    ok: true,
    vertices: survivors.map((i) => {
      const p = proj.points[i]!;
      return [
        proj.originLng + p.x / proj.mPerDegLng,
        proj.originLat + p.y / proj.mPerDegLat,
      ] as [number, number];
    }),
    keptOriginalVertexIndices: survivors.map((i) => perm[i]!),
    duplicateVerticesRemoved,
    collinearVerticesRemoved,
  };
}
