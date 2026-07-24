# Terrain DXF — CAD / Revit import notes

Formats: `dxf-3dface` (triangle surface) and `dxf-contour` (constant-Z polylines).
Both share one triangulation / DEM; LandXML TIN remains deferred.

## File shape

Each DXF includes:

- `HEADER`: `$ACADVER=AC1015` (AutoCAD 2000), `$INSUNITS=6` (meters), `$MEASUREMENT=1` (metric)
- `TABLES` / `LAYER`: `TERRAIN` or `TERRAIN_CONTOURS`
- `ENTITIES`: `3DFACE` or closed `LWPOLYLINE` (elevation via group 38)
- `EOF`

Coordinates are **parcel-local ENU meters** (origin at southwest of the DEM bbox), not state-plane feet and not WGS84 lon/lat.

## Revit (recommended)

1. Export again after the HEADER fix (refresh_parcel_terrain_export) so the download is not a cached bare ENTITIES file.
2. Use **Insert → Link CAD** (prefer Link over Import).
3. Target a **floor plan or site plan**, not a Drafting View.
4. Units: **meters** (or scale after link if the project is imperial).
5. Contours: layer `TERRAIN_CONTOURS`. Mesh faces: layer `TERRAIN`.

If Link CAD still fails, open the DXF in AutoCAD / TrueView, Save As DWG R2010/R2013, then Link the DWG.

Do not expect Civil3D proxy / AECC objects — we emit only standard `3DFACE` / `LWPOLYLINE`.

## Alternatives in Revit

- **IFC** (`dxf` alternative format `ifc`): triangulated `IfcTriangulatedFaceSet` (georef rigor / `IfcMapConversion` still a logged follow-up).
- **GLB**: mesh preview outside Revit; not a native Revit import path.
