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


SITE_PLAN_LAYERS = [
    ("PROPERTY_LINE", 7),
    ("DIMENSION", 2),
    ("SETBACK", 1),
    ("CONTOUR", 3),
    ("ELEVATION_LABEL", 3),
    ("STREET", 6),
    ("NORTH", 5),
]


def _tag(entity, citation) -> None:
    """Attaches a source-atom citation as DXF XDATA (group 1000) under a
    registered HAUSKA appid — this is how "entity metadata cites source
    atoms" (WDLL item 3/6) survives into the actual DXF file, not just this
    worker's JSON response."""
    if not citation:
        return
    entity.set_xdata("HAUSKA", [(1000, str(citation)[:255])])


def emit_site_plan(request: dict) -> dict:
    vertical_datum = _vertical_datum(request)
    doc = _new_doc(vertical_datum)
    doc.appids.new("HAUSKA")
    for name, color in SITE_PLAN_LAYERS:
        _ensure_layer(doc, name, color=color)
    msp = doc.modelspace()
    entity_count = 0

    def pt3(p, z=None):
        return (float(p[0]), float(p[1]), float(p[2]) if z is None else float(z))

    grade_z = float(request.get("gradeZ", 0.0))

    property_line = request.get("propertyLine") or {}
    pl_points = property_line.get("points") or []
    if len(pl_points) >= 3:
        pts = [pt3(p, grade_z) for p in pl_points]
        entity = msp.add_polyline3d(pts, close=True, dxfattribs={"layer": "PROPERTY_LINE"})
        _tag(entity, property_line.get("citation"))
        entity_count += 1
        for p in pts:
            marker = msp.add_point(p, dxfattribs={"layer": "PROPERTY_LINE"})
            _tag(marker, property_line.get("citation"))
            entity_count += 1

    for dim in request.get("dimensions") or []:
        mid = pt3(dim["midpoint"], grade_z)
        text = msp.add_text(
            "%.1f ft" % float(dim["lengthFeet"]),
            dxfattribs={"layer": "DIMENSION", "height": max(0.2, float(request.get("textHeight", 0.5)))},
        )
        text.set_placement(mid)
        _tag(text, dim.get("citation"))
        entity_count += 1

    setback = request.get("setback") or {}
    offset_points = setback.get("offsetPoints")
    if offset_points and len(offset_points) >= 3:
        pts = [pt3(p, grade_z) for p in offset_points]
        entity = msp.add_polyline3d(pts, close=True, dxfattribs={"layer": "SETBACK"})
        _tag(entity, setback.get("citation"))
        entity_count += 1
        for seg in setback.get("segments") or []:
            mid = pt3(seg["midpoint"], grade_z)
            label = "%s %.0f ft" % (str(seg.get("role", "setback")).upper(), float(seg["distanceFt"]))
            text = msp.add_text(label, dxfattribs={"layer": "SETBACK", "height": max(0.2, float(request.get("textHeight", 0.5)))})
            text.set_placement(mid)
            _tag(text, seg.get("citation"))
            entity_count += 1
    elif setback.get("degenerate"):
        origin = property_line.get("points") or [[0, 0, grade_z]]
        text = msp.add_text(
            "SETBACK: %s" % str(setback.get("degenerateReason") or "no honest buildable margin"),
            dxfattribs={"layer": "SETBACK", "height": max(0.2, float(request.get("textHeight", 0.5)))},
        )
        text.set_placement(pt3(origin[0], grade_z))
        entity_count += 1

    for contour in request.get("contours") or []:
        points_2d = contour.get("points") or []
        if len(points_2d) < 2:
            continue
        elevation = float(contour["elevation"])
        pts = [(float(p[0]), float(p[1]), elevation) for p in points_2d]
        if len(pts) > 2 and pts[0][:2] == pts[-1][:2]:
            pts = pts[:-1]
        if len(pts) < 2:
            continue
        entity = msp.add_polyline3d(pts, close=True, dxfattribs={"layer": "CONTOUR"})
        _tag(entity, contour.get("citation"))
        entity_count += 1

    for label in request.get("elevationLabels") or []:
        p = pt3(label["point"], label["point"][2] if len(label["point"]) > 2 else label.get("elevationMeters"))
        text = msp.add_text(
            "%.2f m %s" % (float(label["elevationMeters"]), vertical_datum.get("name", "NAVD88")),
            dxfattribs={"layer": "ELEVATION_LABEL", "height": max(0.2, float(request.get("textHeight", 0.5)))},
        )
        text.set_placement(p)
        _tag(text, label.get("citation"))
        entity_count += 1

    street = request.get("street") or {}
    for anchor in street.get("anchors") or []:
        points_2d = anchor.get("points") or []
        if len(points_2d) < 2:
            continue
        pts = [pt3(p, grade_z) for p in points_2d]
        entity = msp.add_polyline3d(pts, close=False, dxfattribs={"layer": "STREET"})
        _tag(entity, anchor.get("citation") or anchor.get("name"))
        entity_count += 1
        text = msp.add_text(str(anchor.get("name", "")), dxfattribs={"layer": "STREET", "height": max(0.2, float(request.get("textHeight", 0.5)))})
        text.set_placement(pts[0])
        entity_count += 1
    # Honest absence: STREET layer above is always created via SITE_PLAN_LAYERS
    # even with zero entities when street.honestAbsence is true — no
    # fabricated road geometry is drawn.

    north = request.get("north") or {}
    if north.get("origin"):
        ox, oy = float(north["origin"][0]), float(north["origin"][1])
        length = float(north.get("lengthMeters", 5.0))
        dx, dy = north.get("direction", [0, 1])
        dx, dy = float(dx), float(dy)
        tip = (ox + dx * length, oy + dy * length, grade_z)
        base = (ox, oy, grade_z)
        # simple arrow: shaft + two barbs
        left = (tip[0] - dx * length * 0.25 - dy * length * 0.15, tip[1] - dy * length * 0.25 + dx * length * 0.15, grade_z)
        right = (tip[0] - dx * length * 0.25 + dy * length * 0.15, tip[1] - dy * length * 0.25 - dx * length * 0.15, grade_z)
        entity = msp.add_polyline3d([base, tip, left, tip, right], close=False, dxfattribs={"layer": "NORTH"})
        entity_count += 1
        text = msp.add_text("N", dxfattribs={"layer": "NORTH", "height": max(0.2, float(request.get("textHeight", 0.5)))})
        text.set_placement(tip)
        entity_count += 1

    scale_bar = request.get("scaleBar") or {}
    if scale_bar.get("origin") and scale_bar.get("lengthMeters"):
        sx, sy = float(scale_bar["origin"][0]), float(scale_bar["origin"][1])
        bar_len = float(scale_bar["lengthMeters"])
        entity = msp.add_polyline3d(
            [(sx, sy, grade_z), (sx + bar_len, sy, grade_z)], close=False, dxfattribs={"layer": "NORTH"},
        )
        entity_count += 1
        text = msp.add_text(
            "%.0f m" % bar_len, dxfattribs={"layer": "NORTH", "height": max(0.2, float(request.get("textHeight", 0.5)))},
        )
        text.set_placement((sx, sy + bar_len * 0.1, grade_z))
        entity_count += 1

    return _finalize(doc, entity_count, "site_plan", vertical_datum)


def main() -> None:
    request = json.load(sys.stdin)
    kind = request.get("kind")
    if kind == "contours":
        print(json.dumps(emit_contours(request)))
    elif kind == "3dface":
        print(json.dumps(emit_3dface(request)))
    elif kind == "site_plan":
        print(json.dumps(emit_site_plan(request)))
    else:
        print(json.dumps({"status": "error", "message": "unknown kind: %s" % kind}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
