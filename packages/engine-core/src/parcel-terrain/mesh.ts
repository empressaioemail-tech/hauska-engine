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
   * Outer perimeter vertex ids (indices into `positions`), walked in DEM
   * grid order (top row west->east, east column north->south, bottom row
   * east->west, west column south->north). Consumers building a closed
   * solid (site-plan terrain mass) extrude this loop downward. Perimeter
   * grid cells that are nodata are skipped, not invented; if that leaves
   * fewer than 3 vertices, boundaryLoopIndices is empty and closed-solid
   * construction must fail closed rather than fabricate a boundary.
   */
  boundaryLoopIndices: number[];
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

  // Walk the DEM grid perimeter once (top row, right column, bottom row,
  // left column) collecting whichever cells were actually triangulated.
  // This traversal is clockwise as seen from above (+Z looking down), which
  // downstream solid-mass construction relies on for outward-normal skirts.
  const boundaryGridIndexes: number[] = [];
  const lastRow = dem.height - 1;
  const lastCol = dem.width - 1;
  for (let x = 0; x <= lastCol; x++) boundaryGridIndexes.push(0 * dem.width + x);
  for (let y = 1; y <= lastRow; y++) boundaryGridIndexes.push(y * dem.width + lastCol);
  for (let x = lastCol - 1; x >= 0; x--) boundaryGridIndexes.push(lastRow * dem.width + x);
  for (let y = lastRow - 1; y >= 1; y--) boundaryGridIndexes.push(y * dem.width + 0);
  const boundaryLoopIndices: number[] = [];
  for (const gridIndex of boundaryGridIndexes) {
    const vertexId = ids.get(gridIndex);
    if (vertexId !== undefined) boundaryLoopIndices.push(vertexId);
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
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
