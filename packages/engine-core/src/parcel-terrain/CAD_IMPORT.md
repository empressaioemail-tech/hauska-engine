# Terrain DXF — CAD / Revit import notes

Formats: `dxf-3dface` (triangle surface) and `dxf-contour` (constant-Z polylines).
Both share one triangulation / DEM; LandXML TIN remains deferred.

## File shape

Each DXF includes:

- `HEADER`: `$ACADVER=AC1015` (AutoCAD 2000), `$INSUNITS=6` (meters), `$MEASUREMENT=1` (metric)
- `TABLES`: `LTYPE` (CONTINUOUS) then `LAYER` (`TERRAIN` or `TERRAIN_CONTOURS`)
- `BLOCKS`: empty section (strict readers require it)
- `ENTITIES`: `3DFACE` (mesh) or closed 3D `POLYLINE` + `VERTEX` + `SEQEND` (contours, Z on each vertex)
- `EOF`

Coordinates are **parcel-local ENU meters** (origin at southwest of the DEM bbox), not state-plane feet and not WGS84 lon/lat. A typical small parcel is only tens of meters across — after Link CAD, use **Zoom to Fit** / **Zoom All** or the contours look “missing” next to a large aerial site.

## Revit (recommended)

1. **Re-export** after any emitter fix (`refresh_parcel_terrain_export`) — do not reuse an older download.
2. Prefer **Insert → Link CAD** over Import CAD (Import shows the ActiveX dialog more often).
3. Target a **floor plan or site plan**, not a Drafting View.
4. Link CAD options: units **meters**; uncheck **Current view only** if you want the link in other views.
5. After link: **Zoom to Fit**. Contours sit near the project origin in local meters unless you move/align them to the site.
6. Contours: layer `TERRAIN_CONTOURS`. Mesh faces: layer `TERRAIN` (3DFACE is a surface mesh; for topo lines prefer `dxf-contour`).

If Link CAD still fails: open the DXF in AutoCAD / TrueView → Save As **DWG R2000 or R2013** → Link the DWG.

Do not expect Civil3D proxy / AECC objects — we emit only standard `3DFACE` / `POLYLINE`+`VERTEX`.

## Alternatives in Revit

- **IFC** (`dxf` alternative format `ifc`): triangulated `IfcTriangulatedFaceSet` (georef rigor / `IfcMapConversion` still a logged follow-up).
- **GLB**: mesh preview outside Revit; not a native Revit import path.
