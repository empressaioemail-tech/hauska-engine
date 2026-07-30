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

# Speck floor for DELINEATED layers (catchment, ponding, concentration bands)
# — keep whatever the model actually delineated; the study decides negligible.
DELINEATED_SPECK_FLOOR_CELLS = 1

# Fewest catchment cells that can carry a meaningful 70th/90th-percentile
# split. Below this the quantiles land on the same one or two values and any
# "band" is a single cell of DEM noise, so the model reports the honest
# too-small state instead. Mirrors MIN_BANDABLE_CATCHMENT_CELLS in
# packages/adapters/src/hydrology/hydrologyNative.ts.
MIN_BANDABLE_CATCHMENT_CELLS = 12

# PONDING CRITERION — see `_pond_mask` and the TS `pondingDepthMeters`.
MIN_PONDING_DEPTH_METERS = 0.1

PONDING_BASIS_NOTE = (
    f"modeled depression storage at or above {MIN_PONDING_DEPTH_METERS} m "
    f"({round(MIN_PONDING_DEPTH_METERS * 39.3701)} in) of standing water under the design storm; "
    "closed depressions on the DEM only, excluding infiltration, soil storage "
    "and drainage infrastructure"
)

CONCENTRATION_BASIS_NO_GRADIENT = (
    "modeled catchment extent; flow accumulation is uniform across it, so no "
    "concentration gradient was modeled"
)


def concentration_basis_too_small(cells: int) -> str:
    """Self-describing basis for a catchment too small to band."""
    unit = "cell" if cells == 1 else "cells"
    return (
        f"modeled catchment extent; too small to band at this resolution "
        f"({cells} DEM {unit}, under the {MIN_BANDABLE_CATCHMENT_CELLS}-cell "
        "minimum for a flow-concentration split)"
    )


def _pond_mask(
    raw_dem: np.ndarray, filled_dem: np.ndarray, rainfall_m: float
) -> np.ndarray:
    """PONDING = DEPRESSION STORAGE, NOT WETNESS (2026-07-30 credible fix).

    WHAT THE OLD RULE DID. This worker computed ``inflated = dem + rainfall_m``
    and then ``pond_mask = inflated > dem + rainfall_m * 0.25``. Substituting
    the first into the second reduces to ``rainfall_m > 0.25 * rainfall_m`` —
    TRUE for every cell of the raster whenever any rain falls at all. The
    pysheds path therefore marked the ENTIRE DEM as ponded, unconditionally.
    The native TS fallback had a different but equally indefensible rule (an
    INVERTED 1/accumulation wetness proxy over a 5 mm bar) that also passed
    ~100% of cells; on the live Bastrop parcel 48021:36249 it reported 396,134
    sq ft of ponding on a 398,813 sq ft parcel.

    WHAT THE NEW RULE DOES. A cell ponds where it is an actual DEPRESSION and
    the trapped water is deep enough to matter to a building pad:

        depression_depth = filled_dem - raw_dem
        pond_depth       = min(depression_depth, rainfall_m)
        ponded           = pond_depth >= MIN_PONDING_DEPTH_METERS

    ``fill_depressions`` raises exactly the cells with no downslope escape, so
    ``filled - raw`` is the height of the lip trapping water there. A cell on a
    slope has ``filled == raw``, so it never ponds however hard it rains — the
    physical statement "water runs off a slope; it stands in a hollow". The
    ponded depth is capped by what the storm actually delivers.

    DOES represent: screening-level identification of closed depressions on the
    DEM holding at least 4 inches of standing water under the design storm.
    Does NOT represent: routed hydraulics, infiltration, soil storage, storm
    sewer or culvert capacity, or flood timing/duration. Mirrors
    `pondingDepthMeters` in the adapters hydrology package cell-for-cell.
    """
    depression_depth = np.asarray(filled_dem, dtype=float) - np.asarray(
        raw_dem, dtype=float
    )
    pond_depth = np.minimum(depression_depth, max(0.0, rainfall_m))
    return np.nan_to_num(pond_depth, nan=0.0) >= MIN_PONDING_DEPTH_METERS


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

    TOO SMALL TO BAND — AN EXPLICIT STATE (2026-07-30). On the live Bastrop
    parcel 48021:36249 the catchment was ~3 cells of a 10 m DEM; percentile
    bands over three values are meaningless, and the single-cell band masks
    were then swallowed by the library speck filter, so the payload carried one
    feature tagged concentration 0 with a generic basis — indistinguishable
    from a rendering bug to a client painting three tones. A catchment under
    MIN_BANDABLE_CATCHMENT_CELLS now short-circuits to band 0 with a
    self-describing basis naming the cell count and why no banding ran.
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

        # EVERY band keeps whatever the model delineated. Bands 1 and 2 were
        # previously left on the library speck floor (MIN_REGION_AREA_CELLS),
        # which silently DELETED genuine small bands and left the payload
        # looking like band 0 alone — half of the 2026-07-30 banding defect.
        # The too-small-to-band guard below now protects against noise, out
        # loud, instead of a filter deleting bands in silence.
        fc = regions_to_feature_collection(
            mask_to_regions(
                read,
                int(width),
                int(height),
                min_region_area_cells=DELINEATED_SPECK_FLOOR_CELLS,
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

    catchment_cells = int(mask_bool.sum())

    # TOO SMALL TO BAND — explicit, self-describing, never a silent collapse.
    if catchment_cells < MIN_BANDABLE_CATCHMENT_CELLS:
        emit(mask_bool, 0, concentration_basis_too_small(catchment_cells))
        return {"type": "FeatureCollection", "features": features}

    # Build the higher bands FIRST so band 0 can carry an honest basis: if no
    # gradient survives, band 0 must say the field is uniform rather than imply
    # a split that was never emitted.
    higher: list[tuple[np.ndarray, int, str]] = []
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
        if cells == 0 or cells == catchment_cells:
            continue
        higher.append(
            (
                band,
                concentration,
                f"D8 flow accumulation at or above {cutoff:g} upstream cells",
            )
        )

    emit(
        mask_bool,
        0,
        "modeled catchment extent" if higher else CONCENTRATION_BASIS_NO_GRADIENT,
    )
    for band, concentration, note in higher:
        emit(band, concentration, note)

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
    # Keep the RAW DEM: the ponding criterion reads `filled - raw` as the depth
    # of the depression trapping water, so rebinding `dem` to the filled result
    # (as this did before 2026-07-30) destroys the only signal that
    # distinguishes a hollow from a slope.
    raw_dem = grid.read_raster(dem_path)
    dem = grid.fill_depressions(raw_dem)
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
        pond_mask = _pond_mask(np.asarray(raw_dem), np.asarray(dem), rainfall_m)
        rainfall_result = _mask_to_geojson_polygons(
            grid,
            pond_mask.astype(bool),
            {
                "rainfallDepthMm": rainfall_mm,
                "library": "pysheds",
                "pondingBasis": PONDING_BASIS_NOTE,
                "minPondingDepthMeters": MIN_PONDING_DEPTH_METERS,
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
