"""
Parity + correctness tests for `mask_regions.py`.

Runs with the standard library only (no pysheds, no rasterio) so it is
executable anywhere the worker source lives:

    python artifacts/hydrology-worker/test_mask_regions.py

Exits non-zero on failure.

THE EXPECTED AREAS BELOW ARE THE TYPESCRIPT NUMBERS. `mask_regions.py` mirrors
`packages/adapters/src/hydrology/maskRegions.ts` cell-for-cell so the pysheds
sidecar and the native-D8 fallback produce the same kind of geometry; these
figures are the parity lock. If a change makes them diverge, the two hydrology
backends have started drawing different pictures.
"""
from __future__ import annotations

import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])

from mask_regions import (  # noqa: E402
    MAX_VERTICES_PER_RING,
    MIN_REGION_AREA_CELLS,
    mask_to_regions,
    regions_to_feature_collection,
    trace_mask_rings,
)

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def close(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol


def reader(width: int, height: int, hit) -> object:
    grid = [[1 if hit(c, r) else 0 for c in range(width)] for r in range(height)]

    def read(col: int, row: int) -> bool:
        return grid[row][col] == 1

    return read


def test_solid_block_dissolves() -> None:
    print("solid 20x20 block dissolves to ONE polygon")
    W = H = 40
    read = reader(W, H, lambda c, r: 10 <= c < 30 and 10 <= r < 30)
    regions = mask_to_regions(read, W, H)
    check("one region", len(regions) == 1, f"got {len(regions)}")
    check("one ring", len(regions[0][0]) == 1)
    # PARITY LOCK with the TypeScript module.
    check("area 399.5 (true 400)", close(regions[0][1], 399.5), f"got {regions[0][1]}")
    # The old emitter at step = 40 // 12 = 3 would have pushed ~49 squares.
    check("far fewer features than cells", len(regions) < 400 / 50)


def test_hole() -> None:
    print("mask with a hole emits an interior ring")
    W = H = 40
    read = reader(
        W,
        H,
        lambda c, r: 8 <= c < 32 and 8 <= r < 32 and not (16 <= c < 24 and 16 <= r < 24),
    )
    regions = mask_to_regions(read, W, H)
    check("one region", len(regions) == 1, f"got {len(regions)}")
    check("shell + hole", len(regions[0][0]) == 2, f"got {len(regions[0][0])} rings")
    # 24^2 - 8^2 = 512 net cells.
    check("net area 511.94", close(regions[0][1], 511.9375, 0.1), f"got {regions[0][1]}")


def test_disjoint_and_speck() -> None:
    print("disjoint regions stay separate; specks are dropped")
    W = H = 60
    read = reader(
        W,
        H,
        lambda c, r: (5 <= c < 15 and 5 <= r < 15) or (40 <= c < 50 and 40 <= r < 50),
    )
    regions = mask_to_regions(read, W, H)
    check("two regions", len(regions) == 2, f"got {len(regions)}")
    check("each ~99.5", all(close(a, 99.5) for _, a in regions), f"got {[a for _, a in regions]}")

    def with_speck(col: int, row: int) -> bool:
        if col == 30 and row == 30:
            return True
        return 5 <= col < 15 and 5 <= row < 15

    speckled = mask_to_regions(with_speck, W, H)
    check("speck dropped", len(speckled) == 1, f"got {len(speckled)}")
    kept = mask_to_regions(with_speck, W, H, min_region_area_cells=1)
    check("speck kept at the delineated floor", len(kept) == 2, f"got {len(kept)}")


def test_disc_is_not_a_lattice() -> None:
    print("a solid disc traces a curve, not axis-aligned squares")
    W = H = 60
    hit = lambda c, r: math.hypot(c - 30, r - 30) < 20  # noqa: E731
    read = reader(W, H, hit)
    true_cells = sum(1 for r in range(H) for c in range(W) if hit(c, r))
    regions = mask_to_regions(read, W, H)
    check("one region", len(regions) == 1)
    ring = regions[0][0][0]
    check("many vertices (a square has 5)", len(ring) > 20, f"got {len(ring)}")
    # PARITY LOCK with the TypeScript module.
    check("area 1244.65", close(regions[0][1], 1244.647, 0.01), f"got {regions[0][1]}")
    check(
        "area honest vs true cell count",
        true_cells * 0.99 < regions[0][1] <= true_cells,
        f"traced {regions[0][1]} vs true {true_cells}",
    )
    # Bbox fill of a disc is pi/4 ~ 0.785; a lattice of squares fills ~1.0.
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    bbox_area = (max(xs) - min(xs)) * (max(ys) - min(ys))
    check("bbox fill reads circular", 0.7 < regions[0][1] / bbox_area < 0.85)
    diagonal = sum(
        1
        for i in range(1, len(ring))
        if abs(ring[i][0] - ring[i - 1][0]) > 1e-9 and abs(ring[i][1] - ring[i - 1][1]) > 1e-9
    )
    check("most edges are not axis-aligned", diagonal > len(ring) / 2, f"got {diagonal}/{len(ring)}")


def test_edge_touching() -> None:
    print("regions touching the grid edge close cleanly")
    W = H = 30
    read = reader(W, H, lambda c, r: r < 10)
    regions = mask_to_regions(read, W, H)
    check("one region", len(regions) == 1)
    check("area 299.5 (true 300)", close(regions[0][1], 299.5), f"got {regions[0][1]}")


def test_honesty_bound() -> None:
    print("no smoothed vertex moves more than one cell from the true boundary")
    W = H = 60
    read = reader(W, H, lambda c, r: c > 10 and r > 10 and c + r < 70)
    true_rings = trace_mask_rings(read, W, H)
    refined = mask_to_regions(read, W, H)
    check("one region", len(refined) == 1)
    true_ring = true_rings[0][0]

    def dist_to_true(p):
        best = float("inf")
        for i in range(1, len(true_ring)):
            a, b = true_ring[i - 1], true_ring[i]
            dx, dy = b[0] - a[0], b[1] - a[1]
            len2 = dx * dx + dy * dy
            t = 0.0 if len2 == 0 else ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
            t = max(0.0, min(1.0, t))
            best = min(best, math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)))
        return best

    worst = max(dist_to_true(p) for p in refined[0][0][0])
    check("within the documented 1-cell tolerance", worst <= 1.0, f"worst {worst}")


def test_no_dilation() -> None:
    print("smoothing never dilates beyond the mask")
    W = H = 40
    read = reader(W, H, lambda c, r: 10 <= c < 30 and 10 <= r < 30)
    regions = mask_to_regions(read, W, H)
    inside = all(10 <= p[0] <= 30 and 10 <= p[1] <= 30 for p in regions[0][0][0])
    check("every vertex inside the mask extent", inside)
    check("area never exceeds the true cell count", regions[0][1] <= 400)


def test_caps() -> None:
    print("feature and vertex caps hold")
    W = H = 200
    read = reader(W, H, lambda c, r: c % 8 < 4 and r % 8 < 4)
    regions = mask_to_regions(read, W, H)
    check("region cap", len(regions) <= 60, f"got {len(regions)}")

    blob = reader(W, H, lambda c, r: math.hypot(c - 100, r - 100) < 90)
    capped = mask_to_regions(blob, W, H, max_vertices_per_ring=24)
    check("vertex cap honoured", all(len(ring) <= 25 for rings, _ in capped for ring in rings))
    uncapped = mask_to_regions(blob, W, H)
    check(
        "default vertex cap honoured",
        all(len(ring) <= MAX_VERTICES_PER_RING + 1 for rings, _ in uncapped for ring in rings),
    )


def test_empty_mask() -> None:
    print("an empty mask yields nothing — never a fabricated region")
    W = H = 20
    read = reader(W, H, lambda c, r: False)
    check("no regions", mask_to_regions(read, W, H) == [])
    fc = regions_to_feature_collection([], lambda x, y: (x, y))
    check("empty FeatureCollection", fc["features"] == [])


def test_projection() -> None:
    print("regions project to WGS84 Polygon features")
    W = H = 20
    read = reader(W, H, lambda c, r: True)
    bbox = (-97.7, 30.5, -97.6, 30.6)

    def to_lnglat(x: float, y: float) -> tuple[float, float]:
        return (
            bbox[0] + x * (bbox[2] - bbox[0]) / W,
            bbox[3] - y * (bbox[3] - bbox[1]) / H,
        )

    fc = regions_to_feature_collection(
        mask_to_regions(read, W, H, min_region_area_cells=1), to_lnglat, {"zone": "catchment"}
    )
    check("one feature", len(fc["features"]) == 1)
    geom = fc["features"][0]["geometry"]
    check("Polygon", geom["type"] == "Polygon")
    ring = geom["coordinates"][0]
    check("closed ring", ring[0] == ring[-1])
    check("inside the bbox", all(bbox[0] - 1e-9 <= p[0] <= bbox[2] + 1e-9 for p in ring))
    check("properties carried", fc["features"][0]["properties"]["zone"] == "catchment")


def main() -> int:
    print(f"mask_regions parity tests (MIN_REGION_AREA_CELLS={MIN_REGION_AREA_CELLS})\n")
    for test in (
        test_solid_block_dissolves,
        test_hole,
        test_disjoint_and_speck,
        test_disc_is_not_a_lattice,
        test_edge_touching,
        test_honesty_bound,
        test_no_dilation,
        test_caps,
        test_empty_mask,
        test_projection,
    ):
        test()
        print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all mask_regions tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
