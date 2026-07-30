# Hydrology worker (Phase 2D.2/2D.3)

Python sidecar invoked from cortex-api via JSON over stdio.

## Library

**pysheds** (chosen over WhiteboxTools): pure Python + NumPy, D8 flow
direction, accumulation, catchment delineation, and river-network
extraction without shipping a Rust/GDAL binary. WhiteboxTools offers
`RainfallRunoff` but adds heavier Cloud Run packaging; pysheds covers
2D.2 drainage and a depression-ponding pass for 2D.3.

## Request (stdin JSON)

```json
{
  "demPath": "/tmp/dem.tif",
  "pourLng": -97.6789,
  "pourLat": 30.5086,
  "rainfallDepthMm": 101.6,
  "accumulationThreshold": 50
}
```

## Response (stdout JSON)

```json
{
  "status": "ok",
  "library": "pysheds",
  "drainageZonesGeoJson": { "type": "FeatureCollection", "features": [] },
  "concentrationBandsGeoJson": { "type": "FeatureCollection", "features": [] },
  "flowLinesGeoJson": { "type": "FeatureCollection", "features": [] },
  "rainfallResultGeoJson": { "type": "FeatureCollection", "features": [] }
}
```

## Geometry: dissolved regions, not grid squares (2026-07-30)

`drainageZonesGeoJson` and `rainfallResultGeoJson` are DISSOLVED, SMOOTH
region polygons traced from the full-resolution boolean mask. They used to be
one small axis-aligned square per subsampled grid cell, which rendered as a
blue checkerboard and whose area sum did not match the true masked area.

`mask_regions.py` does the tracing and is a cell-for-cell MIRROR of
`packages/adapters/src/hydrology/maskRegions.ts`. Both hydrology backends must
produce the same kind of geometry so the picture does not change depending on
whether pysheds or the native-D8 fallback ran. Any change to one module must
land in the other; `test_mask_regions.py` locks the shared numbers and runs in
CI with the standard library only (no pysheds needed).

`concentrationBandsGeoJson` carries three NESTED bands with `concentration`
0 (low) / 1 (medium) / 2 (high) on each feature, thresholded from the D8
accumulation grid at the 70th and 90th percentile of the values inside the
catchment. A band identical to the catchment or empty is not emitted — the
overlay never paints a gradient the model does not show.

## Tests

```bash
python artifacts/hydrology-worker/test_mask_regions.py
```

Standard library only; exits non-zero on failure.

## Local setup

```bash
cd artifacts/hydrology-worker
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

Set `HYDROLOGY_PYTHON=artifacts/hydrology-worker/.venv/Scripts/python.exe`
(or rely on `python3` on PATH).

When Python/pysheds is unavailable, the caller falls back to the inline
TypeScript D8 engine at `packages/adapters/src/hydrology/hydrologyNative.ts` —
same contract, same geometry, for dev/CI without the sidecar.

## Deployment

This worker ships INSIDE the engine-api image; it is not a separately deployed
service. `services/engine-api/Dockerfile` installs `requirements.txt` and
`COPY artifacts/hydrology-worker ./artifacts/hydrology-worker`, and
`hydrologyWorkerClient.ts` spawns `run.py` by a path relative to its own
module. So an engine-api rebuild DOES ship a change to this directory — there
is no separate worker deploy to remember.
