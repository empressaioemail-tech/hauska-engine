# Terrain DXF — CAD / Revit import notes

Formats: `dxf-3dface` (triangle surface) and `dxf-contour` (constant-Z polylines).
Both share one triangulation / DEM; LandXML TIN remains deferred.

## File shape

Each DXF is written by the `artifacts/dxf-worker` ezdxf sidecar as a full
AutoCAD 2000 (`AC1015`) drawing, not a hand-rolled ENTITIES fragment:

- `HEADER`: `$ACADVER=AC1015`, `$INSUNITS=6` (meters), `$MEASUREMENT=1`
- `TABLES`: `LTYPE`, `LAYER` (`TERRAIN` or `TERRAIN_CONTOURS`), and `BLOCK_RECORD`
  (`*Model_Space` / `*Paper_Space`)
- `BLOCKS`: model/paper space block definitions
- `ENTITIES`: `3DFACE` (mesh) or closed 3D `POLYLINE` + `VERTEX` + `SEQEND` (contours)
- `OBJECTS`: dictionaries + `LAYOUT` (required by Revit Link/Import CAD)
- Entity **handles** (group code 5) on table rows and entities
- `EOF`

Coordinates are **parcel-local ENU meters** (origin at southwest of the DEM bbox),
not state-plane feet and not WGS84 lon/lat. A typical small parcel is only tens of
meters across — after Link CAD, use **Zoom to Fit** / **Zoom All** or the contours
look “missing” next to a large aerial site.

## Revit (product path)

1. **Re-export** after any emitter fix (`refresh_parcel_terrain_export`) — do not reuse an older download.
2. Prefer **Insert → Link CAD** (Import CAD is acceptable once the file is R2000-complete).
3. Target a **floor plan or site plan**, not a Drafting View.
4. Link CAD options: units **meters**; uncheck **Current view only** if you want the link in other views.
5. After link: **Zoom to Fit**. Contours sit near the project origin in local meters unless you move/align them to the site.
6. Contours: layer `TERRAIN_CONTOURS`. Mesh faces: layer `TERRAIN` (3DFACE is a surface mesh; for topo lines prefer `dxf-contour`).

Opening the DXF in AutoCAD / TrueView and saving as DWG is a diagnostic workaround
only. The shipped PE/MCP download must Link CAD without that round-trip.

Do not expect Civil3D proxy / AECC objects — we emit only standard `3DFACE` /
`POLYLINE`+`VERTEX`.

## Alternatives in Revit

- **IFC** (`ifc` artifact): complete IFC4 spatial model — `IfcProject` →
  `IfcRelAggregates` → `IfcSite` (RefLat/RefLong + `IfcMapConversion` to local-ENU
  metres) → `IfcRelContainedInSpatialStructure` → placed `IfcGeographicElement`
  (`IfcTriangulatedFaceSet`). A floating mesh with no Site/containment/placement
  is rejected by the worker and must not ship.
- **GLB**: mesh preview outside Revit; not a native Revit import path.

See also `artifacts/ifc-worker/validate_spatial.py` (fails closed on empty trees).

