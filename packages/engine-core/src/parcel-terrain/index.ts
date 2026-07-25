export {
  buildTerrainMeshGeometry,
  emitGlb,
  TERRAIN_MESH_CRS_CONVENTION,
  type TerrainMeshGeometry,
} from "./mesh.js";
export {
  assertTerrainElevationIntegrity,
  meshElevationStats,
  TERRAIN_VERTICAL_DATUM,
  type MeshElevationStats,
  type TerrainVerticalDatum,
} from "./elevation.js";
export {
  collectContourPolylines,
  emitDxf3dFace,
  emitDxfContours,
  emitIfc,
  runDxfWorker,
  runIfcWorker,
  type ContourPolyline2d,
  type DxfWorkerResult,
  type IfcSpatialValidation,
  type IfcWorkerResult,
} from "./emitters.js";
export {
  buildTerrainSolidMass,
  DEFAULT_SKIRT_DEPTH_FEET,
  DEFAULT_SKIRT_DEPTH_METERS,
  FEET_TO_METERS,
  type BuildTerrainSolidMassOptions,
  type SolidMassGeometry,
} from "./solid-mass.js";


export {
  authorParcelTerrainExport,
  type AuthorParcelTerrainExportOptions,
  type ParcelGeometryResolver,
  type TerrainArtifactStore,
} from "./author.js";
export {
  TxgioDatabaseParcelGeometryResolver,
  ArcGisParcelGeometryResolver,
  createParcelGeometryResolverFromEnv,
  type ArcGisParcelSource,
  type ParcelGeometryRow,
  type TxgioDatabaseResolverOptions,
} from "./parcel-geometry-resolver.js";
