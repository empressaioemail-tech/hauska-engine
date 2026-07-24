#!/usr/bin/env python3
"""Assert an IFC file has a non-empty, placed Project→Site→element tree.

Exit 0 + JSON report on success; exit 1 + JSON errors on failure.
Usage: python validate_spatial.py path/to/file.ifc
"""
from __future__ import annotations

import json
import sys

import ifcopenshell

# Reuse the same rules as run.py (duplicated lightly so this script is standalone).
REQUIRED = {
    "IfcProject": 1,
    "IfcSite": 1,
    "IfcRelAggregates": 1,
    "IfcRelContainedInSpatialStructure": 1,
    "IfcLocalPlacement": 1,
    "IfcGeographicElement": 1,
    "IfcMapConversion": 1,
}


def validate(path: str) -> dict:
    f = ifcopenshell.open(path)
    counts = {k: len(f.by_type(k)) for k in [
        "IfcProject", "IfcSite", "IfcRelAggregates", "IfcRelContainedInSpatialStructure",
        "IfcLocalPlacement", "IfcGeographicElement", "IfcMapConversion", "IfcProjectedCRS",
        "IfcTriangulatedFaceSet",
    ]}
    projects = list(f.by_type("IfcProject"))
    sites = list(f.by_type("IfcSite"))
    elements = list(f.by_type("IfcGeographicElement"))
    aggregates = list(f.by_type("IfcRelAggregates"))
    contained = list(f.by_type("IfcRelContainedInSpatialStructure"))

    errors = []
    for key, minimum in REQUIRED.items():
        if counts.get(key, 0) < minimum:
            errors.append("%s count %s < %s" % (key, counts.get(key, 0), minimum))

    project_aggregates_site = any(
        rel.RelatingObject in projects and any(s in (rel.RelatedObjects or []) for s in sites)
        for rel in aggregates
    )
    site_contains_element = any(
        rel.RelatingStructure in sites and any(e in (rel.RelatedElements or []) for e in elements)
        for rel in contained
    )
    element_placed = bool(elements and elements[0].ObjectPlacement is not None)
    site_placed = bool(sites and sites[0].ObjectPlacement is not None)
    projected = list(f.by_type("IfcProjectedCRS"))
    vertical_datum = getattr(projected[0], "VerticalDatum", None) if projected else None

    if sites and projects and not project_aggregates_site:
        errors.append("IfcProject does not aggregate IfcSite")
    if sites and elements and not site_contains_element:
        errors.append("IfcSite does not contain terrain element")
    if elements and not element_placed:
        errors.append("terrain element unplaced")
    if sites and not site_placed:
        errors.append("IfcSite unplaced")
    if not vertical_datum:
        errors.append("IfcProjectedCRS.VerticalDatum missing (expected NAVD88)")

    return {
        "path": path,
        "counts": counts,
        "verticalDatum": vertical_datum,
        "projectAggregatesSite": project_aggregates_site,
        "siteContainsElement": site_contains_element,
        "elementHasPlacement": element_placed,
        "siteHasPlacement": site_placed,
        "ok": not errors,
        "errors": errors,
    }



if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "errors": ["usage: validate_spatial.py <file.ifc>"]}))
        sys.exit(2)
    report = validate(sys.argv[1])
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)
