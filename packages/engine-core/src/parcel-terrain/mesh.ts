import { Document, NodeIO } from "@gltf-transform/core";

import type { BboxWgs84, ParsedDem } from "../site-topography/index.js";

const METERS_PER_DEGREE_LAT = 111_320;

export const TERRAIN_MESH_CRS_CONVENTION =
  "local-enu-meters:origin-bbox-sw:equirectangular-coslat" as const;

/**
 * The one WGS84 -> local-ENU-metres projection every terrain/site-plan
 * artifact uses (origin = bbox SW corner, equirectangular with a single
 * cos(meanLat) correction for longitude scale). Exported so callers outside
 * the DEM grid (e.g. a parcel boundary ring) project into the SAME frame as
 * the mesh instead of re-deriving the constants.
 */
export function projectWgs84ToLocalEnu(
  lng: number,
  lat: number,
  bbox: BboxWgs84,
): { x: number; y: number } {
  const meanLatDegrees = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLatDegrees * Math.PI) / 180);
  return {
    x: (lng - bbox.westLng) * METERS_PER_DEGREE_LAT * cosLat,
    y: (lat - bbox.southLat) * METERS_PER_DEGREE_LAT,
  };
}

export interface TerrainMeshGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  hasHoles: boolean;
  georefOrigin: { originLng: number; originLat: number; meanLatDegrees: number };
  crsConvention: typeof TERRAIN_MESH_CRS_CONVENTION;
  /**
   * The mesh's actual outer boundary, walked along real triangulated edges
   * (never a straight-line chord between two vertices that merely happen to
   * be next-surviving on the DEM grid perimeter — a nodata gap on the rim
   * can leave a real triangulated notch, and a chord across that notch
   * would make the closed-solid skirt/cap construction downstream
   * non-watertight or self-intersecting despite reporting `Closed=True`).
   * Consumers building a closed solid (site-plan terrain mass) extrude this
   * loop downward. Empty when no clean single closed boundary loop can be
   * derived (e.g. a non-manifold boundary vertex from touching nodata
   * pockets) — closed-solid construction must fail closed in that case
   * rather than fabricate a boundary.
   */
  boundaryLoopIndices: number[];
}

/**
 * Extracts the real triangulated outer-boundary loop of a manifold-ish
 * triangle soup: an edge (u,v) is a boundary edge iff the directed edge
 * (u,v) occurs exactly once across all triangles and its reverse (v,u)
 * never occurs (interior edges are shared by exactly two triangles with
 * opposite winding, i.e. both (u,v) and (v,u) appear once each and cancel).
 * Boundary edges are chained tail-to-head into loops; when nodata carves a
 * notch into the DEM perimeter, or an interior hole touches the boundary,
 * this naturally walks around the notch instead of skipping across it —
 * fixing the chord bug a naive grid-perimeter walk has. If multiple loops
 * exist (e.g. an interior hole also has a boundary), the outer one is the
 * one with the largest enclosed |signed area|, since any hole loop nests
 * strictly inside it. Returns [] (fail closed) on a non-manifold boundary
 * (a vertex with more than one outgoing or incoming boundary edge) rather
 * than guessing which branch to follow.
 */
function extractOuterBoundaryLoop(indices: Uint32Array, positions: number[]): number[] {
  const directedCount = new Map<string, number>();
  const edgeKey = (u: number, v: number): string => `${u}_${v}`;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(u, v);
      directedCount.set(key, (directedCount.get(key) ?? 0) + 1);
    }
  }

  const nextOf = new Map<number, number>();
  const inDegree = new Map<number, number>();
  for (const [key, count] of directedCount) {
    if (count !== 1) continue; // duplicated directed edge: non-manifold, not a clean boundary edge
    const [uStr, vStr] = key.split("_");
    const u = Number(uStr);
    const v = Number(vStr);
    if ((directedCount.get(edgeKey(v, u)) ?? 0) !== 0) continue; // interior edge, cancels with its reverse
    if (nextOf.has(u)) return []; // vertex has >1 outgoing boundary edge: non-manifold, fail closed
    nextOf.set(u, v);
    inDegree.set(v, (inDegree.get(v) ?? 0) + 1);
  }
  for (const count of inDegree.values()) {
    if (count > 1) return []; // vertex has >1 incoming boundary edge: non-manifold, fail closed
  }

  const signedAreaXY = (loop: number[]): number => {
    let sum = 0;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const p = loop[i]!;
      const q = loop[(i + 1) % n]!;
      sum += positions[p * 3]! * positions[q * 3 + 1]! - positions[q * 3]! * positions[p * 3 + 1]!;
    }
    return sum / 2;
  };

  const visited = new Set<number>();
  let outer: number[] = [];
  let outerArea = -Infinity;
  for (const start of nextOf.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let cur = start;
    let closed = false;
    while (true) {
      if (visited.has(cur)) {
        closed = cur === start && loop.length >= 3;
        break;
      }
      visited.add(cur);
      loop.push(cur);
      const next = nextOf.get(cur);
      if (next === undefined) break; // dangling boundary chain: not a closed loop
      cur = next;
    }
    if (!closed) continue;
    const area = Math.abs(signedAreaXY(loop));
    if (area > outerArea) {
      outerArea = area;
      outer = loop;
    }
  }
  // Directed boundary edges point the way that keeps mesh interior on their
  // LEFT (standard convention for this triangle winding), which walks the
  // loop counter-clockwise in local-ENU XY as seen from +Z. Reverse to the
  // clockwise-from-above convention `buildTerrainSolidMass` is written
  // against (see its winding proof) — same loop, opposite traversal
  // direction, not a different boundary.
  return outer.slice().reverse();
}

/**
 * The one and only triangulation for every terrain-export artifact. The
 * compacted local-ENU vertex/index arrays are passed unchanged to GLB, IFC,
 * and 3DFACE emitters. Contours are extracted from this same DEM grid, not
 * from a second terrain source.
 */
export function buildTerrainMeshGeometry(
  dem: Pick<ParsedDem, "width" | "height" | "values">,
  bbox: BboxWgs84,
): TerrainMeshGeometry {
  if (dem.width < 2 || dem.height < 2) {
    throw new Error("DEM grid must be at least 2x2 to triangulate.");
  }
  const meanLatDegrees = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLatDegrees * Math.PI) / 180);
  const dLng = (bbox.eastLng - bbox.westLng) / (dem.width - 1);
  const dLat = (bbox.northLat - bbox.southLat) / (dem.height - 1);
  const ids = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  let hasHoles = false;

  const vertex = (gridIndex: number): number => {
    const found = ids.get(gridIndex);
    if (found !== undefined) return found;
    const x = gridIndex % dem.width;
    const y = (gridIndex - x) / dem.width;
    const lng = bbox.westLng + x * dLng;
    const lat = bbox.northLat - y * dLat;
    const id = positions.length / 3;
    positions.push(
      (lng - bbox.westLng) * METERS_PER_DEGREE_LAT * cosLat,
      (lat - bbox.southLat) * METERS_PER_DEGREE_LAT,
      dem.values[gridIndex]!,
    );
    ids.set(gridIndex, id);
    return id;
  };

  for (let y = 0; y < dem.height - 1; y++) {
    for (let x = 0; x < dem.width - 1; x++) {
      const tl = y * dem.width + x;
      const tr = tl + 1;
      const bl = tl + dem.width;
      const br = bl + 1;
      if (![tl, tr, bl, br].every((i) => Number.isFinite(dem.values[i]))) {
        hasHoles = true;
        continue;
      }
      const a = vertex(tl);
      const b = vertex(tr);
      const c = vertex(bl);
      const d = vertex(br);
      indices.push(c, d, b, c, b, a);
    }
  }
  if (!indices.length) throw new Error("DEM contains no fully covered terrain cell.");

  const indexArray = new Uint32Array(indices);
  // Derived from the real triangulated edges (see extractOuterBoundaryLoop),
  // not a grid-perimeter walk — a nodata gap on the DEM rim carves a real
  // notch here rather than being bridged by a chord. Winding is inherited
  // from the triangles' own (c, d, b) / (c, b, a) orientation above, which
  // downstream solid-mass construction relies on for outward-normal skirts.
  const boundaryLoopIndices = extractOuterBoundaryLoop(indexArray, positions);

  return {
    positions: new Float32Array(positions),
    indices: indexArray,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    hasHoles,
    georefOrigin: { originLng: bbox.westLng, originLat: bbox.southLat, meanLatDegrees },
    crsConvention: TERRAIN_MESH_CRS_CONVENTION,
    boundaryLoopIndices: boundaryLoopIndices.length >= 3 ? boundaryLoopIndices : [],
  };
}

export async function emitGlb(geometry: TerrainMeshGeometry): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc.createAccessor().setBuffer(buffer).setType("VEC3").setArray(geometry.positions),
    )
    .setIndices(
      doc.createAccessor().setBuffer(buffer).setType("SCALAR").setArray(geometry.indices),
    );
  const scene = doc.createScene();
  scene.addChild(doc.createNode("parcel-terrain").setMesh(doc.createMesh().addPrimitive(primitive)));
  return new NodeIO().writeBinary(doc);
}
