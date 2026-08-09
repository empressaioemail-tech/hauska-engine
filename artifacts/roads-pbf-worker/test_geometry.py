#!/usr/bin/env python3
"""Stdlib-only geometry tests for roads-pbf-worker (no osmium required)."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "extract_highways", ROOT / "extract_highways.py"
)
mod = importlib.util.module_from_spec(spec)
# Avoid importing osmium by loading only after stub — extract imports osmium at top.
# Instead, copy the pure helpers under test by exec of selected source segments.
SRC = (ROOT / "extract_highways.py").read_text(encoding="utf-8")
# Split at osmium import and inject a stub.
stubbed = SRC.replace("import osmium\n", "class osmium:\n    class SimpleHandler: pass\n")
ns: dict = {}
exec(compile(stubbed, str(ROOT / "extract_highways.py"), "exec"), ns)


class GeometryTests(unittest.TestCase):
    def test_even_odd_inside(self):
        ring = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0), (0.0, 0.0)]
        self.assertTrue(ns["point_in_ring"](1.0, 1.0, ring))
        self.assertFalse(ns["point_in_ring"](3.0, 3.0, ring))

    def test_segment_cross_detects_boundary_run(self):
        # Horizontal way along southern edge of unit square.
        coords = [(0.5, 0.0), (1.5, 0.0)]
        polys = [[[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0), (0.0, 0.0)]]]
        # Vertices sit on edge: even-odd may place them outside; segment-cross must hit.
        hits = ns["resolve_county_hits"](
            coords,
            [
                {
                    "countyFips": "48021",
                    "countyName": "Bastrop County",
                    "polys": polys,
                    "bbox": (0.0, 0.0, 2.0, 2.0),
                }
            ],
        )
        self.assertEqual(len(hits), 1)
        self.assertIn(hits[0]["basis"], ("vertex-inside", "midpoint-inside", "segment-crosses-boundary"))

    def test_every_edge_not_stepped(self):
        # Way crosses a middle edge that stepped j+=2 would skip.
        # Ring vertices 0..4; edge 1→2 is the middle vertical at x=1 from y=0 to y=1.
        ring = [
            (0.0, 0.0),
            (1.0, 0.0),
            (1.0, 1.0),
            (2.0, 1.0),
            (2.0, 2.0),
            (0.0, 2.0),
            (0.0, 0.0),
        ]
        # Horizontal segment crossing ring edge (1,0)-(1,1) at (1, 0.5).
        coords = [(0.5, 0.5), (1.5, 0.5)]
        polys = [[ring]]
        self.assertTrue(ns["way_crosses_outer_rings"](coords, polys))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(GeometryTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
