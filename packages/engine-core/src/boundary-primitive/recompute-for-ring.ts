/**
 * R28 — recompute the boundary primitive against a SWAPPED parcel ring.
 *
 * The stored boundary-edge atoms carry per-edge `interior.inwardNormal` plus a
 * role→edgeIndex mapping built against ONE parcel ring (e.g. the CW TXGIO ring).
 * When the batch swaps in a different-winding ring (e.g. the CCW BCAD ring) the
 * vertex COUNT can still match (4 === 4) while the winding is reversed. Applying
 * the stored inward-normals by `edgeIndex` against the reversed ring lands each
 * normal on the WRONG physical edge (measured: index+1 dot ≈ 1.0, same-index
 * dot ≈ 0) → the offset lines never close → `insetPerEdgeFromPrimitive` returns
 * null → "inset ring is null" → verify-fail → cannot promote.
 *
 * Fix: the primitive must always match the ring it is inset against. This module
 * (a) provides the fail-closed winding/normal-agreement invariant, and
 * (b) rebuilds the primitive (per-edge inward normals + role/setback/facingRoad
 * re-indexed to the new edges) against the swapped ring, so the offset consumes
 * a primitive whose edgeIndex→edge→inwardNormal is correct for THAT ring.
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";

import { openRing, type Ring } from "../depth-warm/geometry.js";
import type { WarmRoadSource } from "../depth-warm/types.js";
import { computeParcelInteriorFacts } from "./interior.js";

/** Dot-product floor for "same physical edge, same winding" per-edge normals. */
export const NORMAL_AGREEMENT_DOT_MIN = 0.9 as const;

export interface NormalAgreementResult {
  /** True when EVERY stored edge normal dots >= NORMAL_AGREEMENT_DOT_MIN with
   *  the ring's freshly-computed inward normal at the same edgeIndex. */
  ok: boolean;
  /** Per-edgeIndex dot of stored normal vs recomputed normal (ordered). */
  perEdgeDot: number[];
  /** Present when the ring itself cannot form a valid polygon. */
  reason?: string;
}

function dot(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * R28 winding/normal-agreement GATE. Recompute the ring's inward normals and
 * confirm each stored edge's `interior.inwardNormal` still agrees (dot ≈ 1.0)
 * with the recomputed normal at the same edgeIndex. A reversed-winding swap
 * fails this (dots drop toward 0 / go negative), signalling a recompute is
 * required before insetting — never inset with mismatched normals.
 */
export function primitiveNormalsAgreeWithRing(
  storedEdges: ReadonlyArray<BoundaryEdgeAtomInstance>,
  ring: Ring,
): NormalAgreementResult {
  const facts = computeParcelInteriorFacts(ring);
  if (!facts) {
    return { ok: false, perEdgeDot: [], reason: "ring is not a valid polygon" };
  }
  const byIndex = new Map(facts.edges.map((e) => [e.edgeIndex, e]));
  const sorted = [...storedEdges].sort((a, b) => a.edgeIndex - b.edgeIndex);
  const perEdgeDot: number[] = [];
  let ok = sorted.length > 0 && sorted.length === facts.edges.length;
  for (const edge of sorted) {
    const fresh = byIndex.get(edge.edgeIndex);
    if (!fresh) {
      ok = false;
      perEdgeDot.push(Number.NaN);
      continue;
    }
    const d = dot(edge.interior.inwardNormal, fresh.inwardNormal);
    perEdgeDot.push(d);
    if (!(d >= NORMAL_AGREEMENT_DOT_MIN)) ok = false;
  }
  return { ok, perEdgeDot };
}

export interface RecomputeBoundaryEdgesInput {
  /** Boundary-edge atoms built against the PREVIOUS ring (roles/setbacks/facing). */
  storedEdges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  /** The ring the primitive must be rebuilt against (the swapped ring). */
  ring: Ring;
  /** Optional roads (reserved for future re-labeling; role match is geometric). */
  roads?: ReadonlyArray<WarmRoadSource>;
}

/**
 * Rebuild the boundary primitive against `ring`.
 *
 * - Per-edge `interior` (inwardNormal, endpoints, ringCcw, centroidInside) is
 *   RECOMPUTED from `ring` via the same path that originally built it
 *   (`computeParcelInteriorFacts`), so edgeIndex→edge→inwardNormal is correct
 *   for the new winding.
 * - Role / setback / facingRoad are edge-geometry-derived facts that were
 *   correct on the previous ring; each is RE-INDEXED onto the physically
 *   corresponding new edge, so roles match the new edge INDICES rather than
 *   being applied blindly by the old index. The physical match uses inward
 *   normal DIRECTION (unit vectors are frame-invariant at parcel scale): each
 *   new edge takes the stored edge whose inward normal is most parallel
 *   (max dot), one-to-one.
 *
 * The returned atoms preserve every non-geometry field of the matched stored
 * edge (setback, facingRoad, adjacencyKind, provenance, etc.) so downstream
 * consume/verify sees an intact primitive — just re-wound.
 */
export function recomputeBoundaryEdgesForRing(
  input: RecomputeBoundaryEdgesInput,
): BoundaryEdgeAtomInstance[] {
  const facts = computeParcelInteriorFacts(input.ring);
  if (!facts) {
    throw new Error("recomputeBoundaryEdgesForRing: ring is not a valid polygon");
  }

  const openLen = openRing(input.ring).length;
  const stored = [...input.storedEdges].sort((a, b) => a.edgeIndex - b.edgeIndex);

  const out: BoundaryEdgeAtomInstance[] = [];
  const usedStored = new Set<number>();

  for (const fresh of facts.edges) {
    // Match this new edge to the unused stored edge whose inward-normal
    // direction is most parallel (frame-invariant unit-vector dot). Same
    // physical edge on the same parcel → dot ≈ 1.0 regardless of winding index.
    let bestIdx = -1;
    let bestDot = -Infinity;
    for (let i = 0; i < stored.length; i++) {
      if (usedStored.has(i)) continue;
      const d = dot(fresh.inwardNormal, stored[i]!.interior.inwardNormal);
      if (d > bestDot) {
        bestDot = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      bestIdx = stored.findIndex((_, i) => !usedStored.has(i));
    }
    if (bestIdx < 0) continue;
    usedStored.add(bestIdx);
    const source = stored[bestIdx]!;

    // Carry over every non-geometry fact from the matched stored edge, but
    // stamp the new edgeIndex and the RECOMPUTED interior for THIS ring.
    out.push({
      ...source,
      edgeIndex: fresh.edgeIndex,
      interior: {
        ringCcw: fresh.ringCcw,
        centroidInside: fresh.centroidInside,
        inwardNormal: fresh.inwardNormal,
        edgeEndpoints: fresh.edgeEndpoints,
      },
    });
  }

  return out.sort((a, b) => a.edgeIndex - b.edgeIndex).slice(0, openLen);
}
