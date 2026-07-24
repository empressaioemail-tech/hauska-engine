import type { ParsedDem } from "../site-topography/index.js";
import type { TerrainMeshGeometry } from "./mesh.js";

/**
 * USGS 3DEP elevation is orthometric height on NAVD88 (geoid-based MSL),
 * in metres — not ellipsoidal height. Every export format must declare this.
 */
export const TERRAIN_VERTICAL_DATUM = {
  name: "NAVD88",
  kind: "orthometric",
  units: "metre",
  source: "USGS 3DEP",
  summary: "NAVD88 orthometric metres (USGS 3DEP; not ellipsoidal height)",
} as const;

export type TerrainVerticalDatum = typeof TERRAIN_VERTICAL_DATUM;

export interface MeshElevationStats {
  minZ: number;
  maxZ: number;
  vertexCount: number;
}

export function meshElevationStats(geometry: TerrainMeshGeometry): MeshElevationStats {
  let minZ = Infinity;
  let maxZ = -Infinity;
  const { positions } = geometry;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!;
    if (!Number.isFinite(z)) {
      throw new Error(`Terrain mesh contains non-finite Z at float index ${i}`);
    }
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minZ)) {
    throw new Error("Terrain mesh has no elevation samples");
  }
  return { minZ, maxZ, vertexCount: geometry.vertexCount };
}

/**
 * Fail closed before any format emit: Z must be real MSL-band elevation for the
 * parcel DEM, not nodata-as-zero spikes (~150 m below ground on Central TX land).
 */
export function assertTerrainElevationIntegrity(
  geometry: TerrainMeshGeometry,
  dem: Pick<ParsedDem, "minElevation" | "maxElevation">,
): MeshElevationStats {
  const stats = meshElevationStats(geometry);
  const eps = 0.05; // metres — float32 DEM / mesh tolerance
  if (stats.minZ < dem.minElevation - eps || stats.maxZ > dem.maxElevation + eps) {
    throw new Error(
      `Terrain mesh Z [${stats.minZ}, ${stats.maxZ}] outside DEM band ` +
        `[${dem.minElevation}, ${dem.maxElevation}] (${TERRAIN_VERTICAL_DATUM.summary})`,
    );
  }
  // Land parcels with real ground well above sea level must not ship a 0.0 vertex.
  if (dem.minElevation > 20 && stats.minZ < 1) {
    throw new Error(
      `Terrain mesh min-Z ${stats.minZ} looks like nodata-as-zero on a parcel ` +
        `with DEM min ${dem.minElevation} m ${TERRAIN_VERTICAL_DATUM.name}; refusing to ship`,
    );
  }
  if (dem.minElevation > 20 && stats.minZ < dem.minElevation * 0.5) {
    throw new Error(
      `Terrain mesh min-Z ${stats.minZ} is more than 50% below DEM min ` +
        `${dem.minElevation} m — probable nodata spike; refusing to ship`,
    );
  }
  return stats;
}
