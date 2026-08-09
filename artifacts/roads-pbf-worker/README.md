# Roads PBF worker (statewide L3)

Python sidecar that streams Geofabrik `.osm.pbf` highway ways intersecting
one or more county polygons. Invoked from Node ingest scripts; output is a
disk-backed NDJSON file (not unbounded stdout).

## Why Python

- Overpass cannot do Texas statewide (COUNT OOMs; 2-slot rate limit).
- No `osm.pbf` / osmium dependency existed in the Node tree; proof used
  out-of-tree `pyosmium`.
- Matches the `artifacts/hydrology-worker` / tile-pipeline Python sidecar
  pattern: heavy geo I/O stays out of the V8 heap.

## Backpressure

The FEMA-day lesson: an unbounded stdout queue racing ahead of DB-bound
consumers OOMs regardless of heap size. This worker writes NDJSON lines to
`--out-ndjson` and flushes every N lines. The Node orchestrator reads the
file after (or while) extract with a bounded write batch. Peak RSS during
extract is dominated by osmium's location index (`idx=flex_mem`), not by an
in-memory list of kept ways.

## Usage

```bash
cd artifacts/roads-pbf-worker
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt

python extract_highways.py \
  --pbf P:/tmp/statewide-roads/texas-latest.osm.pbf \
  --county-geojson P:/tmp/statewide-roads/bastrop_48021_county.geojson \
  --out-ndjson P:/tmp/statewide-roads/bastrop_48021_highways.ndjson \
  --report-json P:/tmp/statewide-roads/bastrop_48021_extract_report.json
```

Multi-county GeoJSON FeatureCollection is accepted: each feature must carry
`properties.countyFips` (or `GEOID` / `GEO_ID`).

## County-crossing ruling

When a way intersects N counties, the NDJSON element carries `countyHits`
with N entries. Node stamps full centerline into N `{fips}:road:{osmWayId}`
atoms. Ways are not clipped at the boundary.

## Deployment note

CLI/batch path for statewide ingest. Unlike hydrology-worker, this does not
need to ship inside the online engine-api image for the L3 fabric job.
