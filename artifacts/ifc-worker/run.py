#!/usr/bin/env python3
"""IFC4 terrain sidecar — complete spatial model, not a floating mesh.

Revit (and any IFC importer that walks Project → Site → element) requires:
  IfcProject
    -IfcRelAggregates→ IfcSite  (georef lives here)
      -IfcRelContainedInSpatialStructure→ IfcGeographicElement
        with IfcLocalPlacement

A bare IfcGeographicElement under an empty Project is unreachable → Elements Lost.
"""
from __future__ import annotations

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


def to_compound_plane_angle(decimal_degrees: float):
    """IfcCompoundPlaneAngleMeasure: (degrees, minutes, seconds, millionths)."""
    sign = 1 if decimal_degrees >= 0 else -1
    abs_deg = abs(float(decimal_degrees))
    degrees = int(abs_deg)
    minutes_f = (abs_deg - degrees) * 60.0
    minutes = int(minutes_f)
    seconds_f = (minutes_f - minutes) * 60.0
    seconds = int(seconds_f)
    millionths = int(round((seconds_f - seconds) * 1_000_000))
    if millionths == 1_000_000:
        seconds += 1
        millionths = 0
    return (sign * degrees, minutes, seconds, millionths)


def identity_placement(f, relative_to=None):
    axis = f.create_entity(
        "IfcAxis2Placement3D",
        Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
    )
    return f.create_entity("IfcLocalPlacement", PlacementRelTo=relative_to, RelativePlacement=axis)


def assert_complete_spatial_model(f) -> dict:
    """Fail closed: empty Project tree or unplaced terrain must not ship."""
    projects = list(f.by_type("IfcProject"))
    sites = list(f.by_type("IfcSite"))
    aggregates = list(f.by_type("IfcRelAggregates"))
    contained = list(f.by_type("IfcRelContainedInSpatialStructure"))
    placements = list(f.by_type("IfcLocalPlacement"))
    elements = list(f.by_type("IfcGeographicElement"))
    map_conversions = list(f.by_type("IfcMapConversion"))
    projected = list(f.by_type("IfcProjectedCRS"))

    errors = []
    if len(projects) != 1:
        errors.append("expected exactly one IfcProject, got %s" % len(projects))
    if len(sites) < 1:
        errors.append("IfcSite missing")
    if len(elements) < 1:
        errors.append("IfcGeographicElement missing")
    if len(aggregates) < 1:
        errors.append("IfcRelAggregates missing (Project aggregates nothing)")
    if len(contained) < 1:
        errors.append("IfcRelContainedInSpatialStructure missing")
    if len(placements) < 1:
        errors.append("IfcLocalPlacement missing")
    if len(map_conversions) < 1:
        errors.append("IfcMapConversion missing")
    if len(projected) < 1:
        errors.append("IfcProjectedCRS missing")
    vertical_ok = bool(projected and getattr(projected[0], "VerticalDatum", None))
    if projected and not vertical_ok:
        errors.append("IfcProjectedCRS.VerticalDatum missing (expected NAVD88)")


    project_aggregates_site = False
    for rel in aggregates:
        if rel.RelatingObject in projects and any(s in (rel.RelatedObjects or []) for s in sites):
            project_aggregates_site = True
            break
    if sites and projects and not project_aggregates_site:
        errors.append("IfcProject does not aggregate IfcSite")

    site_contains_element = False
    for rel in contained:
        if rel.RelatingStructure in sites and any(e in (rel.RelatedElements or []) for e in elements):
            site_contains_element = True
            break
    if sites and elements and not site_contains_element:
        errors.append("IfcSite does not contain terrain element")

    element_placed = bool(elements and elements[0].ObjectPlacement is not None)
    if elements and not element_placed:
        errors.append("terrain IfcGeographicElement has no ObjectPlacement")

    site_placed = bool(sites and sites[0].ObjectPlacement is not None)
    if sites and not site_placed:
        errors.append("IfcSite has no ObjectPlacement")

    report = {
        "IfcProject": len(projects),
        "IfcSite": len(sites),
        "IfcRelAggregates": len(aggregates),
        "IfcRelContainedInSpatialStructure": len(contained),
        "IfcLocalPlacement": len(placements),
        "IfcGeographicElement": len(elements),
        "IfcMapConversion": len(map_conversions),
        "IfcProjectedCRS": len(projected),
        "verticalDatum": getattr(projected[0], "VerticalDatum", None) if projected else None,
        "projectAggregatesSite": project_aggregates_site,
        "siteContainsElement": site_contains_element,
        "elementHasPlacement": element_placed,
        "siteHasPlacement": site_placed,
        "ok": not errors,
        "errors": errors,
    }

    if errors:
        raise ValueError("incomplete IFC spatial model: " + "; ".join(errors))
    return report


def main():
    request = json.load(sys.stdin)
    positions, indices = request["positions"], request["indices"]
    georef = request.get("georefOrigin") or {}
    origin_lng = float(georef.get("originLng", 0.0))
    origin_lat = float(georef.get("originLat", 0.0))
    crs_convention = request.get("crsConvention") or "local-enu-meters:origin-bbox-sw"
    provenance = request.get("provenance") or {}
    source_citation = provenance.get("sourceCitation") or "USGS 3DEP"

    points = positions_to_coord_list(positions)
    faces = indices_to_faces(indices)
    if any(i < 1 or i > len(points) for face in faces for i in face):
        raise ValueError("triangle index out of range")

    f = ifcopenshell.file(schema="IFC4")

    length_unit = f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    units = f.create_entity("IfcUnitAssignment", Units=[length_unit])

    world_origin = f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    world_placement = f.create_entity("IfcAxis2Placement3D", Location=world_origin)
    context = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=world_placement,
    )
    body = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body",
        ContextType="Model",
        ParentContext=context,
        TargetView="MODEL_VIEW",
    )

    project = f.create_entity(
        "IfcProject",
        GlobalId=guid(),
        Name="Parcel terrain",
        Description="USGS 3DEP parcel terrain export (%s)" % source_citation,
        RepresentationContexts=[context],
        UnitsInContext=units,
    )

    vertical_datum = (request.get("verticalDatum") or {}).get("name") or "NAVD88"
    vertical_kind = (request.get("verticalDatum") or {}).get("kind") or "orthometric"
    # Target CRS + map conversion: local ENU metres with known WGS84 SW origin.
    # Eastings/Northings are metres in the engineering/map frame (origin = 0,0);
    # geographic origin is carried on IfcSite RefLongitude/RefLatitude.
    # Z is USGS 3DEP orthometric height on NAVD88 (not ellipsoidal).
    projected_crs = f.create_entity(
        "IfcProjectedCRS",
        Name="local-ENU-metres",
        Description=(
            "%s; origin WGS84 lon=%s lat=%s (bbox SW); "
            "mesh XYZ are east/north/up metres from that origin; "
            "Z=%s %s metres (USGS 3DEP)"
            % (crs_convention, origin_lng, origin_lat, vertical_datum, vertical_kind)
        ),
        GeodeticDatum="WGS84",
        VerticalDatum=vertical_datum,
        MapUnit=length_unit,
    )
    f.create_entity(
        "IfcMapConversion",
        SourceCRS=context,
        TargetCRS=projected_crs,
        Eastings=0.0,
        Northings=0.0,
        OrthogonalHeight=0.0,
        XAxisAbscissa=1.0,
        XAxisOrdinate=0.0,
        Scale=1.0,
    )

    site_placement = identity_placement(f)
    site = f.create_entity(
        "IfcSite",
        GlobalId=guid(),
        Name="Parcel site",
        Description=(
            "Terrain site; georeferenced at DEM bbox southwest origin; "
            "elevations are %s %s metres (USGS 3DEP)"
            % (vertical_datum, vertical_kind)
        ),
        ObjectPlacement=site_placement,
        CompositionType="ELEMENT",
        RefLatitude=to_compound_plane_angle(origin_lat),
        RefLongitude=to_compound_plane_angle(origin_lng),
        RefElevation=0.0,
    )

    f.create_entity(
        "IfcRelAggregates",
        GlobalId=guid(),
        RelatingObject=project,
        RelatedObjects=[site],
    )

    point_list = f.create_entity("IfcCartesianPointList3D", CoordList=points)
    face_set = f.create_entity(
        "IfcTriangulatedFaceSet",
        Coordinates=point_list,
        CoordIndex=faces,
        Closed=False,
    )
    representation = f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=body,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation",
        Items=[face_set],
    )
    shape = f.create_entity("IfcProductDefinitionShape", Representations=[representation])

    element_placement = identity_placement(f, relative_to=site_placement)
    terrain = f.create_entity(
        "IfcGeographicElement",
        GlobalId=guid(),
        Name="Terrain surface",
        Description=source_citation,
        ObjectPlacement=element_placement,
        Representation=shape,
        PredefinedType="TERRAIN",
    )

    f.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=guid(),
        RelatingStructure=site,
        RelatedElements=[terrain],
    )

    spatial = assert_complete_spatial_model(f)

    print(
        json.dumps(
            {
                "status": "ok",
                "ifcText": f.wrapped_data.to_string(),
                "vertexCount": len(points),
                "triangleCount": len(faces),
                "spatialValidation": spatial,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}))
