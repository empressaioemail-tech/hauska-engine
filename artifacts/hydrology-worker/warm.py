#!/usr/bin/env python3
"""
Build-time numba warm for the pysheds hydrology worker.

pysheds' _sgrid kernels are eager-compiled numba @njit functions (explicit
signatures), most with cache=True. On a cold process, importing pysheds and
running the D8 pipeline pays the full JIT compile — measured >45s on Cloud
Run, which is exactly the production `pysheds worker exceeded 45000ms`
timeout that forced every request onto the native-D8 fallback.

Running this during `docker build` (with NUMBA_CACHE_DIR pointing at a
directory that ships in the image) compiles the cache=True kernels once and
bakes the cache into the image layer, so runtime spawns of run.py skip the
bulk of the compile. It exercises the same pysheds calls run.py makes:
fill_depressions, flowdir, accumulation, snap_to_mask, catchment,
extract_river_network.

It doubles as a build-time functional check: if pysheds/rasterio/GDAL are
broken in the image, the build fails here instead of silently shipping an
image that degrades to native-D8 on every request.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time

t0 = time.time()

import numpy as np
import rasterio
from rasterio.transform import from_origin
from pysheds.grid import Grid

print(f"[warm] imports done in {time.time() - t0:.1f}s", file=sys.stderr)

DIRMAP = (64, 128, 1, 2, 4, 8, 16, 32)

# Small synthetic DEM: a tilted plane with a channel so flowdir /
# accumulation / catchment / river-network all have real work to do.
size = 64
rng = np.random.default_rng(42)
xx, yy = np.meshgrid(np.arange(size), np.arange(size))
dem = (
    100.0
    + 0.5 * xx
    + 0.25 * yy
    - 5.0 * np.exp(-((xx - size / 2) ** 2) / 50.0)
    + rng.normal(0, 0.05, (size, size))
).astype("float32")

with tempfile.TemporaryDirectory() as tmp:
    dem_path = os.path.join(tmp, "warm-dem.tif")
    transform = from_origin(-97.94, 29.89, 0.0001, 0.0001)
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        height=size,
        width=size,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
    ) as dst:
        dst.write(dem, 1)

    t1 = time.time()
    grid = Grid.from_raster(dem_path, data_name="dem")
    raster = grid.read_raster(dem_path)
    filled = grid.fill_depressions(raster)
    fdir = grid.flowdir(filled, dirmap=DIRMAP)
    acc = grid.accumulation(fdir, dirmap=DIRMAP)
    x, y = grid.snap_to_mask(acc > 1, (-97.937, 29.887))
    catch = grid.catchment(x=x, y=y, fdir=fdir, dirmap=DIRMAP, xytype="coordinate")
    branches = grid.extract_river_network(fdir, acc > 10, dirmap=DIRMAP)
    branch_count = (
        len(branches.get("features") or [])
        if isinstance(branches, dict)
        else len(branches)
        if isinstance(branches, list)
        else -1
    )
    print(
        f"[warm] pipeline done in {time.time() - t1:.1f}s "
        f"(catch cells={int(np.asarray(catch).astype(bool).sum())}, "
        f"branches={branch_count})",
        file=sys.stderr,
    )

print(f"[warm] total {time.time() - t0:.1f}s — numba cache populated", file=sys.stderr)
