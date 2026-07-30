"""
Parity tests for the PONDING CRITERION and the CONCENTRATION BANDING guards
shared by the pysheds worker (`run.py`) and the native TypeScript D8 fallback
(`packages/adapters/src/hydrology/hydrologyNative.ts`).

Runs with the standard library only (no numpy, no pysheds, no rasterio) so it
is executable anywhere the worker source lives:

    python artifacts/hydrology-worker/test_ponding_criterion.py

Exits non-zero on failure.

WHY THIS FILE EXISTS (2026-07-30). Both backends shipped an indefensible
ponding rule and they were indefensible in DIFFERENT ways, which is exactly how
a two-backend system drifts without anyone noticing:

  - pysheds:   inflated = dem + rainfall_m
               pond     = inflated > dem + 0.25 * rainfall_m
               ...which reduces to rainfall_m > 0.25 * rainfall_m — TRUE for
               every cell of the raster whenever any rain falls at all.
  - native TS: pond_depth = rainfall * min(1, (1 / accumulation) * 10) over a
               5 mm bar — INVERTED (ridge cells scored the full storm depth)
               and passing ~100% of cells regardless.

On live parcel 48021:36249 (Bastrop, ~9.2 ac) that reported 396,134 sq ft of
ponding against a 398,813 sq ft parcel. Both now implement the SAME criterion,
and these tests are the lock that keeps them the same.

`run.py` imports numpy and pysheds at module scope, so it cannot be imported
here. The criterion is therefore re-implemented in plain Python from the
documented contract and checked against the constants PARSED OUT of both source
files — if either backend's constant moves without the other, this fails.
"""
from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RUN_PY = os.path.join(HERE, "run.py")
NATIVE_TS = os.path.join(
    REPO, "packages", "adapters", "src", "hydrology", "hydrologyNative.ts"
)

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def grab(source: str, pattern: str) -> str | None:
    match = re.search(pattern, source)
    return match.group(1) if match else None


# ─── the criterion, mirrored from the documented contract ────────────────


def ponding_depth_meters(
    filled_elevation: float, raw_elevation: float, rainfall_m: float
) -> float:
    """pond_depth = min(filled - raw, rainfall), floored at 0.

    `filled - raw` is the depth of the depression trapping water at this cell:
    depression-filling raises exactly the cells with no downslope escape. A
    cell on a slope has filled == raw and therefore never ponds.
    """
    depression_depth = filled_elevation - raw_elevation
    if not depression_depth > 0:
        return 0.0
    return min(depression_depth, max(0.0, rainfall_m))


def test_constants_match_across_backends() -> None:
    print("constants are identical in both backends")
    run_src = read(RUN_PY)
    ts_src = read(NATIVE_TS)

    py_depth = grab(run_src, r"MIN_PONDING_DEPTH_METERS\s*=\s*([\d.]+)")
    ts_depth = grab(ts_src, r"MIN_PONDING_DEPTH_METERS\s*=\s*([\d.]+)")
    check(
        "MIN_PONDING_DEPTH_METERS present in both",
        py_depth is not None and ts_depth is not None,
        f"py={py_depth} ts={ts_depth}",
    )
    check(
        "MIN_PONDING_DEPTH_METERS agrees",
        py_depth == ts_depth,
        f"py={py_depth} ts={ts_depth}",
    )
    check(
        "minimum ponding depth is a pad-relevant depth, not a 5mm trace",
        py_depth is not None and float(py_depth) >= 0.05,
        f"got {py_depth}",
    )

    py_band = grab(run_src, r"MIN_BANDABLE_CATCHMENT_CELLS\s*=\s*(\d+)")
    ts_band = grab(ts_src, r"MIN_BANDABLE_CATCHMENT_CELLS\s*=\s*(\d+)")
    check(
        "MIN_BANDABLE_CATCHMENT_CELLS present in both",
        py_band is not None and ts_band is not None,
        f"py={py_band} ts={ts_band}",
    )
    check(
        "MIN_BANDABLE_CATCHMENT_CELLS agrees",
        py_band == ts_band,
        f"py={py_band} ts={ts_band}",
    )

    # HAND / channel-stage constants (2026-07-30 real-terrain calibration).
    # Both backends must model the SAME water surface or the picture changes
    # with which backend happened to run.
    for name, pattern in (
        ("CHANNEL_ACCUMULATION_FRACTION_OF_MAX", r"([\d.]+)"),
        ("CHANNEL_MIN_ACCUMULATION_CELLS", r"([\d_]+)"),
        ("MIN_CHANNEL_CONTRIBUTING_AREA_SQ_METERS", r"([\d_]+)"),
        ("SCREENING_RUNOFF_COEFFICIENT", r"([\d.]+)"),
        ("HYDRAULIC_GEOMETRY_DEPTH_COEFFICIENT", r"([\d.]+)"),
        ("HYDRAULIC_GEOMETRY_DEPTH_EXPONENT", r"([\d.]+)"),
        ("RIVERINE_COVERAGE_MIN_CONTRIBUTING_AREA_SQ_METERS", r"([\d_]+)"),
    ):
        py_v = grab(run_src, rf"{name}\s*=\s*{pattern}")
        ts_v = grab(ts_src, rf"{name}\s*=\s*{pattern}")
        check(
            f"{name} present in both",
            py_v is not None and ts_v is not None,
            f"py={py_v} ts={ts_v}",
        )
        norm = lambda v: None if v is None else v.replace("_", "")
        check(
            f"{name} agrees",
            norm(py_v) == norm(ts_v),
            f"py={py_v} ts={ts_v}",
        )


def test_inundation_mechanism_present_in_both_backends() -> None:
    """DEPRESSION STORAGE ALONE IS NOT ENOUGH — lock the second mechanism in.

    This is the regression that the #191 test suite could not catch, because
    every fixture it used was a synthetic closed depression. A floodplain is
    not a closed depression, so a depression-only model reports it dry. Both
    backends must carry the HAND/stage inundation term.
    """
    print("both backends model low-lying inundation, not just depression storage")
    run_src = read(RUN_PY)
    ts_src = read(NATIVE_TS)
    for label, src, hand_token in (
        ("pysheds", run_src, "_hand"),
        ("native", ts_src, "heightAboveNearestDrainage"),
    ):
        check(f"{label} computes HAND", hand_token in src)
        check(
            f"{label} derives a channel stage",
            "channel_stage" in src.lower() or "channelstage" in src.lower(),
        )
        check(
            f"{label} discloses BOTH ponding mechanisms in the payload",
            "low-lying-inundation" in src and "depression-storage" in src,
        )
        check(
            f"{label} states riverine flooding is out of model scope",
            "RIVERINE_OUT_OF_SCOPE_NOTE" in src
            and "riverineFloodHazardModeled" in src,
        )
        check(
            f"{label} excludes the channel bed itself from inundation",
            "conveyance" in src,
        )


def strip_python_comments_and_docstrings(source: str) -> str:
    """Return only EXECUTABLE python: no `#` comments, no triple-quoted blocks.

    The old rules are deliberately still QUOTED in the docstrings — that is the
    record of what was wrong and why. These tests must therefore assert on the
    code that runs, not on the prose that explains it.
    """
    without_docstrings = re.sub(r'"""(?:.|\n)*?"""', "", source)
    without_docstrings = re.sub(r"'''(?:.|\n)*?'''", "", without_docstrings)
    lines = []
    for line in without_docstrings.split("\n"):
        lines.append(re.sub(r"#.*$", "", line))
    return "\n".join(lines)


def strip_ts_comments(source: str) -> str:
    """Return only EXECUTABLE TypeScript: no block or line comments."""
    without_block = re.sub(r"/\*(?:.|\n)*?\*/", "", source)
    lines = []
    for line in without_block.split("\n"):
        lines.append(re.sub(r"//.*$", "", line))
    return "\n".join(lines)


def test_old_rules_are_gone() -> None:
    print("the indefensible rules are gone from both backends (code, not prose)")
    run_code = strip_python_comments_and_docstrings(read(RUN_PY))
    ts_code = strip_ts_comments(read(NATIVE_TS))

    # pysheds: the tautology `inflated > dem + rainfall_m * 0.25`.
    check(
        "pysheds no longer builds an `inflated` raster to compare against itself",
        "inflated" not in run_code,
    )
    check(
        "pysheds no longer uses the 0.25 rainfall tautology",
        "rainfall_m * 0.25" not in run_code,
    )
    # native: the inverted 1/accumulation wetness proxy over a 5 mm bar.
    check(
        "native no longer uses a slopeProxy wetness term",
        "slopeProxy" not in ts_code,
    )
    check(
        "native no longer thresholds ponding at 0.005 m",
        "pondDepth > 0.005" not in ts_code,
    )
    # The raw DEM must survive fill so `filled - raw` is computable.
    check(
        "pysheds keeps the RAW dem alongside the filled one",
        "raw_dem" in run_code and "fill_depressions(raw_dem)" in run_code,
    )
    # The old rules SHOULD still be documented — the record of the defect.
    check(
        "pysheds still documents the old tautology in prose",
        "rainfall_m * 0.25" in read(RUN_PY),
    )
    check(
        "native still documents the old wetness proxy in prose",
        "slopeProxy" in read(NATIVE_TS),
    )


def test_slope_never_ponds() -> None:
    print("a cell on a slope never ponds, however hard it rains")
    # filled == raw is the signature of a cell with a downslope escape.
    check("no depression, no ponding", ponding_depth_meters(100.0, 100.0, 10.0) == 0.0)
    check(
        "a huge storm still does not pond a slope",
        ponding_depth_meters(100.0, 100.0, 1_000.0) == 0.0,
    )
    check(
        "a negative difference never yields ponding",
        ponding_depth_meters(99.0, 100.0, 10.0) == 0.0,
    )


def test_depression_ponds_to_the_lesser_of_depth_and_storm() -> None:
    print("a depression holds the lesser of its depth and the storm")
    # A 2 m sink under a 0.24 m storm holds the storm depth, not 2 m.
    check(
        "storm-limited", abs(ponding_depth_meters(102.0, 100.0, 0.24) - 0.24) < 1e-9
    )
    # A 0.05 m dimple under a 5 m storm holds only its own 0.05 m.
    check(
        "depression-limited",
        abs(ponding_depth_meters(100.05, 100.0, 5.0) - 0.05) < 1e-9,
    )


def test_reporting_threshold() -> None:
    print("only pad-relevant depths are reported as ponded")
    run_src = read(RUN_PY)
    min_depth = float(grab(run_src, r"MIN_PONDING_DEPTH_METERS\s*=\s*([\d.]+)") or 0)

    def ponded(filled: float, raw: float, rain: float) -> bool:
        return ponding_depth_meters(filled, raw, rain) >= min_depth

    check("a 5mm trace is not ponding", not ponded(100.005, 100.0, 1.0))
    check("a shallow dimple is not ponding", not ponded(100.05, 100.0, 5.0))
    check("a real hollow IS ponding", ponded(100.5, 100.0, 5.0))
    check(
        "a deep sink under a big storm IS ponding", ponded(103.0, 100.0, 0.24)
    )


def test_old_pysheds_rule_would_have_ponded_everything() -> None:
    print("the OLD pysheds rule is demonstrably a tautology")
    rainfall_m = 0.2413  # the 9.5 in Central TX design storm

    def old_rule(dem_value: float) -> bool:
        inflated = dem_value + rainfall_m
        return inflated > dem_value + (rainfall_m * 0.25)

    everything = [old_rule(z) for z in (0.0, 100.0, 250.5, -3.0, 1_000.0)]
    check(
        "old rule returned True for every elevation — no cell could ever fail",
        all(everything),
        f"got {everything}",
    )
    # And the new rule on the same flat/sloped cells returns nothing.
    check(
        "new rule returns 0 on those same non-depression cells",
        all(ponding_depth_meters(z, z, rainfall_m) == 0.0 for z in (0.0, 100.0, 250.5)),
    )


def test_banding_guards_present() -> None:
    print("banding guards are present and self-describing in both backends")
    run_src = read(RUN_PY)
    ts_src = read(NATIVE_TS)

    check(
        "pysheds has the too-small-to-band state",
        "concentration_basis_too_small" in run_src
        and "too small to band" in run_src,
    )
    check(
        "native has the too-small-to-band state",
        "concentrationBasisTooSmall" in ts_src and "too small to band" in ts_src,
    )
    check(
        "pysheds names the uniform-field state",
        "CONCENTRATION_BASIS_NO_GRADIENT" in run_src and "uniform" in run_src,
    )
    check(
        "native names the uniform-field state",
        "CONCENTRATION_BASIS_NO_GRADIENT" in ts_src and "uniform" in ts_src,
    )
    # The speck floor must no longer differ by band — that silently deleted
    # genuine small bands and left the payload looking like band 0 alone.
    check(
        "pysheds traces every band at the delineated floor",
        "MIN_REGION_AREA_CELLS if concentration == 0" not in run_src,
    )
    check(
        "native traces every band at the delineated floor",
        "concentration === 0 ? { minRegionAreaCells" not in ts_src,
    )


def test_ponding_basis_is_disclosed() -> None:
    print("the ponding basis is disclosed in both payloads")
    run_src = read(RUN_PY)
    ts_src = read(NATIVE_TS)
    for label, src in (("pysheds", run_src), ("native", ts_src)):
        check(f"{label} ships a pondingBasis", "pondingBasis" in src)
        check(
            f"{label} basis names depression storage",
            "depression storage" in src,
        )
        check(
            f"{label} basis names low-lying inundation too",
            "low-lying inundation" in src,
        )
        check(
            f"{label} basis names what it excludes",
            "infiltration" in src,
        )
        check(
            f"{label} basis admits riverine stage is under-represented",
            "UNDER-represented" in src,
        )
        check(
            f"{label} basis points at the FEMA NFHL as authoritative",
            "NFHL" in src,
        )


def main() -> int:
    print("ponding criterion + banding parity tests\n")
    for test in (
        test_constants_match_across_backends,
        test_inundation_mechanism_present_in_both_backends,
        test_old_rules_are_gone,
        test_slope_never_ponds,
        test_depression_ponds_to_the_lesser_of_depth_and_storm,
        test_reporting_threshold,
        test_old_pysheds_rule_would_have_ponded_everything,
        test_banding_guards_present,
        test_ponding_basis_is_disclosed,
    ):
        test()
        print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all ponding criterion tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
