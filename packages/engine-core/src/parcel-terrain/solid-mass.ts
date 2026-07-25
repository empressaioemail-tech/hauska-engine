import type { TerrainMeshGeometry } from "./mesh.js";

/** 1 foot in metres, spelled out so no caller reads a bare "1.5" as metres. */
export const FEET_TO_METERS = 0.3048;

/** Spec default: ~0.5 m (~1.5 ft) below min-Z, flat-bottom, not constant-thickness. */
export const DEFAULT_SKIRT_DEPTH_FEET = 1.5;
export const DEFAULT_SKIRT_DEPTH_METERS = DEFAULT_SKIRT_DEPTH_FEET * FEET_TO_METERS;

export interface SolidMassGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  topVertexCount: number;
  minZ: number;
  bottomZ: number;
  skirtDepthMeters: number;
}

export interface BuildTerrainSolidMassOptions {
  /** Explicit metres override. Prefer skirtDepthFeet for operator-facing input. */
  skirtDepthMeters?: number;
  /** Feet input, converted to metres explicitly (never read as metres). */
  skirtDepthFeet?: number;
}

function meshMinZ(positions: Float32Array): number {
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!;
    if (z < minZ) minZ = z;
  }
  return minZ;
}

/**
 * Real DEM boundary loops carry multiple grid points along each straight
 * parcel edge (resolution-dependent), not just the four corners. Fanning the
 * bottom cap from loop[0] is valid for any convex polygon, but when loop[0]
 * sits among several collinear points on the same straight edge, the early
 * fan triangles are zero-area slivers. Drop near-collinear interior points
 * before fan-triangulating the cap (skirt walls keep the full-resolution
 * loop; this simplification only affects the flat bottom cap).
 */
function simplifyCollinear(loop: number[], positions: Float32Array): number[] {
  const n = loop.length;
  if (n <= 3) return loop;
  const xy = (id: number): [number, number] => [positions[id * 3]!, positions[id * 3 + 1]!];
  const kept: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = xy(loop[(i - 1 + n) % n]!);
    const cur = xy(loop[i]!);
    const next = xy(loop[(i + 1) % n]!);
    const e1: [number, number] = [cur[0] - prev[0], cur[1] - prev[1]];
    const e2: [number, number] = [next[0] - cur[0], next[1] - cur[1]];
    const cross = e1[0] * e2[1] - e1[1] * e2[0];
    const scale = Math.hypot(...e1) * Math.hypot(...e2) || 1;
    if (Math.abs(cross) / scale > 1e-6) kept.push(loop[i]!);
  }
  return kept.length >= 3 ? kept : loop;
}

/**
 * Closes the terrain surface into a solid mass: top = existing shared
 * triangulation (unchanged), vertical skirt walls drop from every boundary
 * edge to a flat bottom plane, and a bottom cap seals it — one closed
 * IfcTriangulatedFaceSet-equivalent mesh, not a dual thin-surface offer.
 *
 * Winding: `mesh.boundaryLoopIndices` is walked clockwise-as-seen-from-above
 * (see mesh.ts). For an edge A->B in that order, the outward horizontal
 * normal points to the LEFT of travel (proof: cross(B-A, down) where
 * down=(0,0,-depth) resolves to depth*(-dy,dx,0), the +90 deg-left rotation
 * of (dx,dy)). Skirt triangles (topA,topB,botB) and (topA,botB,botA) use that
 * ordering directly. The bottom cap fan in this same loop order yields a
 * downward normal (right-hand rule, CCW-as-seen-from-below) with no vertex
 * reordering needed.
 */
export function buildTerrainSolidMass(
  mesh: TerrainMeshGeometry,
  options: BuildTerrainSolidMassOptions = {},
): SolidMassGeometry {
  const loop = mesh.boundaryLoopIndices;
  if (loop.length < 3) {
    throw new Error(
      "Terrain mesh has no usable boundary loop (nodata gaps at the DEM perimeter); " +
        "refusing to fabricate a closed solid mass.",
    );
  }
  const skirtDepthMeters =
    options.skirtDepthMeters ??
    (options.skirtDepthFeet !== undefined
      ? options.skirtDepthFeet * FEET_TO_METERS
      : DEFAULT_SKIRT_DEPTH_METERS);
  if (!(skirtDepthMeters > 0)) {
    throw new Error(`skirtDepthMeters must be positive, got ${skirtDepthMeters}`);
  }

  const minZ = meshMinZ(mesh.positions);
  const bottomZ = minZ - skirtDepthMeters;

  const topVertexCount = mesh.vertexCount;
  const bottomStart = topVertexCount;
  const positions = new Float32Array((topVertexCount + loop.length) * 3);
  positions.set(mesh.positions, 0);
  const bottomIdForLoopPos = new Map<number, number>(); // loop position -> bottom vertex id
  for (let i = 0; i < loop.length; i++) {
    const topId = loop[i]!;
    const bottomId = bottomStart + i;
    positions[bottomId * 3] = mesh.positions[topId * 3]!;
    positions[bottomId * 3 + 1] = mesh.positions[topId * 3 + 1]!;
    positions[bottomId * 3 + 2] = bottomZ;
    bottomIdForLoopPos.set(i, bottomId);
  }

  const indices: number[] = Array.from(mesh.indices);

  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const topA = loop[i]!;
    const topB = loop[(i + 1) % n]!;
    const botA = bottomIdForLoopPos.get(i)!;
    const botB = bottomIdForLoopPos.get((i + 1) % n)!;
    indices.push(topA, topB, botB);
    indices.push(topA, botB, botA);
  }

  // Bottom cap: fan-triangulate from a collinear-simplified copy of the loop
  // (avoids zero-area slivers from multi-point straight DEM edges). The loop
  // is clockwise-from-above, so this fan (no reordering) faces downward —
  // see the winding proof in the function doc comment above.
  const loopIdToBottomId = new Map<number, number>();
  for (let i = 0; i < n; i++) loopIdToBottomId.set(loop[i]!, bottomIdForLoopPos.get(i)!);
  const capLoop = simplifyCollinear(loop, mesh.positions);
  const capBottomIds = capLoop.map((topId) => loopIdToBottomId.get(topId)!);
  for (let i = 1; i < capBottomIds.length - 1; i++) {
    indices.push(capBottomIds[0]!, capBottomIds[i]!, capBottomIds[i + 1]!);
  }

  return {
    positions,
    indices: new Uint32Array(indices),
    vertexCount: topVertexCount + loop.length,
    triangleCount: indices.length / 3,
    topVertexCount,
    minZ,
    bottomZ,
    skirtDepthMeters,
  };
}
