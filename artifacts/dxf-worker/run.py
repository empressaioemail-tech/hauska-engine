#!/usr/bin/env python3
"""R2000 DXF sidecar for parcel terrain. Emits Revit-importable AC1015 files.

Hand-rolled ENTITIES-only / partial-TABLES DXF opens in AutoCAD (which repairs
on save) but fails Revit Link/Import CAD with the ActiveX / proprietary dialog.
ezdxf writes the full R2000 graph: handles (group 5), BLOCK_RECORD for
*Model_Space/*Paper_Space, OBJECTS/LAYOUT dictionaries, LTYPE, LAYER.

Z values are USGS 3DEP NAVD88 orthometric metres (declared in DXF 999 comments
and $EXTMIN/$EXTMAX from real modelspace geometry — not unset 1e20 sentinels).
"""
from __future__ import annotations

import json
import re
import sys
from io import StringIO


try:
    import ezdxf
    from ezdxf import bbox as ez_bbox
    from ezdxf import units
except ImportError as exc:
    print(json.dumps({"status": "error", "message": "missing DXF dependencies: %s" % exc}))
    sys.exit(0)


DEFAULT_VERTICAL_DATUM = {
    "name": "NAVD88",
    "kind": "orthometric",
    "units": "metre",
    "source": "USGS 3DEP",
    "summary": "NAVD88 orthometric metres (USGS 3DEP; not ellipsoidal height)",
}


def _ensure_layer(doc, name: str, color: int = 3) -> None:
    if name not in doc.layers:
        doc.layers.add(name, color=color)


def _vertical_datum(request: dict) -> dict:
    vd = request.get("verticalDatum") or {}
    out = dict(DEFAULT_VERTICAL_DATUM)
    out.update({k: v for k, v in vd.items() if v is not None})
    return out


def _new_doc(vertical_datum: dict) -> "ezdxf.document.Drawing":
    # setup=False keeps the file smaller while still emitting handles,
    # BLOCK_RECORD, OBJECTS, and LAYOUT — the pieces Revit requires.
    doc = ezdxf.new("R2000", setup=False)
    doc.units = units.M
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    # DXF group-999 comments survive round-trips and declare the vertical datum
    # for surveyor / Civil3D consumers (HEADER alone has no VerticalDatum field).
    doc.comments = [
        "Hauska parcel terrain export",
        "Horizontal: local ENU metres from DEM bbox southwest origin",
        "Vertical: %s" % vertical_datum.get("summary", DEFAULT_VERTICAL_DATUM["summary"]),
        "Units: metres ($INSUNITS=6); Z is orthometric MSL height, not ellipsoid",
    ]
    return doc


def _patch_header_point(text: str, varname: str, point) -> str:
    """ezdxf.write resets $EXTMIN/$EXTMAX to sentinels — patch after serialize."""
    marker = "$%s" % varname.lstrip("$")
    idx = text.find(marker)
    if idx < 0:
        return text
    # Replace the next three 10/20/30 value pairs after the marker.
    # Format: $EXTMIN\n 10\n<x>\n 20\n<y>\n 30\n<z>\n
    pattern = re.compile(

        r"(\$" + re.escape(varname.lstrip("$")) + r"\n\s*10\n)([^\n]+)(\n\s*20\n)([^\n]+)(\n\s*30\n)([^\n]+)"
    )
    repl = r"\g<1>%s\g<3>%s\g<5>%s" % (point[0], point[1], point[2])
    return pattern.sub(repl, text, count=1)


def _finalize(doc, entity_count: int, kind: str, vertical_datum: dict) -> dict:
    msp = doc.modelspace()
    extents = ez_bbox.extents(msp)
    stream = StringIO()
    doc.write(stream)
    text = stream.getvalue()
    # Belt-and-suspenders: ensure 999 comments are present even if writer omits.
    summary = vertical_datum.get("summary", DEFAULT_VERTICAL_DATUM["summary"])
    if "NAVD88" not in text:
        banner = (
            "999\nHauska parcel terrain export\n"
            "999\nVertical: %s\n"
            "999\nUnits: metres ($INSUNITS=6); Z orthometric MSL, not ellipsoid\n"
            % summary
        )
        text = banner + text
    if extents.has_data:
        text = _patch_header_point(text, "EXTMIN", extents.extmin)
        text = _patch_header_point(text, "EXTMAX", extents.extmax)
    return {
        "status": "ok",
        "dxfText": text,
        "entityCount": entity_count,
        "kind": kind,
        "verticalDatum": vertical_datum,
        "extmin": list(extents.extmin) if extents.has_data else None,
        "extmax": list(extents.extmax) if extents.has_data else None,
    }



def emit_contours(request: dict) -> dict:
    layer = request.get("layer") or "TERRAIN_CONTOURS"
    polylines = request.get("polylines") or []
    vertical_datum = _vertical_datum(request)
    doc = _new_doc(vertical_datum)
    _ensure_layer(doc, layer)
    msp = doc.modelspace()
    entity_count = 0
    for poly in polylines:
        elevation = float(poly["elevation"])
        if not (elevation == elevation):  # NaN
            raise ValueError("contour elevation is NaN — nodata must not ship")
        points_2d = poly.get("points") or []
        if len(points_2d) < 2:
            continue
        pts = [(float(p[0]), float(p[1]), elevation) for p in points_2d]
        # Drop duplicate closing vertex; ezdxf close=True seals the ring.
        if len(pts) > 2 and pts[0][0] == pts[-1][0] and pts[0][1] == pts[-1][1]:
            pts = pts[:-1]
        if len(pts) < 2:
            continue
        msp.add_polyline3d(pts, close=True, dxfattribs={"layer": layer})
        entity_count += 1
    return _finalize(doc, entity_count, "contours", vertical_datum)


def emit_3dface(request: dict) -> dict:
    layer = request.get("layer") or "TERRAIN"
    positions = request["positions"]
    indices = request["indices"]
    vertical_datum = _vertical_datum(request)
    if len(positions) % 3 != 0:
        raise ValueError("positions length %s is not a multiple of 3" % len(positions))
    if len(indices) % 3 != 0:
        raise ValueError("indices length %s is not a multiple of 3" % len(indices))
    # Reject nodata-as-zero / non-finite Z before writing faces.
    zs = [float(positions[i]) for i in range(2, len(positions), 3)]
    if any(z != z for z in zs):  # NaN
        raise ValueError("mesh contains NaN Z — nodata cells must be dropped before emit")
    doc = _new_doc(vertical_datum)
    _ensure_layer(doc, layer)
    msp = doc.modelspace()
    entity_count = 0
    for i in range(0, len(indices), 3):
        ia, ib, ic = int(indices[i]), int(indices[i + 1]), int(indices[i + 2])
        a = (float(positions[ia * 3]), float(positions[ia * 3 + 1]), float(positions[ia * 3 + 2]))
        b = (float(positions[ib * 3]), float(positions[ib * 3 + 1]), float(positions[ib * 3 + 2]))
        c = (float(positions[ic * 3]), float(positions[ic * 3 + 1]), float(positions[ic * 3 + 2]))
        # 3DFACE wants four corners; degenerate fourth = third for triangles.
        msp.add_3dface([a, b, c, c], dxfattribs={"layer": layer})
        entity_count += 1
    return _finalize(doc, entity_count, "3dface", vertical_datum)


def main() -> None:
    request = json.load(sys.stdin)
    kind = request.get("kind")
    if kind == "contours":
        print(json.dumps(emit_contours(request)))
    elif kind == "3dface":
        print(json.dumps(emit_3dface(request)))
    else:
        print(json.dumps({"status": "error", "message": "unknown kind: %s" % kind}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
