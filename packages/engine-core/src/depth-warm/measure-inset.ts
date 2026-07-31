/**
 * R32 — index-matched inward-normal per-edge inset MEASUREMENT.
 *
 * The block-cert / R31 orientation grade must measure each served envelope
 * edge's inset in the SAME frame the engine PROMOTES in
 * (`insetPerEdgeFromPrimitive` -> `insetRingMetersWithNormals`): each lot edge i
 * is offset inward along ITS OWN inward normal by that edge's setback, and the
 * envelope edge that corresponds to lot-edge i is matched by INDEX (parallel +
 * offset along n_i), NOT by nearest edge/vertex.
 *
 * Perpendicular-to-nearest-edge is WRONG for non-convex / irregular lots: an
 * envelope vertex produced by a notch can sit physically closest to a lot edge
 * it was never inset from, so the "inset" measured is the distance to the wrong
 * edge (false-flagged 48021:34121 GC and 48021:34177 MU whose envelopes are
 * geometrically correct). On a convex / rectangular lot the two methods AGREE;
 * on a non-convex lot only the index-matched method recovers the true promoted
 * per-edge insets (validated in measure-inset.test.ts).
 *
 * Pure geometry over a projected metre frame. No I/O, no road/geocode signals.
 */

import { metersToFeet, projectRing, type ProjectedRing, type Ring } from "./geometry.js";

interface XY {
  x: number;
  y: number;
}

/** Left-normal (inward for a CCW ring) of the edge a->b, unit length. */
function inwardNormalOfEdge(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: -dy / len, y: dx / len };
}

/** Unit edge direction a->b. */
function edgeDir(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: dx / len, y: dy / len };
}

/** Perpendicular offset of point p from the infinite line through `a` with unit inward normal `nrm`. */
function signedOffsetAlongNormal(p: XY, a: XY, nrm: XY): number {
  return (p.x - a.x) * nrm.x + (p.y - a.y) * nrm.y;
}

/** Scalar projection of point p onto the lot edge axis (a -> along unit dir). */
function projectOntoEdgeAxis(p: XY, a: XY, dir: XY): number {
  return (p.x - a.x) * dir.x + (p.y - a.y) * dir.y;
}

export interface MeasuredEdgeInset {
  edgeIndex: number;
  /** Measured inset in feet along this lot edge's own inward normal, or null when unmeasurable. */
  insetFeet: number | null;
  /** True when a parallel, inward-offset envelope edge was matched by index. */
  matched: boolean;
}

export interface MeasureInsetOptions {
  /**
   * Minimum |cos| between a lot edge direction and an envelope edge direction
   * to accept them as parallel (the matched envelope edge). Default ~11.5deg.
   */
  parallelCosTol?: number;
  /** Overlap fraction (of lot edge span) an envelope edge must project onto to count. */
  minOverlapFrac?: number;
  /** Inward offsets below this (m) are treated as "no setback on this edge" -> 0 ft. */
  zeroOffsetTolM?: number;
}

/**
 * Index-matched inward-normal per-edge inset measurement.
 *
 * For each lot edge i, find the envelope edge whose supporting line is parallel
 * to lot-edge i, is offset in the +inward-normal_i direction, and overlaps the
 * lot edge's span when both are projected onto lot-edge i's axis. The measured
 * inset is the perpendicular distance from lot-edge i's line to that envelope
 * edge along inward-normal_i. This matches the promote frame edge-i to edge-i.
 *
 * Both rings are projected in the SAME parcel frame so offsets are comparable.
 */
export function measurePerEdgeInsetIndexMatched(
  parcelFrame: ProjectedRing,
  envelopeFrame: ProjectedRing,
  options?: MeasureInsetOptions,
): MeasuredEdgeInset[] {
  const parallelCosTol = options?.parallelCosTol ?? Math.cos((11.5 * Math.PI) / 180);
  const minOverlapFrac = options?.minOverlapFrac ?? 0.15;
  const zeroOffsetTolM = options?.zeroOffsetTolM ?? 0.15;

  const lot = parcelFrame.points;
  const env = envelopeFrame.points;
  const nLot = lot.length;
  const nEnv = env.length;

  const out: MeasuredEdgeInset[] = [];

  for (let i = 0; i < nLot; i++) {
    const a = lot[i]!;
    const b = lot[(i + 1) % nLot]!;
    const dir = edgeDir(a, b);
    const nrm = inwardNormalOfEdge(a, b);
    if (!dir || !nrm) {
      out.push({ edgeIndex: i, insetFeet: null, matched: false });
      continue;
    }
    const lotLen = Math.hypot(b.x - a.x, b.y - a.y);
    const lotT0 = 0;
    const lotT1 = lotLen;

    // Find the index-matched envelope edge: the NEAREST envelope edge that is
    // parallel to lot-edge i, offset in the +inward-normal direction, and
    // overlaps lot-edge i's span. "Nearest inward parallel edge" is the facing
    // envelope edge produced by offsetting THIS lot edge along its own normal —
    // a farther parallel edge (opposite side of the lot, or a notch edge) is a
    // different lot edge's product and must not be matched here.
    let bestOffset: number | null = null;

    for (let j = 0; j < nEnv; j++) {
      const c = env[j]!;
      const d = env[(j + 1) % nEnv]!;
      const eDir = edgeDir(c, d);
      if (!eDir) continue;
      const cos = eDir.x * dir.x + eDir.y * dir.y;
      if (Math.abs(cos) < parallelCosTol) continue; // not parallel to lot edge i

      // Offset of the envelope edge from the lot edge line, along inward normal.
      // Use the midpoint so a slightly non-parallel edge averages cleanly.
      const cOff = signedOffsetAlongNormal(c, a, nrm);
      const dOff = signedOffsetAlongNormal(d, a, nrm);
      const offset = (cOff + dOff) / 2;
      if (offset <= zeroOffsetTolM) continue; // must be inward (envelope is inside)

      // Overlap of the envelope edge onto the lot edge axis.
      const cT = projectOntoEdgeAxis(c, a, dir);
      const dT = projectOntoEdgeAxis(d, a, dir);
      const lo = Math.max(lotT0, Math.min(cT, dT));
      const hi = Math.min(lotT1, Math.max(cT, dT));
      const overlap = hi - lo;
      if (overlap <= 0) continue;
      const overlapFrac = lotLen > 1e-9 ? overlap / lotLen : 0;
      if (overlapFrac < minOverlapFrac) continue;

      // Nearest inward-offset parallel-and-overlapping envelope edge wins.
      if (bestOffset === null || offset < bestOffset) {
        bestOffset = offset;
      }
    }

    if (bestOffset === null) {
      // No parallel inward-offset envelope edge -> this lot edge carried no
      // setback (inset 0) OR is a non-facing/notch edge. Report 0 when the
      // envelope coincides with the lot edge (measured as such by the absence of
      // an inward-offset parallel edge), else null (unmeasurable).
      out.push({ edgeIndex: i, insetFeet: 0, matched: false });
      continue;
    }

    out.push({
      edgeIndex: i,
      insetFeet: metersToFeet(bestOffset),
      matched: true,
    });
  }

  return out;
}

/** Convenience: project both rings and measure. Returns null on projection failure. */
export function measurePerEdgeInsetForRings(
  parcelRing: Ring,
  envelopeRing: Ring,
  options?: MeasureInsetOptions,
): MeasuredEdgeInset[] | null {
  const parcelFrame = projectRing(parcelRing);
  if (!parcelFrame) return null;
  // Project the envelope in the SAME parcel frame so offsets are comparable.
  const envInParcelFrame = projectRingInParcelFrame(envelopeRing, parcelFrame);
  if (!envInParcelFrame) return null;
  return measurePerEdgeInsetIndexMatched(parcelFrame, envInParcelFrame, options);
}

/** Project an envelope ring into an existing parcel frame (metres), preserving order. */
function projectRingInParcelFrame(
  ring: Ring,
  frame: ProjectedRing,
): ProjectedRing | null {
  const open: XY[] = [];
  let prev: [number, number] | null = null;
  for (const c of ring) {
    if (
      !Array.isArray(c) ||
      c.length < 2 ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    ) {
      continue;
    }
    if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
    open.push({
      x: (c[0] - frame.originLng) * frame.mPerDegLng,
      y: (c[1] - frame.originLat) * frame.mPerDegLat,
    });
    prev = [c[0], c[1]];
  }
  if (
    open.length > 1 &&
    Math.abs(open[0]!.x - open[open.length - 1]!.x) < 1e-9 &&
    Math.abs(open[0]!.y - open[open.length - 1]!.y) < 1e-9
  ) {
    open.pop();
  }
  if (open.length < 3) return null;
  return {
    points: open,
    originLng: frame.originLng,
    originLat: frame.originLat,
    mPerDegLng: frame.mPerDegLng,
    mPerDegLat: frame.mPerDegLat,
  };
}
