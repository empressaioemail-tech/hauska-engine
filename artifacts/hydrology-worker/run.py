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


def _mask_to_geojson_polygons(
    grid: Grid, mask: np.ndarray, properties: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Convert a boolean mask to a coarse GeoJSON FeatureCollection."""
    props = properties or {}
    features: list[dict[str, Any]] = []
    height, width = mask.shape
    step = max(1, min(height, width) // 20)
    for row in range(0, height, step):
        for col in range(0, width, step):
            if not mask[row, col]:
                continue
            lng0, lat0 = _cell_to_lnglat(grid, col, row)
            lng1, lat1 = _cell_to_lnglat(grid, min(col + step, width - 1), row)
            lng2, lat2 = _cell_to_lnglat(
                grid, min(col + step, width - 1), min(row + step, height - 1)
            )
            lng3, lat3 = _cell_to_lnglat(grid, col, min(row + step, height - 1))
            ring = [
                [lng0, lat0],
                [lng1, lat1],
                [lng2, lat2],
                [lng3, lat3],
                [lng0, lat0],
            ]
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": dict(props),
                }
            )
    return {"type": "FeatureCollection", "features": features}


def _river_network_to_geojson(
    grid: Grid, branches: list[dict[str, Any]]
) -> dict[str, Any]:
    features: list[dict[str, Any]] = []
    for branch in branches:
        coords = branch.get("coordinates") or []
        if len(coords) < 2:
            continue
        line = [[float(c[0]), float(c[1])] for c in coords]
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": line},
                "properties": {"accumulation": branch.get("accumulation")},
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

    drainage_zones = _mask_to_geojson_polygons(
        grid,
        catch.astype(bool),
        {"zone": "catchment", "library": "pysheds"},
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
