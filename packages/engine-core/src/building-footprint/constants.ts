/** Microsoft Global ML Building Footprints — statewide uniform default (T3 WS4). */

export const GLOBAL_ML_TEXAS_ZIP_URL =
  "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Texas.geojson.zip";

export const GLOBAL_ML_REPO_URL =
  "https://github.com/microsoft/GlobalMLBuildingFootprints";

/** ODC-By attribution required on every ml-derived atom (contract negative guard). */
export const ML_FOOTPRINT_SOURCE_CITATION =
  "Microsoft Building Footprints (ODC-By 1.0) via ml-global-building-footprints-v1";

export const ML_FOOTPRINT_SOURCE_VINTAGE = "GlobalMLBuildingFootprints-Texas";

export const FOOTPRINT_WRITER_ADAPTER = "ml-global-building-footprints-v1";

/** Spatial join thresholds (ingest spec §4.1). */
export const PRIMARY_OVERLAP_MIN = 0.5;
export const STRADDLE_OVERLAP_MIN = 0.1;

/** Default provenance when ML bbox filter returns zero features. */
export const ML_EMPTY_BBOX_PROVENANCE_SCOPE = [
  GLOBAL_ML_REPO_URL,
  GLOBAL_ML_TEXAS_ZIP_URL,
  "bbox-filter returned zero ML footprint polygons for county extent",
] as const;
