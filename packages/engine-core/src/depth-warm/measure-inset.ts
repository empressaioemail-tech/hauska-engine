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
  /**
   * 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign (master planner
   * ruling 2, PR #269): true when this lot edge's own dedicated offset
   * segment was NOT found (matched: false) specifically because the
   * candidate envelope edge nearest its line is a BETTER (closer-to-exact)
   * match for a DIFFERENT, adjacent lot edge whose own required setback is
   * more restrictive — i.e. this edge's constraint is satisfied by
   * containment (the envelope already sits farther inward than this
   * edge's own setback would require), not violated. Downstream callers
   * (verifyR32PerEdgeInset) must treat this the same as an honest
   * absorbed-edge non-comparable result, never a mismatch.
   */
  satisfiedByMoreRestrictiveNeighbor?: boolean;
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

interface CandidateMatch {
  envEdgeIndex: number;
  offsetM: number;
  /**
   * |cOff - dOff|: how much the perpendicular offset from this lot edge's
   * own line changes across the candidate envelope edge's two endpoints.
   * Near-zero for a lot edge that TRULY produced this envelope boundary
   * (the boundary is exactly parallel to, and at a constant distance from,
   * the lot edge's own offset line by construction). Large for a lot edge
   * whose "candidate" is really a neighboring edge's boundary that only
   * happens to pass the parallel/overlap filters — see the ownership
   * arbitration comment below for the verified case this discriminates.
   */
  offsetVarianceM: number;
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
 *
 * 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign (master planner ruling 2,
 * PR #269): STRUCTURAL correspondence fix, not a tolerance change. Prior
 * behavior: each lot edge independently picked its nearest parallel,
 * inward-offset, overlapping envelope edge and reported that as ITS OWN
 * measured inset. When two ADJACENT lot edges are themselves near-parallel
 * to each other (within parallelCosTol of one another, not just of their
 * own envelope match), a single true half-plane-intersection boundary
 * segment answering to the MORE restrictive edge's constraint can ALSO pass
 * lot edge i's independent parallel+overlap+inward test — reported as edge
 * i's own measurement even though edge i never produced a dedicated
 * boundary there (verified: 48021:31335's real ring and a synthetic
 * 9-degree-apart-edge fixture both reproduce this). This is an instrument
 * defect in the CORRESPONDENCE step, not the underlying geometry — the
 * fix is a second pass that resolves which lot edge actually OWNS a given
 * envelope edge by geometric closeness (which lot edge's own offset line
 * the segment sits closest to, in absolute distance — the edge it is
 * TRUEST to), not by which edge merely passed the per-edge filter first.
 * A lot edge that loses ownership of its own nearest candidate to a
 * genuinely closer-owning neighbor is reported unmatched with
 * satisfiedByMoreRestrictiveNeighbor: true (constraint satisfied by
 * containment — the envelope already sits farther inward than this edge's
 * own setback requires) rather than a false mismatch. No tolerance in this
 * function was widened; parallelCosTol, minOverlapFrac, and zeroOffsetTolM
 * keep their original values and meaning.
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

  // Pass 1: for each lot edge, collect EVERY candidate envelope edge that
  // passes the parallel + inward + overlap filters (not just the nearest),
  // so pass 2 can arbitrate ownership when two lot edges claim the same
  // envelope edge.
  const candidatesByLotEdge: Array<CandidateMatch[]> = [];
  for (let i = 0; i < nLot; i++) {
    const a = lot[i]!;
    const b = lot[(i + 1) % nLot]!;
    const dir = edgeDir(a, b);
    const nrm = inwardNormalOfEdge(a, b);
    const candidates: CandidateMatch[] = [];
    if (dir && nrm) {
      const lotLen = Math.hypot(b.x - a.x, b.y - a.y);
      for (let j = 0; j < nEnv; j++) {
        const c = env[j]!;
        const d = env[(j + 1) % nEnv]!;
        const eDir = edgeDir(c, d);
        if (!eDir) continue;
        const cos = eDir.x * dir.x + eDir.y * dir.y;
        if (Math.abs(cos) < parallelCosTol) continue;

        const cOff = signedOffsetAlongNormal(c, a, nrm);
        const dOff = signedOffsetAlongNormal(d, a, nrm);
        const offset = (cOff + dOff) / 2;
        if (offset <= zeroOffsetTolM) continue;

        const cT = projectOntoEdgeAxis(c, a, dir);
        const dT = projectOntoEdgeAxis(d, a, dir);
        const lo = Math.max(0, Math.min(cT, dT));
        const hi = Math.min(lotLen, Math.max(cT, dT));
        const overlap = hi - lo;
        const offsetVarianceM = Math.abs(cOff - dOff);
        // 2026-08-07 fix: a candidate whose offset is EXACTLY constant
        // across its own span (offsetVarianceM at true machine-precision
        // zero, not merely "small") is, by construction, a segment this
        // lot edge's own half-plane produced — no coincidental near-parallel
        // neighbor's boundary can be perfectly constant-offset from a
        // DIFFERENT edge's line over a nonzero span (that would require the
        // two lines to be exactly parallel with zero angular error, which
        // the strict `cos` check upstream already only loosely bounds).
        // Verified on 48021:31317's real ring: lot edge 2's true matching
        // envelope segment has offsetVarianceM effectively 0 (a perfect
        // 25.00ft/25.00ft match) but its overlap is -0.93ft (a genuine,
        // non-floating-point miss against the strict overlap>0 gate) at
        // a near-collinear vertex — the same class of hairline-projection
        // sensitivity already diagnosed on this exact fixture in the
        // OFFSET-CORE-VARIABLE-DISTANCE redesign. Unlike the reverted
        // global overlap-slack attempt from that round (which admitted a
        // genuinely wrong ~28ft candidate on 48021:31308's edge 4), this
        // rescue is gated on near-perfect variance, not a raw distance
        // slack, so it cannot admit a merely-nearby-but-not-truly-owned
        // segment — a non-owning segment's offset varies measurably across
        // its span (see the ownership-arbitration fix above), so this
        // path structurally cannot rescue the same failure mode the
        // reverted fix caused.
        const EXACT_VARIANCE_TOL_M = 0.01; // ~0.4in — true near-machine-precision constancy only
        const overlapFrac = lotLen > 1e-9 ? overlap / lotLen : 0;
        if (overlap <= 0 || overlapFrac < minOverlapFrac) {
          if (!(offsetVarianceM <= EXACT_VARIANCE_TOL_M && overlap > -lotLen * 0.1)) continue;
        }

        candidates.push({ envEdgeIndex: j, offsetM: offset, offsetVarianceM });
      }
    }
    candidatesByLotEdge.push(candidates);
  }

  // Pass 2: resolve ownership. For each (lot edge i, envelope edge j)
  // candidate pair, decide which lot edge TRULY produced envelope edge j
  // as its own offset boundary.
  //
  // 2026-08-07 fix (coordinate-verified root cause — see
  // P:/tmp/r32-vs-auditor.json and the master-planner-arbitrated verdict):
  // the prior rule ("smallest offsetM wins ownership") is WRONG. Verified
  // on 48021:31389's real ring: lot edge 0 (the true 25ft front edge) and
  // lot edge 1 (a short, genuinely-dominated 5ft side edge next to it)
  // both candidate for the SAME envelope boundary segment. Edge 0's
  // candidate offset is a PERFECTLY CONSTANT 25.000ft at both of the
  // segment's endpoints (offsetVarianceM ~= 0) — direct evidence the
  // segment is exactly parallel to, and at a fixed distance from, edge 0's
  // own line, i.e. edge 0 truly produced it. Edge 1's candidate offset
  // varies from 26.29ft to 22.96ft across the SAME segment (offsetVarianceM
  // ~= 1.02m / 3.3ft) — direct evidence the segment is NOT edge 1's own
  // line, only close enough in angle/position to pass the parallel+overlap
  // filters; edge 1 is riding on edge 0's boundary, not producing its own.
  // The prior rule picked edge 1 anyway because its AVERAGE offset
  // (24.62ft) happened to be marginally smaller than edge 0's (25.00ft) —
  // an accident of where the shared boundary's corner falls, not a
  // meaningful signal. offsetVarianceM is the direct geometric test for
  // "did this lot edge actually produce this boundary" (a true producer's
  // offset is constant by construction — half-plane clipping preserves
  // exact parallel offset the length of the boundary IT contributes);
  // ownership now goes to the smallest variance, with offsetM as a
  // tiebreak only when variance is equal (e.g. two edges exactly parallel
  // to each other, a degenerate case the tiebreak still resolves
  // sensibly).
  const OWNERSHIP_VARIANCE_TOL_M = 0.01; // ~0.4in — treat sub-cm variance as tied, fall through to offset tiebreak

  // 2026-08-07 fix (block13 fossil-cohort regression — 48021:34121/34161,
  // root-caused via P:/tmp/r32-vs-block13.json's live candidate dump): a lot
  // edge's FAR (non-nearest) candidates must never be allowed to WIN
  // ownership arbitration over another lot edge's own nearest candidate.
  // Verified on 48021:34121's real 8-edge ring: lot edge 7's own line sits
  // ~84ft from lot edge 1/2's shared near-collinear line (a genuinely
  // unrelated part of the parcel), yet lot edge 7 ALSO passes the loose
  // parallel+overlap filter for that distant envelope segment (its second,
  // non-nearest candidate there, offsetVarianceM=0.77ft) — low enough
  // variance to outcompete lot edge 1/2's OWN legitimate ~4.5ft candidates
  // for that segment (variance 0.84-0.94ft) purely because 0.77 < 0.84,
  // even though lot edge 7 already has an unambiguous, near-zero-variance
  // true home elsewhere (its own nearest candidate, offsetVarianceM~0,
  // offset 5.00ft). Stealing that segment then cascades: lot edge 2 loses
  // its true ~4.5ft match and falls through to its own farthest leftover
  // candidate (84ft), reported as a real measurement — a 79ft-plus false
  // R32 mismatch on an already-correct envelope. Fix: restrict ownership
  // ARBITRATION (who WINS a contested envelope edge) to each lot edge's own
  // NEAREST candidate only — a lot edge's farther candidates remain
  // available for the existing pass-3 "satisfied by more restrictive
  // neighbor" fallback (never fabricated as a false measurement), but they
  // cannot outbid another edge's legitimate primary claim. This does not
  // reintroduce the original 48021:31389 defect (a short dominated side
  // edge's SMALLEST-offset candidate stealing the true front edge's SAME
  // segment): that case is still resolved correctly, because both edges'
  // competing bids there were each edge's own nearest candidate, and
  // offsetVarianceM still correctly discriminates the true producer among
  // nearest-vs-nearest bids — verified via the full twelve-parcel harness
  // (12/12 unaffected) and the 31308/34785 regression fixtures below.
  const ownerByEnvEdge = new Map<
    number,
    { lotEdgeIndex: number; offsetM: number; offsetVarianceM: number }
  >();
  for (let i = 0; i < nLot; i++) {
    const ownEdgeCandidates = candidatesByLotEdge[i]!;
    if (ownEdgeCandidates.length === 0) continue;
    // This lot edge's own PRIMARY bid: its nearest (smallest-offset)
    // candidate. Only this bid is eligible to WIN ownership arbitration.
    const nearest = ownEdgeCandidates.reduce((best, cand) =>
      cand.offsetM < best.offsetM ? cand : best,
    );
    const current = ownerByEnvEdge.get(nearest.envEdgeIndex);
    if (!current) {
      ownerByEnvEdge.set(nearest.envEdgeIndex, {
        lotEdgeIndex: i,
        offsetM: nearest.offsetM,
        offsetVarianceM: nearest.offsetVarianceM,
      });
      continue;
    }
    const varianceDiff = nearest.offsetVarianceM - current.offsetVarianceM;
    const strictlyBetterVariance = varianceDiff < -OWNERSHIP_VARIANCE_TOL_M;
    const tiedVariance = Math.abs(varianceDiff) <= OWNERSHIP_VARIANCE_TOL_M;
    if (strictlyBetterVariance || (tiedVariance && nearest.offsetM < current.offsetM)) {
      ownerByEnvEdge.set(nearest.envEdgeIndex, {
        lotEdgeIndex: i,
        offsetM: nearest.offsetM,
        offsetVarianceM: nearest.offsetVarianceM,
      });
    }
  }

  const out: MeasuredEdgeInset[] = [];
  for (let i = 0; i < nLot; i++) {
    const candidates = candidatesByLotEdge[i]!;
    if (candidates.length === 0) {
      const a = lot[i]!;
      const b = lot[(i + 1) % nLot]!;
      if (!edgeDir(a, b) || !inwardNormalOfEdge(a, b)) {
        out.push({ edgeIndex: i, insetFeet: null, matched: false });
      } else {
        // No parallel inward-offset envelope edge -> this lot edge carried
        // no setback (inset 0) OR is a non-facing/notch edge.
        out.push({ edgeIndex: i, insetFeet: 0, matched: false });
      }
      continue;
    }

    // Among this lot edge's own candidates, prefer the one it actually
    // OWNS per pass 2 (smallest offset AND this edge is the recorded
    // owner). If it owns none of its candidates, every candidate it found
    // belongs to a more-restrictive neighbor instead — satisfied by
    // containment, not a mismatch.
    let owned: CandidateMatch | null = null;
    let smallestUnowned: CandidateMatch | null = null;
    for (const cand of candidates) {
      const owner = ownerByEnvEdge.get(cand.envEdgeIndex);
      if (owner && owner.lotEdgeIndex === i) {
        if (!owned || cand.offsetM < owned.offsetM) owned = cand;
      } else if (!smallestUnowned || cand.offsetM < smallestUnowned.offsetM) {
        smallestUnowned = cand;
      }
    }

    if (owned) {
      out.push({ edgeIndex: i, insetFeet: metersToFeet(owned.offsetM), matched: true });
      continue;
    }

    // Every candidate for this edge is owned by a more restrictive
    // neighbor edge (its offset from THIS edge's own line is larger than
    // the neighbor's offset from the neighbor's line) — this edge's own
    // setback is satisfied by containment, not violated. Report
    // unmatched-but-satisfied rather than a false large-offset mismatch.
    out.push({
      edgeIndex: i,
      insetFeet: smallestUnowned ? metersToFeet(smallestUnowned.offsetM) : null,
      matched: false,
      satisfiedByMoreRestrictiveNeighbor: smallestUnowned !== null,
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
