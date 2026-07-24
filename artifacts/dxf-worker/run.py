#!/usr/bin/env python3
"""R2000 DXF sidecar for parcel terrain. Emits Revit-importable AC1015 files.

Hand-rolled ENTITIES-only / partial-TABLES DXF opens in AutoCAD (which repairs
on save) but fails Revit Link/Import CAD with the ActiveX / proprietary dialog.
ezdxf writes the full R2000 graph: handles (group 5), BLOCK_RECORD for
*Model_Space/*Paper_Space, OBJECTS/LAYOUT dictionaries, LTYPE, LAYER.
"""
from __future__ import annotations

import json
import sys
from io import StringIO

try:
    import ezdxf
    from ezdxf import units
except ImportError as exc:
    print(json.dumps({"status": "error", "message": "missing DXF dependencies: %s" % exc}))
    sys.exit(0)


def _ensure_layer(doc, name: str, color: int = 3) -> None:
    if name not in doc.layers:
        doc.layers.add(name, color=color)


def _new_doc() -> "ezdxf.document.Drawing":
    # setup=False keeps the file smaller while still emitting handles,
    # BLOCK_RECORD, OBJECTS, and LAYOUT — the pieces Revit requires.
    doc = ezdxf.new("R2000", setup=False)
    doc.units = units.M
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    return doc


def emit_contours(request: dict) -> dict:
    layer = request.get("layer") or "TERRAIN_CONTOURS"
    polylines = request.get("polylines") or []
    doc = _new_doc()
    _ensure_layer(doc, layer)
    msp = doc.modelspace()
    entity_count = 0
    for poly in polylines:
        elevation = float(poly["elevation"])
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
    stream = StringIO()
    doc.write(stream)
    return {
        "status": "ok",
        "dxfText": stream.getvalue(),
        "entityCount": entity_count,
        "kind": "contours",
    }


def emit_3dface(request: dict) -> dict:
    layer = request.get("layer") or "TERRAIN"
    positions = request["positions"]
    indices = request["indices"]
    if len(positions) % 3 != 0:
        raise ValueError("positions length %s is not a multiple of 3" % len(positions))
    if len(indices) % 3 != 0:
        raise ValueError("indices length %s is not a multiple of 3" % len(indices))
    doc = _new_doc()
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
    stream = StringIO()
    doc.write(stream)
    return {
        "status": "ok",
        "dxfText": stream.getvalue(),
        "entityCount": entity_count,
        "kind": "3dface",
    }


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
