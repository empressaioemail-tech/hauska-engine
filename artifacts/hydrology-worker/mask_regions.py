"""
MASK -> DISSOLVED REGION POLYGONS (2026-07-30, flood overlay redesign).

PARITY MODULE. This is a cell-for-cell mirror of
`packages/adapters/src/hydrology/maskRegions.ts`. Both hydrology backends —
the pysheds sidecar and the native TypeScript D8 fallback — must produce the
SAME KIND of geometry, so the map does not change character depending on which
path happened to run. Any change here must land in the TS module too.

THE DEFECT THIS REPLACES: `_mask_to_geojson_polygons` walked the mask on a
coarse lattice (`step = min(h, w) // 20`) and emitted ONE INDEPENDENT
AXIS-ALIGNED SQUARE per sampled hit cell. Hundreds of disjoint squares with no
dissolve read as a blue checkerboard rather than a floodplain, and the area sum
under-counted the true mask because only every step-th cell contributed.

FOUR STAGES over the FULL-RESOLUTION mask:

  1. TRACE (exact-area boundary following). Each inside cell contributes its
     N/E/S/W CELL EDGE whenever the neighbour across that edge is outside;
     segments chain head-to-tail into closed rings. Following the cell edge
     (rather than classic marching squares on cell CENTRES) matters because
     the centre contour sits half a cell inside the true masked area on every
     side — a systematic area undercount, and these areas are load-bearing
     headline stats. Contiguous cells dissolve into ONE ring by construction.

  2. RINGS + HOLES. Signed area classifies each ring: positive = exterior
     shell, negative = hole. Holes attach to the smallest containing shell, so
     a mask with an interior void emits a polygon with an interior ring.

  3. SIMPLIFY + SMOOTH, BOUNDED. Douglas-Peucker at SIMPLIFY_TOLERANCE_CELLS
     (0.5 cells, its deviation bound by definition), then ONE displacement-
     bounded Chaikin pass whose per-edge offset is clamped to
     MAX_SMOOTH_OFFSET_CELLS (0.5 cells). Textbook Chaikin cuts each corner by
     a quarter of the adjacent edge, which on a simplified 20-cell edge moves
     the boundary 5 cells and eats >12% of the area — invented geometry. With
     the clamp, no vertex moves more than half a cell from the true boundary,
     and corner cutting only ever moves points ALONG existing edges, so the
     smoothed region never claims extent the mask does not have.

  4. SPECK FILTER + CAPS. Regions under MIN_REGION_AREA_CELLS cells are
     dropped as screening-resolution noise. Output caps at MAX_REGIONS
     polygons (largest first) and MAX_VERTICES_PER_RING vertices per ring.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Iterable

# Douglas-Peucker tolerance in MASK CELLS (half a cell: under the mask's own
# resolution, so simplification cannot move the boundary by a full cell).
SIMPLIFY_TOLERANCE_CELLS = 0.5

# THE HONESTY TOLERANCE: no smoothed vertex may sit further than this many
# mask cells from the true traced boundary.
MAX_SMOOTH_OFFSET_CELLS = 0.5

# Minimum enclosed area, in mask cells, for a region to survive.
MIN_REGION_AREA_CELLS = 4

# Hard cap on emitted polygons per FeatureCollection (largest area first).
MAX_REGIONS = 60

# Hard cap on vertices per ring after simplify + smooth (uniform decimation).
MAX_VERTICES_PER_RING = 400

# Chaikin corner-cutting passes. One pass reads organic; more drifts.
SMOOTHING_PASSES = 1

Point = tuple[float, float]


def _signed_area(ring: list[Point]) -> float:
    """Shoelace signed area in the y-DOWN grid frame, sign-normalized so an
    EXTERIOR SHELL is POSITIVE (the trace keeps the inside on its left)."""
    total = 0.0
    n = len(ring)
    for i in range(n):
        j = (i - 1) % n
        total += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    return total / 2.0


def trace_mask_rings(
    read: Callable[[int, int], bool], width: int, height: int
) -> list[tuple[list[Point], float]]:
    """Trace a boolean mask into closed cell-edge rings with signed areas.

    Grid coordinate convention: (x, y) means x cells right of column 0's left
    edge and y cells below row 0's top edge, so cell (col, row) spans
    [col, col+1] x [row, row+1].
    """

    def at(col: int, row: int) -> bool:
        if col < 0 or row < 0 or col >= width or row >= height:
            return False
        return read(col, row)

    segments: list[tuple[Point, Point]] = []
    for row in range(height):
        for col in range(width):
            if not at(col, row):
                continue
            x0, y0 = float(col), float(row)
            x1, y1 = float(col + 1), float(row + 1)
            # Inside-on-the-left in a y-down frame = the cell's own boundary
            # walked clockwise on screen.
            if not at(col, row - 1):
                segments.append(((x0, y0), (x1, y0)))  # north
            if not at(col + 1, row):
                segments.append(((x1, y0), (x1, y1)))  # east
            if not at(col, row + 1):
                segments.append(((x1, y1), (x0, y1)))  # south
            if not at(col - 1, row):
                segments.append(((x0, y1), (x0, y0)))  # west

    by_start: dict[Point, list[int]] = {}
    for index, seg in enumerate(segments):
        by_start.setdefault(seg[0], []).append(index)

    used = [False] * len(segments)
    rings: list[tuple[list[Point], float]] = []

    def rank(incoming: Point, seg: tuple[Point, Point]) -> int:
        dx = seg[1][0] - seg[0][0]
        dy = seg[1][1] - seg[0][1]
        cross = incoming[0] * dy - incoming[1] * dx
        dot = incoming[0] * dx + incoming[1] * dy
        if dot > 0:
            return 0  # straight ahead
        if cross > 0:
            return 1
        if cross < 0:
            return 2
        return 3  # reversal

    for start_index, seg in enumerate(segments):
        if used[start_index]:
            continue
        used[start_index] = True
        ring: list[Point] = [seg[0], seg[1]]
        cursor = seg[1]
        incoming = (seg[1][0] - seg[0][0], seg[1][1] - seg[0][1])
        for _ in range(len(segments) + 2):
            candidates = by_start.get(cursor)
            if not candidates:
                break
            # At a PINCH POINT (two regions touching diagonally) several
            # segments leave the same lattice corner; prefer the sharpest turn
            # that keeps the inside on the left so the walk stays on one
            # region's boundary rather than welding two regions together.
            best = -1
            best_rank = 99
            for cand in candidates:
                if used[cand]:
                    continue
                r = rank(incoming, segments[cand])
                if r < best_rank:
                    best_rank = r
                    best = cand
            if best < 0:
                break
            used[best] = True
            nxt = segments[best]
            incoming = (nxt[1][0] - nxt[0][0], nxt[1][1] - nxt[0][1])
            cursor = nxt[1]
            ring.append(cursor)
            if cursor == ring[0]:
                break
        if len(ring) < 4:
            continue
        if ring[-1] != ring[0]:
            ring.append(ring[0])
        area = _signed_area(ring)
        if area == 0:
            continue
        rings.append((ring, area))
    return rings


def _perp_distance(p: Point, a: Point, b: Point) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    len2 = dx * dx + dy * dy
    if len2 == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
    t = max(0.0, min(1.0, t))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def simplify_polyline(points: list[Point], tolerance: float) -> list[Point]:
    """Douglas-Peucker on an OPEN polyline; maximum deviation is `tolerance`
    by construction, the first half of this module's honesty bound."""
    if len(points) <= 2:
        return list(points)
    first, last = points[0], points[-1]
    max_dist = 0.0
    max_index = 0
    for i in range(1, len(points) - 1):
        d = _perp_distance(points[i], first, last)
        if d > max_dist:
            max_dist = d
            max_index = i
    if max_dist <= tolerance:
        return [first, last]
    left = simplify_polyline(points[: max_index + 1], tolerance)
    right = simplify_polyline(points[max_index:], tolerance)
    return left[:-1] + right


def simplify_ring(ring: list[Point], tolerance: float) -> list[Point]:
    """Douglas-Peucker on a CLOSED ring, split at two far-apart anchors so the
    closure point is not privileged. Returns a closed ring."""
    if len(ring) < 5:
        return list(ring)
    open_ring = ring[:-1]
    far = 0
    far_d = -1.0
    for i in range(1, len(open_ring)):
        d = math.hypot(
            open_ring[i][0] - open_ring[0][0], open_ring[i][1] - open_ring[0][1]
        )
        if d > far_d:
            far_d = d
            far = i
    a = simplify_polyline(open_ring[: far + 1], tolerance)
    b = simplify_polyline(open_ring[far:] + [open_ring[0]], tolerance)
    merged = a[:-1] + b[:-1]
    if len(merged) < 3:
        return list(ring)
    return merged + [merged[0]]


def smooth_ring(
    ring: list[Point],
    passes: int = SMOOTHING_PASSES,
    max_offset_cells: float = MAX_SMOOTH_OFFSET_CELLS,
) -> list[Point]:
    """DISPLACEMENT-BOUNDED Chaikin corner cutting on a CLOSED ring.

    The per-edge offset is clamped to `max_offset_cells` of grid distance:
    `t = min(0.25, max_offset_cells / edge_length)`. Long straight runs keep
    their line and only round the last half-cell at each corner; short
    staircase edges round fully. New points lie ON the original edges, so the
    smoothed region never claims extent the mask does not have.
    """
    current = list(ring)
    for _ in range(passes):
        if len(current) < 5:
            break
        open_ring = current[:-1]
        out: list[Point] = []
        n = len(open_ring)
        for i in range(n):
            p = open_ring[i]
            q = open_ring[(i + 1) % n]
            length = math.hypot(q[0] - p[0], q[1] - p[1])
            t = min(0.25, max_offset_cells / length) if length > 0 else 0.25
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
            out.append(
                (p[0] + (q[0] - p[0]) * (1 - t), p[1] + (q[1] - p[1]) * (1 - t))
            )
        out.append(out[0])
        current = out
    return current


def cap_ring_vertices(ring: list[Point], max_vertices: int = MAX_VERTICES_PER_RING) -> list[Point]:
    """Uniform decimation to at most `max_vertices`, preserving closure."""
    open_ring = ring[:-1]
    if len(open_ring) <= max_vertices:
        return list(ring)
    stride = len(open_ring) / max_vertices
    out = [open_ring[int(i * stride)] for i in range(max_vertices)]
    out.append(out[0])
    return out


def _point_in_polygon(pt: Point, ring: list[Point]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        j = (i - 1) % n
        xi, yi = ring[i]
        xj, yj = ring[j]
        denom = (yj - yi) or 1e-12
        if (yi > pt[1]) != (yj > pt[1]) and pt[0] < (xj - xi) * (pt[1] - yi) / denom + xi:
            inside = not inside
    return inside


def mask_to_regions(
    read: Callable[[int, int], bool],
    width: int,
    height: int,
    simplify_tolerance_cells: float = SIMPLIFY_TOLERANCE_CELLS,
    min_region_area_cells: float = MIN_REGION_AREA_CELLS,
    max_regions: int = MAX_REGIONS,
    max_vertices_per_ring: int = MAX_VERTICES_PER_RING,
    smoothing_passes: int = SMOOTHING_PASSES,
    max_smooth_offset_cells: float = MAX_SMOOTH_OFFSET_CELLS,
) -> list[tuple[list[list[Point]], float]]:
    """Trace a boolean mask into DISSOLVED regions in grid coordinates.

    Returns a list of (rings, area_cells); rings[0] is the exterior shell and
    any further rings are holes.
    """
    traced = trace_mask_rings(read, width, height)
    if not traced:
        return []

    refined: list[tuple[list[Point], float, bool]] = []  # ring, |area|, is_shell
    for ring, signed in traced:
        if abs(signed) < min_region_area_cells:
            continue
        out = simplify_ring(ring, simplify_tolerance_cells)
        out = smooth_ring(out, smoothing_passes, max_smooth_offset_cells)
        out = cap_ring_vertices(out, max_vertices_per_ring)
        if len(out) < 4:
            continue
        # The speck filter is applied to the TRACED (pre-refinement) area only
        # — that is the true masked cell count. Re-testing the post-smoothing
        # area would drop a region that passed the filter purely because
        # corner rounding shaved it under the threshold.
        area = _signed_area(out)
        if area == 0:
            continue
        refined.append((out, abs(area), signed > 0))

    shells = sorted(
        [r for r in refined if r[2]], key=lambda r: r[1], reverse=True
    )
    holes = [r for r in refined if not r[2]]
    if not shells:
        return []

    regions: list[tuple[list[list[Point]], float]] = [([s[0]], s[1]) for s in shells]
    region_rings = [list(r[0]) for r in regions]
    region_area = [r[1] for r in regions]

    # Assign each hole to the SMALLEST shell that contains it.
    for hole_ring, hole_area, _ in holes:
        probe = hole_ring[0]
        best = -1
        best_area = float("inf")
        for i, (shell_ring, shell_area, _s) in enumerate(shells):
            if shell_area <= hole_area:
                continue
            if not _point_in_polygon(probe, shell_ring):
                continue
            if shell_area < best_area:
                best_area = shell_area
                best = i
        if best >= 0:
            region_rings[best].append(hole_ring)
            region_area[best] -= hole_area

    # Final pass re-tests NET area (shell minus its holes) — a shell that only
    # cleared the filter because its hole was not yet subtracted is a speck.
    # The half-cell slack absorbs the documented corner-rounding loss so a
    # region is never dropped by the smoothing rather than by its true size.
    out_regions = [
        (region_rings[i], region_area[i])
        for i in range(len(region_rings))
        if region_area[i] >= min_region_area_cells - 0.5
    ]
    out_regions.sort(key=lambda r: r[1], reverse=True)
    return out_regions[:max_regions]


def regions_to_feature_collection(
    regions: Iterable[tuple[list[list[Point]], float]],
    to_lnglat: Callable[[float, float], tuple[float, float]],
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Project traced grid-space regions to WGS84 GeoJSON Polygon features."""
    props = properties or {}
    features: list[dict[str, Any]] = []
    for rings, _area in regions:
        coordinates = [[list(to_lnglat(x, y)) for (x, y) in ring] for ring in rings]
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": coordinates},
                "properties": dict(props),
            }
        )
    return {"type": "FeatureCollection", "features": features}
