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

# CHANNEL NETWORK + STAGE (2026-07-30 real-terrain calibration). Every one of
# these mirrors the identically-named export in
# packages/adapters/src/hydrology/hydrologyNative.ts, where the physical
# justification and the measurements behind each number are documented in full.
# The parity test asserts they stay identical across both backends.
CHANNEL_ACCUMULATION_FRACTION_OF_MAX = 0.02
CHANNEL_MIN_ACCUMULATION_CELLS = 10
MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS = 10_000
SCREENING_RUNOFF_COEFFICIENT = 0.5
HYDRAULIC_GEOMETRY_DEPTH_COEFFICIENT = 0.27
HYDRAULIC_GEOMETRY_DEPTH_EXPONENT = 0.39
RIVERINE_COVERAGE_MIN_CONTRIBUTING_AREA_SQ_METERS = 5_000_000

PONDING_BASIS_NOTE = (
    f"modeled standing water at or above {MIN_PONDING_DEPTH_METERS} m "
    f"({round(MIN_PONDING_DEPTH_METERS * 39.3701)} in) under the design storm, from "
    "depression storage (closed sinks on the DEM) COMBINED WITH low-lying inundation "
    "(terrain below the modeled stage of the drainage line it drains to, via height "
    "above nearest drainage). Screening model at DEM resolution: excludes infiltration, "
    "soil storage, culverts and storm sewer, and its contributing area is limited to the "
    "study window, so riverine stage from a larger upstream watershed is UNDER-represented. "
    "Not a hydraulic study; the FEMA NFHL remains authoritative for floodplain determination."
)

RIVERINE_OUT_OF_SCOPE_NOTE = (
    "RIVERINE FLOOD HAZARD IS OUT OF SCOPE FOR THIS STUDY. The modeled window's "
    "largest drainage network is far smaller than a river watershed, so channel "
    "stage from a river cannot be computed from this DEM and is NOT represented "
    'in the ponding figure. A zero or small ponding number here means "no modeled '
    'LOCAL storm ponding", NOT "outside the floodplain". Floodplain determination '
    "must come from the FEMA National Flood Hazard Layer or a site-specific "
    "hydraulic study."
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


def _cell_area_sq_meters(grid: Grid) -> float:
    """Ground area of one DEM cell in m2, from the grid affine.

    The rasters this worker is handed are WGS84 (the 3DEP export is requested
    in EPSG:4326), so the pixel size is in DEGREES and has to be converted:
    latitude degrees are near-constant, longitude degrees shrink by
    cos(latitude). Mirrors `cellAreaSquareMeters` in hydrologyNative.ts.
    """
    try:
        affine = grid.affine
        deg_w = abs(float(affine.a))
        deg_h = abs(float(affine.e))
        mid_lat = float(np.mean([grid.bbox[1], grid.bbox[3]]))
    except Exception:
        return 100.0
    if deg_w > 1.0 or deg_h > 1.0:
        # Already a projected CRS in meters — use the pixel size directly.
        area = deg_w * deg_h
        return area if np.isfinite(area) and area > 0 else 100.0
    meters_per_deg_lat = 110_540.0
    meters_per_deg_lng = 111_320.0 * np.cos(np.radians(mid_lat))
    area = (deg_w * meters_per_deg_lng) * (deg_h * meters_per_deg_lat)
    return float(area) if np.isfinite(area) and area > 0 else 100.0


def _channel_stage_meters(
    contributing_area_sq_m: np.ndarray | float, rainfall_m: float
) -> np.ndarray:
    """Design-storm stage in the receiving drainage line.

    Rational-method discharge then at-a-station hydraulic geometry; mirrors
    ``channelStageMeters`` in hydrologyNative.ts, where the derivation and its
    stated limits are documented. Below
    ``MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS`` there is no concentrated flow
    to carry a stage (hillslope sheet flow), so the stage is zero and only
    depression storage can pond.
    """
    area = np.asarray(contributing_area_sq_m, dtype=float)
    if rainfall_m <= 0:
        return np.zeros_like(area)
    volume = SCREENING_RUNOFF_COEFFICIENT * rainfall_m * area
    area_ha = area / 10_000.0
    tc_seconds = np.maximum(600.0, 1800.0 * np.sqrt(np.maximum(area_ha, 0.0)))
    discharge_cms = np.divide(
        volume, tc_seconds, out=np.zeros_like(area), where=tc_seconds > 0
    )
    depth = HYDRAULIC_GEOMETRY_DEPTH_COEFFICIENT * np.power(
        np.maximum(discharge_cms, 0.0), HYDRAULIC_GEOMETRY_DEPTH_EXPONENT
    )
    return np.where(area >= MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS, depth, 0.0)


def _hand(
    raw_dem: np.ndarray, fdir: np.ndarray, acc: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """HEIGHT ABOVE NEAREST DRAINAGE + the receiving line's contributing cells.

    Mirrors ``heightAboveNearestDrainage`` in hydrologyNative.ts: walk each
    cell downslope along D8 until a channel cell (accumulation over a
    window-relative threshold) is reached; HAND is the cell's elevation minus
    that channel cell's elevation. A path that leaves the raster yields NaN —
    an open outflow boundary, where no inundation can be asserted, never a
    substituted datum.

    pysheds encodes flow direction with the D8 compass values in ``DIRMAP``;
    this resolves each to a (drow, dcol) step.
    """
    dem = np.asarray(raw_dem, dtype=float)
    fdir_a = np.asarray(fdir)
    acc_a = np.asarray(acc, dtype=float)
    h, w = dem.shape
    max_acc = float(np.nanmax(acc_a)) if acc_a.size else 0.0
    channel_cells = max(
        CHANNEL_MIN_ACCUMULATION_CELLS,
        int(round(max_acc * CHANNEL_ACCUMULATION_FRACTION_OF_MAX)),
    )
    # DIRMAP order is (N, NE, E, SE, S, SW, W, NW) as used in `run`.
    steps = {
        64: (-1, 0),
        128: (-1, 1),
        1: (0, 1),
        2: (1, 1),
        4: (1, 0),
        8: (1, -1),
        16: (0, -1),
        32: (-1, -1),
    }
    hand = np.full(dem.shape, np.nan, dtype=float)
    recv = np.full(dem.shape, np.nan, dtype=float)
    resolved = np.zeros(dem.shape, dtype=bool)

    for r0 in range(h):
        for c0 in range(w):
            if resolved[r0, c0] or not np.isfinite(dem[r0, c0]):
                continue
            path: list[tuple[int, int]] = []
            on_path: set[tuple[int, int]] = set()
            r, c = r0, c0
            base_elev = np.nan
            base_acc = np.nan
            while True:
                if not np.isfinite(dem[r, c]):
                    break
                if resolved[r, c]:
                    base_elev = (
                        dem[r, c] - hand[r, c] if np.isfinite(hand[r, c]) else np.nan
                    )
                    base_acc = recv[r, c]
                    break
                if acc_a[r, c] >= channel_cells:
                    base_elev = dem[r, c]
                    base_acc = acc_a[r, c]
                    hand[r, c] = 0.0
                    recv[r, c] = base_acc
                    resolved[r, c] = True
                    break
                if (r, c) in on_path:
                    base_elev = dem[r, c]
                    base_acc = acc_a[r, c]
                    break
                on_path.add((r, c))
                path.append((r, c))
                step = steps.get(int(fdir_a[r, c]))
                if step is None:
                    # No downslope neighbour. On the raster border this is an
                    # open outflow boundary (undefined HAND); in the interior
                    # it is a true pit and is its own datum.
                    if r in (0, h - 1) or c in (0, w - 1):
                        base_elev = np.nan
                        base_acc = np.nan
                    else:
                        base_elev = dem[r, c]
                        base_acc = acc_a[r, c]
                    break
                nr, nc = r + step[0], c + step[1]
                if nr < 0 or nc < 0 or nr >= h or nc >= w:
                    base_elev = np.nan
                    base_acc = np.nan
                    break
                r, c = nr, nc
            for rr, cc in path:
                hand[rr, cc] = (
                    dem[rr, cc] - base_elev if np.isfinite(base_elev) else np.nan
                )
                recv[rr, cc] = base_acc
                resolved[rr, cc] = True
    return hand, recv


def _pond_mask(
    raw_dem: np.ndarray,
    filled_dem: np.ndarray,
    rainfall_m: float,
    hand: np.ndarray | None = None,
    contributing_area_sq_m: np.ndarray | None = None,
) -> np.ndarray:
    """PONDING = DEPRESSION STORAGE **OR** LOW-LYING INUNDATION.

    WHAT THE OLD RULE DID. This worker computed ``inflated = dem + rainfall_m``
    and then ``pond_mask = inflated > dem + rainfall_m * 0.25``. Substituting
    the first into the second reduces to ``rainfall_m > 0.25 * rainfall_m`` —
    TRUE for every cell of the raster whenever any rain falls at all. The
    pysheds path therefore marked the ENTIRE DEM as ponded, unconditionally.
    The native TS fallback had a different but equally indefensible rule (an
    INVERTED 1/accumulation wetness proxy over a 5 mm bar) that also passed
    ~100% of cells; on the live Bastrop parcel 48021:36249 it reported 396,134
    sq ft of ponding on a 398,813 sq ft parcel.

    TWO MECHANISMS, NOT ONE (2026-07-30 real-terrain calibration). Depression
    storage is kept unchanged:

        depression_depth = filled_dem - raw_dem
        pond_depth       = min(depression_depth, rainfall_m)

    ``fill_depressions`` raises exactly the cells with no downslope escape, so
    ``filled - raw`` is the height of the lip trapping water there. A cell on a
    slope has ``filled == raw``, so it never ponds however hard it rains.

    But depression storage ALONE cannot represent floodplain inundation, and
    measuring it on real 10 m terrain showed why: over five Bastrop windows
    ``filled - raw`` was exactly zero for 90-94% of cells (p50 and p90 both
    0.0000 m), because a floodplain is not a closed sink — it drains fine and
    floods anyway when the water surface beside it rises. So a second term is
    added, low-lying inundation against the modeled drainage stage:

        inundation = max(0, stage(receiving contributing area) - HAND)

    A cell's standing water is the DEEPER of the two, gated by
    MIN_PONDING_DEPTH_METERS. The channel bed itself (HAND <= 0) is conveyance,
    not standing water, and is excluded from the inundation term — without that
    exclusion a strictly monotonic slope reported inundation at its own outlet.

    DOES represent: screening-level local storm response — closed depressions,
    plus low ground along drainage lines INSIDE the study window. Does NOT
    represent: routed hydraulics, infiltration, soil storage, storm sewer or
    culvert capacity, flood timing/duration, or RIVERINE flooding driven by a
    watershed larger than the window (see RIVERINE_OUT_OF_SCOPE_NOTE). Mirrors
    `standingWaterDepthMeters` in the adapters hydrology package cell-for-cell.
    """
    depression_depth = np.asarray(filled_dem, dtype=float) - np.asarray(
        raw_dem, dtype=float
    )
    pond_depth = np.minimum(depression_depth, max(0.0, rainfall_m))
    pond_depth = np.nan_to_num(pond_depth, nan=0.0)
    pond_depth = np.where(depression_depth > 0, pond_depth, 0.0)

    if hand is not None and contributing_area_sq_m is not None:
        stage = _channel_stage_meters(contributing_area_sq_m, rainfall_m)
        hand_a = np.asarray(hand, dtype=float)
        inundation = np.where(
            np.isfinite(hand_a) & (hand_a > 0),
            np.maximum(0.0, stage - hand_a),
            0.0,
        )
        pond_depth = np.maximum(pond_depth, inundation)

    return pond_depth >= MIN_PONDING_DEPTH_METERS


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
        # HAND against the window's own drainage network supplies the
        # floodplain mechanism that depression storage structurally cannot —
        # see `_pond_mask` and `_hand`.
        hand, recv_cells = _hand(np.asarray(raw_dem), np.asarray(fdir), np.asarray(acc))
        cell_area_sq_m = _cell_area_sq_meters(grid)
        contributing_area = (
            np.nan_to_num(recv_cells, nan=1.0).clip(min=1.0) * cell_area_sq_m
        )
        pond_mask = _pond_mask(
            np.asarray(raw_dem),
            np.asarray(dem),
            rainfall_m,
            hand=hand,
            contributing_area_sq_m=contributing_area,
        )
        max_contributing = float(np.nanmax(contributing_area)) if contributing_area.size else 0.0
        riverine_resolved = (
            max_contributing >= RIVERINE_COVERAGE_MIN_CONTRIBUTING_AREA_SQ_METERS
        )
        pond_props: dict[str, Any] = {
            "rainfallDepthMm": rainfall_mm,
            "library": "pysheds",
            "pondingBasis": PONDING_BASIS_NOTE,
            "minPondingDepthMeters": MIN_PONDING_DEPTH_METERS,
            "pondingMechanisms": ["depression-storage", "low-lying-inundation"],
            "maxContributingAreaSqMeters": round(max_contributing),
            "riverineFloodHazardModeled": riverine_resolved,
        }
        if not riverine_resolved:
            pond_props["riverineFloodHazardNote"] = RIVERINE_OUT_OF_SCOPE_NOTE
        rainfall_result = _mask_to_geojson_polygons(
            grid,
            pond_mask.astype(bool),
            pond_props,
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
