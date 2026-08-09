#!/usr/bin/env python3
"""
Stream Geofabrik OSM PBF → NDJSON highway ways intersecting county polygons.

Disk-backed output (flat memory for kept ways). County geometry uses the same
even-odd / every-edge segment-cross rules as packages/engine-core
way-to-county.ts. Full centerline retained; no clipping.

Ruling: emit countyHits for every intersecting county; caller stamps
{fips}:road:{osmWayId} once per hit with the FULL geometry.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import osmium

try:
    import resource  # Unix peak RSS
except ImportError:  # Windows
    resource = None  # type: ignore

FLUSH_EVERY = 500


def _strip_bom(raw: bytes) -> bytes:
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:]
    return raw


def load_counties(path: Path) -> list[dict[str, Any]]:
    raw = _strip_bom(path.read_bytes())
    doc = json.loads(raw.decode("utf-8"))
    features: list[dict[str, Any]]
    if doc.get("type") == "FeatureCollection":
        features = list(doc.get("features") or [])
    elif doc.get("type") == "Feature":
        features = [doc]
    else:
        raise SystemExit(f"expected Feature or FeatureCollection, got {doc.get('type')}")

    counties: list[dict[str, Any]] = []
    for feat in features:
        props = feat.get("properties") or {}
        fips = (
            props.get("countyFips")
            or props.get("GEOID")
            or props.get("GEO_ID")
            or props.get("geoid")
        )
        if fips is None:
            raise SystemExit("county feature missing countyFips/GEOID")
        fips = str(fips).zfill(5)
        name = str(props.get("countyName") or props.get("NAME") or props.get("name") or fips)
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        if gtype == "Polygon":
            rings = [
                [(float(x), float(y)) for x, y in ring]
                for ring in geom["coordinates"]
            ]
            polys = [rings]
        elif gtype == "MultiPolygon":
            polys = [
                [[(float(x), float(y)) for x, y in ring] for ring in poly]
                for poly in geom["coordinates"]
            ]
        else:
            raise SystemExit(f"unsupported geometry type {gtype}")
        xs: list[float] = []
        ys: list[float] = []
        for rings in polys:
            for lon, lat in rings[0]:
                xs.append(lon)
                ys.append(lat)
        bbox = (min(xs), min(ys), max(xs), max(ys))
        counties.append(
            {
                "countyFips": fips,
                "countyName": name,
                "polys": polys,
                "bbox": bbox,
            }
        )
    if not counties:
        raise SystemExit("no county features loaded")
    return counties


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    """Even-odd ray cast; half-open edge rule matching LDT / way-to-county.ts."""
    crossings = 0
    n = len(ring)
    for i, j in zip(range(n), [n - 1] + list(range(n - 1))):
        ax, ay = ring[i]
        bx, by = ring[j]
        if (ay > lat) != (by > lat):
            t = (lat - ay) / (by - ay)
            x_cross = ax + t * (bx - ax)
            if x_cross > lon:
                crossings += 1
    return crossings % 2 == 1


def point_in_polys(lon: float, lat: float, polys: list[list[list[tuple[float, float]]]]) -> bool:
    for rings in polys:
        crossings = 0
        for ring in rings:
            n = len(ring)
            for i, j in zip(range(n), [n - 1] + list(range(n - 1))):
                ax, ay = ring[i]
                bx, by = ring[j]
                if (ay > lat) != (by > lat):
                    t = (lat - ay) / (by - ay)
                    x_cross = ax + t * (bx - ax)
                    if x_cross > lon:
                        crossings += 1
        if crossings % 2 == 1:
            return True
    return False


def segments_intersect(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    def orient(p, q, r):
        return (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])

    def on_seg(p, q, r):
        return (
            min(p[0], r[0]) - 1e-12 <= q[0] <= max(p[0], r[0]) + 1e-12
            and min(p[1], r[1]) - 1e-12 <= q[1] <= max(p[1], r[1]) + 1e-12
        )

    o1 = orient(a, b, c)
    o2 = orient(a, b, d)
    o3 = orient(c, d, a)
    o4 = orient(c, d, b)
    if (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0):
        return True
    if abs(o1) < 1e-18 and on_seg(a, c, b):
        return True
    if abs(o2) < 1e-18 and on_seg(a, d, b):
        return True
    if abs(o3) < 1e-18 and on_seg(c, a, d):
        return True
    if abs(o4) < 1e-18 and on_seg(c, b, d):
        return True
    return False


def way_crosses_outer_rings(
    coords: list[tuple[float, float]],
    polys: list[list[list[tuple[float, float]]]],
) -> bool:
    # Test EVERY outer-ring edge. Never decimate (prior draft missed ~23%).
    for i in range(len(coords) - 1):
        a = coords[i]
        b = coords[i + 1]
        for rings in polys:
            ring = rings[0]
            for j in range(len(ring) - 1):
                if segments_intersect(a, b, ring[j], ring[j + 1]):
                    return True
            if len(ring) >= 2 and segments_intersect(a, b, ring[-1], ring[0]):
                return True
    return False


def resolve_county_hits(
    coords: list[tuple[float, float]],
    counties: list[dict[str, Any]],
) -> list[dict[str, str]]:
    if len(coords) < 2:
        return []
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    wminx, wmaxx = min(xs), max(xs)
    wminy, wmaxy = min(ys), max(ys)
    hits: list[dict[str, str]] = []
    for county in counties:
        minx, miny, maxx, maxy = county["bbox"]
        if wmaxx < minx or wminx > maxx or wmaxy < miny or wminy > maxy:
            continue
        basis: str | None = None
        for lon, lat in coords:
            if point_in_polys(lon, lat, county["polys"]):
                basis = "vertex-inside"
                break
        if basis is None:
            for i in range(len(coords) - 1):
                a = coords[i]
                b = coords[i + 1]
                mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
                if point_in_polys(mid[0], mid[1], county["polys"]):
                    basis = "midpoint-inside"
                    break
        if basis is None and way_crosses_outer_rings(coords, county["polys"]):
            basis = "segment-crosses-boundary"
        if basis:
            hits.append(
                {
                    "countyFips": county["countyFips"],
                    "countyName": county["countyName"],
                    "basis": basis,
                }
            )
    return hits


def peak_rss_mb() -> float | None:
    """Best-effort peak RSS (MB). Prefer Working Set Peak via WinAPI; else Unix rusage."""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                    ("PrivateUsage", ctypes.c_size_t),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            # Prefer K32* (kernel32) — psapi may fail depending on Python bitness.
            getter = getattr(kernel32, "K32GetProcessMemoryInfo", None)
            if getter is None:
                getter = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
            getter.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
                wintypes.DWORD,
            ]
            getter.restype = wintypes.BOOL
            counters = PROCESS_MEMORY_COUNTERS_EX()
            counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
            if getter(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                # Prefer private peak proxy when WS peak looks stuck; report max of both.
                return max(counters.PeakWorkingSetSize, counters.PrivateUsage) / (
                    1024 * 1024
                )
        except Exception:
            pass
        try:
            import psutil  # type: ignore

            mi = psutil.Process().memory_info()
            return max(mi.rss, getattr(mi, "vms", 0)) / (1024 * 1024)
        except Exception:
            return None
        return None
    if resource is None:
        return None
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        rss = usage.ru_maxrss
        if sys.platform == "darwin":
            return rss / (1024 * 1024)
        return rss / 1024.0
    except Exception:
        return None


class HighwayExtractor(osmium.SimpleHandler):
    def __init__(self, counties: list[dict[str, Any]], out_fp, flush_every: int):
        super().__init__()
        self.counties = counties
        self.out_fp = out_fp
        self.flush_every = flush_every
        self.seen_ways = 0
        self.highway_ways = 0
        self.kept = 0
        self.skipped_no_loc = 0
        self.multi_county = 0
        self.pending_flush = 0
        self.peak_rss_mb = 0.0

    def _sample_rss(self) -> None:
        mb = peak_rss_mb()
        if mb is not None and mb > self.peak_rss_mb:
            self.peak_rss_mb = mb

    def way(self, w):
        self.seen_ways += 1
        if "highway" not in w.tags:
            return
        self.highway_ways += 1
        coords: list[tuple[float, float]] = []
        for n in w.nodes:
            loc = n.location
            if not loc.valid():
                self.skipped_no_loc += 1
                return
            coords.append((loc.lon, loc.lat))
        hits = resolve_county_hits(coords, self.counties)
        if not hits:
            if self.highway_ways % 250_000 == 0:
                self._sample_rss()
            return
        if len(hits) > 1:
            self.multi_county += 1
        tags = {t.k: t.v for t in w.tags}
        row = {
            "type": "way",
            "id": int(w.id),
            "tags": tags,
            "geometry": [{"lon": lon, "lat": lat} for lon, lat in coords],
            "countyHits": hits,
        }
        self.out_fp.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
        self.out_fp.write("\n")
        self.kept += 1
        self.pending_flush += 1
        if self.pending_flush >= self.flush_every:
            self.out_fp.flush()
            self.pending_flush = 0
            self._sample_rss()
            if self.kept % 2000 == 0:
                print(
                    f"  kept={self.kept} highway_seen={self.highway_ways} peak_rss_mb={self.peak_rss_mb:.1f}",
                    file=sys.stderr,
                )


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract highway ways from OSM PBF by county")
    ap.add_argument("--pbf", type=Path, required=True)
    ap.add_argument("--county-geojson", type=Path, required=True)
    ap.add_argument("--out-ndjson", type=Path, required=True)
    ap.add_argument("--report-json", type=Path, required=True)
    ap.add_argument("--flush-every", type=int, default=FLUSH_EVERY)
    ap.add_argument(
        "--expected-md5",
        type=str,
        default="",
        help="Optional MD5 hex of --pbf; fail closed on mismatch",
    )
    args = ap.parse_args()

    if not args.pbf.is_file():
        print(f"FATAL: pbf missing: {args.pbf}", file=sys.stderr)
        return 2

    if args.expected_md5:
        import hashlib

        h = hashlib.md5()
        with args.pbf.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        got = h.hexdigest().lower()
        want = args.expected_md5.strip().lower()
        if got != want:
            print(f"FATAL: pbf md5 mismatch got={got} want={want}", file=sys.stderr)
            return 3

    counties = load_counties(args.county_geojson)
    print(
        f"counties={len(counties)} first={counties[0]['countyFips']} ring0={len(counties[0]['polys'][0][0])}",
        file=sys.stderr,
    )

    args.out_ndjson.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    with args.out_ndjson.open("w", encoding="utf-8", newline="\n") as out_fp:
        handler = HighwayExtractor(counties, out_fp, max(1, args.flush_every))
        print(f"streaming {args.pbf} ...", file=sys.stderr)
        handler.apply_file(str(args.pbf), locations=True, idx="flex_mem")
        out_fp.flush()
        handler._sample_rss()

    elapsed = time.time() - t0
    report = {
        "generator": "artifacts/roads-pbf-worker/extract_highways.py",
        "pbf": str(args.pbf),
        "countyGeojson": str(args.county_geojson),
        "outNdjson": str(args.out_ndjson),
        "countyCount": len(counties),
        "countyFips": [c["countyFips"] for c in counties],
        "stats": {
            "waysSeen": handler.seen_ways,
            "highwayWays": handler.highway_ways,
            "keptIntersecting": handler.kept,
            "multiCountyWays": handler.multi_county,
            "skippedNoLocation": handler.skipped_no_loc,
            "elapsedSec": round(elapsed, 2),
            "peakRssMb": round(handler.peak_rss_mb, 2),
            "flushEvery": args.flush_every,
        },
        "ruling": "full-centerline-per-intersecting-county",
        "backpressure": "ndjson-disk-flush-every-N",
    }
    args.report_json.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["stats"], indent=2))
    print(f"wrote {args.out_ndjson} lines={handler.kept}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
