#!/usr/bin/env python3
"""IFC4 terrain sidecar. Receives the already-triangulated mesh on stdin."""
import json
import sys
import uuid

try:
    import ifcopenshell
    import ifcopenshell.guid
    import numpy  # required image dependency parity
except ImportError as exc:
    print(json.dumps({"status": "error", "message": "missing IFC dependencies: %s" % exc}))
    sys.exit(0)


def guid():
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def positions_to_coord_list(positions):
    """Flat [x,y,z,...] -> list[[x,y,z], ...] of native floats for ifcopenshell 0.8."""
    if len(positions) % 3 != 0:
        raise ValueError("positions length %s is not a multiple of 3" % len(positions))
    # ifcopenshell 0.8.x rejects tuple-of-tuple and some list-of-tuple shapes for
    # AGGREGATE OF AGGREGATE OF DOUBLE; list-of-list of float is accepted.
    return [
        [float(positions[i]), float(positions[i + 1]), float(positions[i + 2])]
        for i in range(0, len(positions), 3)
    ]


def indices_to_faces(indices):
    if len(indices) % 3 != 0:
        raise ValueError("indices length %s is not a multiple of 3" % len(indices))
    return [
        [int(indices[i]) + 1, int(indices[i + 1]) + 1, int(indices[i + 2]) + 1]
        for i in range(0, len(indices), 3)
    ]


def main():
    request = json.load(sys.stdin)
    positions, indices = request["positions"], request["indices"]
    points = positions_to_coord_list(positions)
    faces = indices_to_faces(indices)
    if any(i < 1 or i > len(points) for face in faces for i in face):
        raise ValueError("triangle index out of range")
    f = ifcopenshell.file(schema="IFC4")
    units = f.create_entity("IfcUnitAssignment", Units=[
        f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    ])
    context = f.create_entity("IfcGeometricRepresentationContext",
        ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-5,
        WorldCoordinateSystem=f.create_entity("IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0., 0., 0.))))
    body = f.create_entity("IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body", ContextType="Model", ParentContext=context, TargetView="MODEL_VIEW")
    f.create_entity("IfcProject", GlobalId=guid(), Name="Parcel terrain",
        RepresentationContexts=[context], UnitsInContext=units)
    point_list = f.create_entity("IfcCartesianPointList3D", CoordList=points)
    face_set = f.create_entity("IfcTriangulatedFaceSet", Coordinates=point_list, CoordIndex=faces, Closed=False)
    representation = f.create_entity("IfcShapeRepresentation", ContextOfItems=body,
        RepresentationIdentifier="Body", RepresentationType="Tessellation", Items=[face_set])
    shape = f.create_entity("IfcProductDefinitionShape", Representations=[representation])
    f.create_entity("IfcGeographicElement", GlobalId=guid(), Name="Terrain surface",
        PredefinedType="TERRAIN", Representation=shape)
    # Named CRS only: no invalid degree-as-metre IfcMapConversion.
    f.create_entity("IfcProjectedCRS", Name="EPSG:4326", GeodeticDatum="WGS84",
        Description="Named WGS84 origin; local mesh coordinates are ENU metres.")
    print(json.dumps({"status": "ok", "ifcText": f.wrapped_data.to_string(),
        "vertexCount": len(points), "triangleCount": len(faces)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
