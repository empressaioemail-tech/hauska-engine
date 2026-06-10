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
  "flowLinesGeoJson": { "type": "FeatureCollection", "features": [] },
  "rainfallResultGeoJson": { "type": "FeatureCollection", "features": [] }
}
```

## Local setup

```bash
cd artifacts/hydrology-worker
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

Set `HYDROLOGY_PYTHON=artifacts/hydrology-worker/.venv/Scripts/python.exe`
(or rely on `python3` on PATH).

When Python/pysheds is unavailable, api-server falls back to the
inline TypeScript D8 engine in `@workspace/site-context/server`
(`hydrologyNative.ts`) — same contract, for dev/CI without the sidecar.
