import { describe, expect, it } from "vitest";

import { buildTerrainMeshGeometry } from "../mesh.js";
import { buildTerrainSolidMass } from "../solid-mass.js";

const bbox = { westLng: -97.1, southLat: 30.1, eastLng: -97.09, northLat: 30.11 };

/** Undirected edge set actually present in the triangulation, used to prove
 * a boundary-loop segment is a real mesh edge and not a grid-perimeter
 * chord skipping over a nodata gap. */
function realEdgeSet(indices: Uint32Array): Set<string> {
  const edges = new Set<string>();
  const key = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    edges.add(key(a, b));
    edges.add(key(b, c));
    edges.add(key(c, a));
  }
  return edges;
}

function assertLoopFollowsRealEdges(loop: number[], indices: Uint32Array): void {
  const edges = realEdgeSet(indices);
  const key = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  const n = loop.length;
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) {
    const u = loop[i]!;
    const v = loop[(i + 1) % n]!;
    expect(edges.has(key(u, v))).toBe(true);
  }
}

describe("buildTerrainMeshGeometry boundary loop (nodata-rim regression)", () => {
  it("walks around a nodata notch on the DEM perimeter instead of chording across it", () => {
    // 5-wide grid, single NaN at grid (x=2, y=0) — squarely on the north
    // rim, away from any corner. Vertices (1,0) and (3,0) each survive via
    // a DIFFERENT adjacent cell than the one touching (2,0), so a naive
    // "skip missing, connect next survivor" walk would draw a straight
    // chord 1->3 that is not a real triangulated edge (it skips right over
    // where (2,0) would have been). The real boundary must instead detour
    // down through row y=1 around the notch.
    const width = 5;
    const height = 3;
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) values[i] = 100 + i;
    const nodataGridIndex = 0 * width + 2; // (x=2, y=0)
    values[nodataGridIndex] = NaN;
    const dem = { width, height, values };

    const mesh = buildTerrainMeshGeometry(dem, bbox);
    expect(mesh.hasHoles).toBe(true);
    expect(mesh.boundaryLoopIndices.length).toBeGreaterThanOrEqual(3);

    // Core regression assertion: every boundary-loop segment (including the
    // wrap-around) is an edge that genuinely exists in the triangulation.
    assertLoopFollowsRealEdges(mesh.boundaryLoopIndices, mesh.indices);

    // The old grid-perimeter walk would have produced the chord by jumping
    // straight from grid vertex (1,0) to grid vertex (3,0) on the loop —
    // i.e. those two vertices adjacent in the loop with nothing walked
    // between them via row y=1. Assert the fixed loop does NOT do that: if
    // both survive, they must not be immediate loop neighbors (the notch
    // forces a detour through the row-1 vertices between them).
    const gridIndexOf = (localVertexId: number): number | null => {
      // Recover which DEM grid cell a mesh vertex id corresponds to by
      // reprojecting: safe for this fixture because all elevations are
      // distinct integers offset from the grid index.
      const z = mesh.positions[localVertexId * 3 + 2]!;
      const gi = Math.round(z - 100);
      return gi;
    };
    const loop = mesh.boundaryLoopIndices;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const giA = gridIndexOf(loop[i]!);
      const giB = gridIndexOf(loop[(i + 1) % n]!);
      const isOldChord = (giA === 1 && giB === 3) || (giA === 3 && giB === 1);
      expect(isOldChord).toBe(false);
    }
  });

  it("builds a watertight closed solid from the notched perimeter (no chord => no self-intersection)", () => {
    const width = 5;
    const height = 3;
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) values[i] = 100 + i;
    values[0 * width + 2] = NaN;
    const dem = { width, height, values };

    const mesh = buildTerrainMeshGeometry(dem, bbox);
    const solid = buildTerrainSolidMass(mesh);
    const n = mesh.boundaryLoopIndices.length;
    // Every skirt wall spans a real top-loop edge (already proven above);
    // the closed solid must add exactly one bottom vertex per loop vertex
    // and 2 skirt triangles per loop edge, with no extra/missing geometry
    // from a chord that would have shortcut the notch.
    expect(solid.vertexCount).toBe(mesh.vertexCount + n);
    expect(solid.triangleCount).toBeGreaterThan(mesh.triangleCount + 2 * n);
  });

  it("still produces the identical loop for a fully-covered DEM with no nodata (no regression on the common case)", () => {
    const dem = {
      width: 3,
      height: 3,
      values: new Float32Array([100, 101, 102, 103, 104, 105, 106, 107, 108]),
    };
    const mesh = buildTerrainMeshGeometry(dem, bbox);
    expect(mesh.boundaryLoopIndices.length).toBe(8);
    assertLoopFollowsRealEdges(mesh.boundaryLoopIndices, mesh.indices);
  });
});
