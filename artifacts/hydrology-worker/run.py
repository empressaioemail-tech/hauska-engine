#!/usr/bin/env python3
"""
Site hydrology worker — Phase 2D.2/2D.3 (pysheds).

Reads a JSON request on stdin, writes a JSON result on stdout.
See README.md for the request/response contract.

Library: pysheds (D8 flow direction, accumulation, catchment,
river-network extraction). Chosen over WhiteboxTools for lighter
Python-only deployment on Cloud Run sidecars without a Rust binary.
"""
from __future__ import annotations

import json
import sys
import traceback
from typing import Any

try:
    import numpy as np
    from pysheds.grid import Grid
except ImportError as exc:  # pragma: no cover
    print(
        json.dumps(
            {
                "status": "error",
                "code": "missing-deps",
                "message": f"pysheds/numpy not installed: {exc}",
            }
        )
    )
    sys.exit(1)


from mask_regions import (
    MIN_REGION_AREA_CELLS,
    mask_to_regions,
    regions_to_feature_collection,
)

DIRMAP = (64, 128, 1, 2, 4, 8, 16, 32)
ACCUMULATION_THRESHOLD = 50


def _error(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout)
    sys.stdout.flush()


def _cell_to_lnglat(
    grid: Grid, col: int, row: int
) -> tuple[float, float]:
    x, y = grid.affine * (col + 0.5, row + 0.5)
    return float(x), float(y)


def _grid_to_lnglat(grid: Grid) -> Any:
    """Grid-space (x, y) in CELL-EDGE units -> WGS84 via the raster affine.

    `mask_regions` works in a frame where (x, y) means x cells right of column
    0's LEFT edge and y cells below row 0's TOP edge, so the point goes to the
    affine as-is; the +0.5 offsets in `_cell_to_lnglat` are for cell CENTRES.
    """

    def to_lnglat(x: float, y: float) -> tuple[float, float]:
        lng, lat = grid.affine * (x, y)
        return float(lng), float(lat)

    return to_lnglat


def _mask_to_geojson_polygons(
    grid: Grid, mask: np.ndarray, properties: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Boolean mask -> DISSOLVED, SMOOTH GeoJSON Polygons (2026-07-30).

    Replaces the old subsampled-lattice emitter, which walked the mask at
    `step = min(h, w) // 20` and pushed ONE INDEPENDENT AXIS-ALIGNED SQUARE per
    sampled hit cell — the blue-checkerboard defect, and an area sum that
    under-counted the true mask because only every step-th cell contributed.

    PARITY: `mask_regions.py` mirrors
    `packages/adapters/src/hydrology/maskRegions.ts` cell-for-cell, so the
    pysheds path and the native-D8 fallback draw the same kind of picture. All
    tolerances, the speck threshold and the feature/vertex caps are documented
    at the top of that module.

    SPECK THRESHOLD, per layer. The DELINEATED CATCHMENT is one traced region
    whose area is a HEADLINE STAT, and on a coarse drainage DEM a real parcel
    catchment can legitimately be only a couple of cells — dropping it would
    silently zero a reported number. Catchment/ponding tracing therefore uses
    DELINEATED_SPECK_FLOOR_CELLS (keep anything the model delineated) and lets
    the study decide what is negligible, which it already does explicitly.
    """
    height, width = mask.shape
    as_bool = np.asarray(mask, dtype=bool)

    def read(col: int, row: int) -> bool:
        return bool(as_bool[row, col])

    regions = mask_to_regions(
        read,
        int(width),
        int(height),
        min_region_area_cells=DELINEATED_SPECK_FLOOR_CELLS,
    )
    return regions_to_feature_collection(
        regions, _grid_to_lnglat(grid), properties or {}
    )


CONCENTRATION_BAND_QUANTILES = (0.7, 0.9)

# Speck floor for DELINEATED layers (catchment, ponding, concentration band 0)
# — keep whatever the model actually delineated; the study decides negligible.
DELINEATED_SPECK_FLOOR_CELLS = 1


def _concentration_bands(
    grid: Grid,
    catch_mask: np.ndarray,
    acc: np.ndarray,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """THREE NESTED CONCENTRATION BANDS from the D8 accumulation raster.

    Bands are derived from the MODEL, not by re-bucketing polygon vertex
    counts: accumulation inside the catchment is thresholded at two quantiles
    of the values actually present there (so the bands adapt to the terrain
    rather than asserting an absolute drainage-area scale the DEM may not
    support), and each level is traced as its own dissolved region.

      concentration 0 (low)    - the whole catchment mask
      concentration 1 (medium) - accumulation at or above the 70th percentile
      concentration 2 (high)   - accumulation at or above the 90th percentile

    Higher bands are strict subsets of lower ones, so the three bands NEST.
    A band whose mask is empty is simply not emitted; nothing is invented.
    Mirrors `deriveConcentrationBands` in the adapters hydrology package.
    """
    props = properties or {}
    mask_bool = np.asarray(catch_mask, dtype=bool)
    acc_arr = np.asarray(acc)
    inside = acc_arr[mask_bool]
    features: list[dict[str, Any]] = []
    if inside.size == 0:
        return {"type": "FeatureCollection", "features": features}
    height, width = mask_bool.shape
    to_lnglat = _grid_to_lnglat(grid)

    def emit(band: np.ndarray, concentration: int, note: str) -> None:
        def read(col: int, row: int) -> bool:
            return bool(band[row, col])

        # Band 0 IS the delineated catchment — keep whatever the model
        # delineated. Bands 1 and 2 are thresholded fields where the library
        # speck filter is the right one.
        fc = regions_to_feature_collection(
            mask_to_regions(
                read,
                int(width),
                int(height),
                min_region_area_cells=(
                    DELINEATED_SPECK_FLOOR_CELLS if concentration == 0 else MIN_REGION_AREA_CELLS
                ),
            ),
            to_lnglat,
            {
                **props,
                "zone": "drainage-concentration",
                "concentration": concentration,
                "concentrationBasis": note,
            },
        )
        features.extend(fc["features"])

    emit(mask_bool, 0, "modeled catchment extent")

    seen: set[float] = set()
    for concentration, q in (
        (1, CONCENTRATION_BAND_QUANTILES[0]),
        (2, CONCENTRATION_BAND_QUANTILES[1]),
    ):
        cutoff = float(np.quantile(inside, q))
        # A degenerate accumulation field can put two quantiles on the same
        # value; emitting the identical ring twice would fake a band.
        if cutoff <= 0 or cutoff in seen:
            continue
        seen.add(cutoff)
        band = mask_bool & (acc_arr >= cutoff)
        cells = int(band.sum())
        # A band identical to the catchment (a flat accumulation field puts
        # every cell over the cutoff) is not a CONCENTRATION — painting it as
        # one would assert a gradient the model does not show.
        if cells == 0 or cells == int(mask_bool.sum()):
            continue
        emit(
            band,
            concentration,
            f"D8 flow accumulation at or above {cutoff:g} upstream cells",
        )

    return {"type": "FeatureCollection", "features": features}


def _river_network_to_geojson(
    grid: Grid, branches: Any
) -> dict[str, Any]:
    """Normalize extract_river_network output to a FeatureCollection.

    pysheds >=0.3 (sgrid) returns a GeoJSON-like FeatureCollection dict
    (``{"type": ..., "features": [{"geometry": {"coordinates": ...}}]}``);
    older code paths returned a list of branch dicts with a top-level
    ``coordinates`` key. Handle both — iterating the dict form as a list
    yields its string keys and crashed the worker with AttributeError.
    """
    if isinstance(branches, dict):
        raw = branches.get("features") or []
    elif isinstance(branches, list):
        raw = branches
    else:
        raw = []

    features: list[dict[str, Any]] = []
    for branch in raw:
        if not isinstance(branch, dict):
            continue
        geometry = branch.get("geometry")
        if isinstance(geometry, dict):
            coords = geometry.get("coordinates") or []
        else:
            coords = branch.get("coordinates") or []
        if len(coords) < 2:
            continue
        line = [[float(c[0]), float(c[1])] for c in coords]
        props = branch.get("properties") if isinstance(branch.get("properties"), dict) else {}
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": line},
                "properties": {
                    "accumulation": branch.get("accumulation", props.get("accumulation")),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def run(req: dict[str, Any]) -> dict[str, Any]:
    dem_path = req.get("demPath")
    if not isinstance(dem_path, str) or not dem_path:
        raise ValueError("demPath is required")

    pour_lng = float(req.get("pourLng", 0))
    pour_lat = float(req.get("pourLat", 0))
    rainfall_mm = float(req.get("rainfallDepthMm") or 0)
    acc_threshold = int(req.get("accumulationThreshold") or ACCUMULATION_THRESHOLD)

    grid = Grid.from_raster(dem_path, data_name="dem")
    dem = grid.read_raster(dem_path)
    dem = grid.fill_depressions(dem)
    fdir = grid.flowdir(dem, dirmap=DIRMAP)
    acc = grid.accumulation(fdir, dirmap=DIRMAP)

    # Snap pour point to high-accumulation cell near parcel centroid.
    x, y = grid.snap_to_mask(acc > 1, (pour_lng, pour_lat))
    catch = grid.catchment(
        x=x, y=y, fdir=fdir, dirmap=DIRMAP, xytype="coordinate"
    )

    catch_mask = np.asarray(catch).astype(bool)
    drainage_zones = _mask_to_geojson_polygons(
        grid,
        catch_mask,
        {"zone": "catchment", "library": "pysheds"},
    )
    concentration_bands = _concentration_bands(
        grid, catch_mask, np.asarray(acc), {"library": "pysheds"}
    )

    branches = grid.extract_river_network(
        fdir, acc > acc_threshold, dirmap=DIRMAP
    )
    flow_lines = _river_network_to_geojson(grid, branches)

    rainfall_result = None
    if rainfall_mm > 0:
        rainfall_m = rainfall_mm / 1000.0
        inflated = dem + rainfall_m
        pond_mask = inflated > dem + (rainfall_m * 0.25)
        rainfall_result = _mask_to_geojson_polygons(
            grid,
            pond_mask.astype(bool),
            {
                "rainfallDepthMm": rainfall_mm,
                "library": "pysheds",
            },
        )

    return {
        "status": "ok",
        "library": "pysheds",
        "libraryVersion": "0.3",
        "routing": "d8",
        "accumulationThreshold": acc_threshold,
        "drainageZonesGeoJson": drainage_zones,
        "concentrationBandsGeoJson": concentration_bands,
        "flowLinesGeoJson": flow_lines,
        "rainfallResultGeoJson": rainfall_result,
        "pourPoint": {"lng": pour_lng, "lat": pour_lat},
    }


def main() -> None:
    try:
        req = json.load(sys.stdin)
        result = run(req)
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
    except Exception as exc:  # pragma: no cover
        _error("worker-failed", f"{exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
