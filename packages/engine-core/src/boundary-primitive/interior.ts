/**
 * Authoritative interior frame computed once per parcel ring (S2-U2 B4).
 */

import { pointInOrOnPolygon, signedArea } from "../geometry/polygon-inset.js";
import type { BoundaryInteriorFrame } from "@hauska-engine/atoms";
import { openRing, projectRing, type Ring } from "../depth-warm/geometry.js";

export interface ParcelInteriorFacts {
  ringCcw: boolean;
  centroidInside: boolean;
  edges: ReadonlyArray<BoundaryInteriorFrame & { edgeIndex: number }>;
}

/** Compute stored interior/inward facts from a parcel ring (CCW + left-normal). */
export function computeParcelInteriorFacts(ring: Ring): ParcelInteriorFacts | null {
  const proj = projectRing(ring);
  if (!proj || proj.points.length < 3) return null;

  const pipPoints = proj.points;
  const ringCcw = signedArea(pipPoints) > 0;

  const cx = pipPoints.reduce((s, p) => s + p.x, 0) / pipPoints.length;
  const cy = pipPoints.reduce((s, p) => s + p.y, 0) / pipPoints.length;
  const centroidInside = pointInOrOnPolygon({ x: cx, y: cy }, pipPoints, 0.05);

  const n = pipPoints.length;
  const edges: Array<BoundaryInteriorFrame & { edgeIndex: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = pipPoints[i]!;
    const b = pipPoints[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const inwardNormal =
      len < 1e-12
        ? { x: 0, y: 0 }
        : { x: -dy / len, y: dx / len };
    edges.push({
      edgeIndex: i,
      ringCcw,
      centroidInside,
      inwardNormal,
      edgeEndpoints: [
        [a.x, a.y],
        [b.x, b.y],
      ],
    });
  }

  return { ringCcw, centroidInside, edges };
}

/** Open ring vertex count for edge indexing parity with GeoJSON order. */
export function parcelEdgeCount(ring: Ring): number {
  return openRing(ring).length;
}
