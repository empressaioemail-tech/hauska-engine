#!/usr/bin/env python3
"""
Smoke test for the pysheds worker: spawn run.py exactly the way the
Node client does (JSON request on stdin, JSON result on stdout) against
a synthetic DEM, and assert an ok/pysheds result within the runtime
timeout budget. Runs at image-build time (layer test) and can be run
manually inside a container.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_PY = os.environ.get("HYDROLOGY_RUN_PY") or os.path.join(HERE, "run.py")
if not os.path.exists(RUN_PY):
    RUN_PY = "/tmp/hydrology-run.py"

size = 96
rng = np.random.default_rng(7)
xx, yy = np.meshgrid(np.arange(size), np.arange(size))
dem = (
    120.0
    + 0.4 * xx
    + 0.2 * yy
    - 6.0 * np.exp(-((yy - size / 2) ** 2) / 80.0)
    + rng.normal(0, 0.05, (size, size))
).astype("float32")

with tempfile.TemporaryDirectory() as tmp:
    dem_path = os.path.join(tmp, "dem.tif")
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        height=size,
        width=size,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-97.94, 29.89, 0.0001, 0.0001),
    ) as dst:
        dst.write(dem, 1)

    request = {
        "demPath": dem_path,
        "pourLng": -97.9355,
        "pourLat": 29.8855,
        "rainfallDepthMm": 101.6,
        "accumulationThreshold": 50,
    }

    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, RUN_PY],
        input=json.dumps(request).encode("utf-8"),
        capture_output=True,
        timeout=180,
    )
    elapsed = time.time() - t0

    print(f"[smoke] run.py exited {proc.returncode} in {elapsed:.1f}s", file=sys.stderr)
    if proc.stderr:
        sys.stderr.write(proc.stderr.decode("utf-8", "replace")[:2000] + "\n")
    if proc.returncode != 0:
        raise SystemExit(f"run.py exited {proc.returncode}")

    result = json.loads(proc.stdout.decode("utf-8"))
    status = result.get("status")
    library = result.get("library")
    flow = result.get("flowLinesGeoJson") or {}
    zones = result.get("drainageZonesGeoJson") or {}
    print(
        f"[smoke] status={status} library={library} "
        f"flowLines={len(flow.get('features') or [])} "
        f"zones={len(zones.get('features') or [])}",
        file=sys.stderr,
    )
    if status != "ok" or library != "pysheds":
        raise SystemExit(f"unexpected worker result: {json.dumps(result)[:500]}")
    if elapsed > 45:
        print(
            f"[smoke] WARNING: {elapsed:.1f}s exceeds the old 45s budget — "
            "check the numba cache layer",
            file=sys.stderr,
        )
    print("[smoke] pysheds worker OK", file=sys.stderr)
