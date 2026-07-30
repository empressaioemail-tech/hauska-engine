import { describe, it, expect } from "vitest";
import {
  runHydrologyNative,
  deriveConcentrationBands,
  accumulationThresholdForResolution,
  computeD8Field,
  isCellPonded,
  pondingDepthMeters,
  ACCUMULATION_THRESHOLD_BASE_CELLS,
  MIN_PONDING_DEPTH_METERS,
  MIN_BANDABLE_CATCHMENT_CELLS,
} from "../hydrologyNative.js";

const BBOX = { westLng: -97.68, southLat: 30.5, eastLng: -97.67, northLat: 30.51 };
const METERS_PER_DEG_LAT = 110_574;
const SQFT_PER_SQM = 10.7639;

/** Shoelace area of a FeatureCollection's polygons, square feet. */
function fcAreaSqFt(fc: { features: ReadonlyArray<{ geometry: { type: string; coordinates: unknown } }> } | null): number {
  if (!fc) return 0;
  let total = 0;
  for (const f of fc.features) {
    if (f.geometry.type !== "Polygon") continue;
    const rings = f.geometry.coordinates as Array<Array<[number, number]>>;
    rings.forEach((ring, ringIndex) => {
      const mLng = METERS_PER_DEG_LAT * Math.cos((ring[0]![1] * Math.PI) / 180);
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum +=
          ring[j]![0] * mLng * ring[i]![1] * METERS_PER_DEG_LAT -
          ring[i]![0] * mLng * ring[j]![1] * METERS_PER_DEG_LAT;
      }
      const area = Math.abs(sum / 2) * SQFT_PER_SQM;
      total += ringIndex === 0 ? area : -area;
    });
  }
  return total;
}

describe("runHydrologyNative", () => {
  it("produces drainage zones and flow lines on a sloped grid", () => {
    const width = 12;
    const height = 12;
    const elevation = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        elevation[row * width + col] = 100 + col * 0.5 + row * 0.2;
      }
    }
    const result = runHydrologyNative({
      width,
      height,
      elevation,
      catchmentBbox: {
        westLng: -97.68,
        southLat: 30.5,
        eastLng: -97.67,
        northLat: 30.51,
      },
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 101.6,
      accumulationThreshold: 2,
    });
    expect(result.status).toBe("ok");
    expect(result.drainageZonesGeoJson.features.length).toBeGreaterThan(0);
    expect(result.flowLinesGeoJson.features.length).toBeGreaterThan(0);
    // PONDING ON A PURE SLOPE IS ZERO (2026-07-30 criterion fix). This grid is
    // strictly monotonic — every cell drains to a lower neighbour, so nothing
    // impounds. The prior assertion here demanded features > 0 and passed only
    // because the old rule ponded ~every cell of any rained-on raster; it was
    // encoding the defect. An empty result is the honest one, and the run is
    // still ok (rainfall WAS modeled; none of it stands).
    expect(result.rainfallResultGeoJson).not.toBeNull();
    expect(result.rainfallResultGeoJson?.features.length).toBe(0);
  });

  it("emits DISSOLVED regions, not one square per subsampled cell", () => {
    // A bowl: a broad basin that drains to the centre, so the catchment mask
    // is a large contiguous blob. The OLD converter emitted one axis-aligned
    // square per sampled cell at step = min(w,h)/12; the dissolved converter
    // emits a handful of traced polygons for the same mask.
    const width = 48;
    const height = 48;
    const elevation = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const dx = col - 24;
        const dy = row - 24;
        elevation[row * width + col] = 100 + (dx * dx + dy * dy) * 0.01 + col * 0.001;
      }
    }
    const bbox = { westLng: -97.68, southLat: 30.5, eastLng: -97.67, northLat: 30.51 };
    const result = runHydrologyNative({
      width,
      height,
      elevation,
      catchmentBbox: bbox,
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 101.6,
      accumulationThreshold: 5,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const zones = result.drainageZonesGeoJson.features;
    expect(zones.length).toBeGreaterThan(0);
    // Dissolved: a handful of features for a mask of hundreds of cells.
    expect(zones.length).toBeLessThan(20);

    for (const feature of zones) {
      const ring = (feature.geometry.coordinates as Array<Array<[number, number]>>)[0]!;
      // No feature is a bare 5-point axis-aligned square (the lattice
      // signature); a traced region carries a real boundary.
      const isSquare =
        ring.length === 5 &&
        ring[0]![1] === ring[1]![1] &&
        ring[1]![0] === ring[2]![0] &&
        ring[2]![1] === ring[3]![1];
      expect(isSquare).toBe(false);
    }
  });
});

/**
 * THE PONDING CRITERION (2026-07-30). The headline "modeled ponding covers N
 * acres" must mean standing water that would actually accumulate. These tests
 * pin the criterion honest in BOTH directions: a shedding parcel must not
 * report near-total ponding, and a genuine depression must still report it.
 */
describe("ponding criterion — depression storage, not wetness", () => {
  it("does not pond a cell on a slope, however hard it rains", () => {
    // filled == raw is the signature of a cell with a downslope escape.
    expect(pondingDepthMeters(100, 100, 10)).toBe(0);
    expect(isCellPonded(100, 100, 10)).toBe(false);
  });

  it("ponds a genuine depression to the lesser of its depth and the storm", () => {
    // A 2 m sink under a 0.24 m storm holds the storm depth, not 2 m.
    expect(pondingDepthMeters(102, 100, 0.24)).toBeCloseTo(0.24, 6);
    // A 0.05 m dimple under a 5 m storm holds only its own 0.05 m...
    expect(pondingDepthMeters(100.05, 100, 5)).toBeCloseTo(0.05, 6);
    // ...which is below the reporting minimum, so it is not ponded.
    expect(isCellPonded(100.05, 100, 5)).toBe(false);
    expect(isCellPonded(100.5, 100, 5)).toBe(true);
  });

  it("rejects the 5mm trace the old rule accepted", () => {
    // The old native rule reported any cell over 0.005 m as ponded.
    expect(MIN_PONDING_DEPTH_METERS).toBeGreaterThan(0.005);
    expect(isCellPonded(100.005, 100, 1)).toBe(false);
  });

  it("never ponds on nodata", () => {
    expect(pondingDepthMeters(Number.NaN, 100, 1)).toBe(0);
    expect(pondingDepthMeters(100, Number.NaN, 1)).toBe(0);
  });

  /**
   * THE LIVE DEFECT, MECHANICALLY. Parcel 48021:36249 (Bastrop, ~9.2 ac) is a
   * local high point: negligible upstream catchment, rainfall sheds off it.
   * The old criterion reported 396,134 sq ft of ponding against a 398,813 sq
   * ft parcel — 99.3% — in a briefing that simultaneously called it a high
   * point. A shedding parcel cannot be nearly all pond.
   */
  it("a shedding high point does not report near-total ponding", () => {
    const RES = 10;
    const W = 115;
    const H = 115;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        // Broad gentle dome: every cell has a downslope escape.
        const d = Math.hypot((col - 57) * RES, (row - 57) * RES);
        elevation[row * W + col] = 140 - d * 0.02 + (col - 57) * RES * 0.001;
      }
    }
    const result = runHydrologyNative({
      width: W,
      height: H,
      elevation,
      catchmentBbox: BBOX,
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 9.5 * 25.4, // the 100-yr 24-hr Central TX design storm
      accumulationThreshold: 50,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const pondSqFt = fcAreaSqFt(result.rainfallResultGeoJson);
    const regionSqFt = W * H * RES * RES * SQFT_PER_SQM;
    // The old rule scored 100% here. A shedding dome ponds essentially none.
    expect(pondSqFt / regionSqFt).toBeLessThan(0.05);
  });

  /**
   * HONEST IN THE OTHER DIRECTION. The fix must be a real criterion, not a
   * clamp that makes the number look nice — a parcel that genuinely floods
   * must still show it.
   */
  it("a genuine bowl still reports substantial ponding", () => {
    const W = 60;
    const H = 60;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const d = Math.hypot(col - 30, row - 30);
        // A closed 3.6 m deep basin inside a rising rim — water has no exit.
        elevation[row * W + col] = d < 12 ? 100 - (12 - d) * 0.3 : 100 + (d - 12) * 0.05;
      }
    }
    const result = runHydrologyNative({
      width: W,
      height: H,
      elevation,
      catchmentBbox: BBOX,
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 9.5 * 25.4,
      accumulationThreshold: 50,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const ponded = result.rainfallResultGeoJson;
    expect(ponded).not.toBeNull();
    expect(ponded!.features.length).toBeGreaterThan(0);
    // The basin is ~450 cells of a 3600-cell grid; the ponded region must be
    // a real fraction of it, not a speck.
    const pondSqFt = fcAreaSqFt(ponded);
    const cellSqFt = 100 * SQFT_PER_SQM; // nominal, only for a floor check
    expect(pondSqFt).toBeGreaterThan(cellSqFt * 50);
  });

  it("carries the ponding basis in the payload — never an unexplained blue area", () => {
    const W = 60;
    const H = 60;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const d = Math.hypot(col - 30, row - 30);
        elevation[row * W + col] = d < 12 ? 100 - (12 - d) * 0.3 : 100 + (d - 12) * 0.05;
      }
    }
    const result = runHydrologyNative({
      width: W,
      height: H,
      elevation,
      catchmentBbox: BBOX,
      pourLng: -97.675,
      pourLat: 30.505,
      rainfallDepthMm: 9.5 * 25.4,
      accumulationThreshold: 50,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    const props = result.rainfallResultGeoJson!.features[0]!.properties as {
      pondingBasis?: string;
      minPondingDepthMeters?: number;
    };
    expect(props.pondingBasis).toContain("depression storage");
    // The disclosure must name what the model does NOT cover.
    expect(props.pondingBasis).toContain("infiltration");
    expect(props.minPondingDepthMeters).toBe(MIN_PONDING_DEPTH_METERS);
  });
});

describe("fillDepressions (priority-flood)", () => {
  it("converges on a wide bowl — the old single-pass sweep did not", () => {
    const W = 40;
    const H = 40;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const d = Math.hypot(col - 20, row - 20);
        elevation[row * W + col] = d < 10 ? 100 - (10 - d) * 0.5 : 100 + (d - 10) * 0.05;
      }
    }
    const { filled } = computeD8Field(elevation, W, H);
    const centre = 20 * W + 20;
    // Bowl centre sits 5 m below the 100 m rim; a converged fill lifts it to
    // the spill level, so the depression depth is ~5 m — not the ~0.5 m a
    // single lowest-neighbour pass produced.
    expect(filled[centre]! - elevation[centre]!).toBeGreaterThan(4);
  });

  it("leaves a monotonic slope untouched", () => {
    const W = 20;
    const H = 20;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        elevation[row * W + col] = 100 + col * 0.5;
      }
    }
    const { filled } = computeD8Field(elevation, W, H);
    for (let i = 0; i < W * H; i++) {
      expect(filled[i]!).toBeCloseTo(elevation[i]!, 5);
    }
  });

  it("never lowers a cell", () => {
    const W = 25;
    const H = 25;
    const elevation = new Float32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        elevation[row * W + col] =
          100 + Math.sin(col * 0.7) * 2 + Math.cos(row * 0.5) * 2 + col * 0.1;
      }
    }
    const { filled } = computeD8Field(elevation, W, H);
    for (let i = 0; i < W * H; i++) {
      expect(filled[i]!).toBeGreaterThanOrEqual(elevation[i]! - 1e-6);
    }
  });
});

describe("deriveConcentrationBands", () => {
  const bbox = { westLng: -97.68, southLat: 30.5, eastLng: -97.67, northLat: 30.51 };
  const W = 30;
  const H = 30;

  it("emits three NESTED bands from the accumulation grid, ordered low to high", () => {
    const mask = new Uint8Array(W * H).fill(1);
    const acc = new Uint32Array(W * H);
    // A radial accumulation field: highest at the centre, so the 70th and
    // 90th percentile bands are concentric discs inside the full extent.
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const d = Math.hypot(col - 15, row - 15);
        acc[row * W + col] = Math.max(0, Math.round(400 - d * 20));
      }
    }
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox, { library: "test" });
    const bands = fc.features.map(
      (f) => (f.properties as { concentration: number }).concentration,
    );
    expect(new Set(bands)).toEqual(new Set([0, 1, 2]));

    // NESTING: each higher band encloses strictly less area than the one
    // below it — three concentration rings, not three copies of the extent.
    const areaOf = (concentration: number): number => {
      let total = 0;
      for (const f of fc.features) {
        if ((f.properties as { concentration: number }).concentration !== concentration) continue;
        const ring = (f.geometry.coordinates as Array<Array<[number, number]>>)[0]!;
        let sum = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
        }
        total += Math.abs(sum / 2);
      }
      return total;
    };
    expect(areaOf(0)).toBeGreaterThan(areaOf(1));
    expect(areaOf(1)).toBeGreaterThan(areaOf(2));

    // Every band carries the derivation basis — never an unexplained number.
    for (const f of fc.features) {
      expect((f.properties as { concentrationBasis?: string }).concentrationBasis).toBeTruthy();
    }
  });

  it("emits only band 0 on a flat accumulation field — never a fabricated band", () => {
    const mask = new Uint8Array(W * H).fill(1);
    const acc = new Uint32Array(W * H).fill(7); // every quantile is the same
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox);
    const bands = new Set(
      fc.features.map((f) => (f.properties as { concentration: number }).concentration),
    );
    expect(bands).toEqual(new Set([0]));
    // And it SAYS the field is uniform, rather than shipping a generic basis
    // that reads to the client as "the other two bands failed to render".
    for (const f of fc.features) {
      expect((f.properties as { concentrationBasis: string }).concentrationBasis).toContain(
        "uniform",
      );
    }
  });

  /**
   * THE LIVE BANDING DEFECT (2026-07-30). On parcel 48021:36249 the catchment
   * delineated to 3,223 sq ft — about 3 cells of a 10 m DEM. The 70th/90th
   * percentiles over three values collapse onto one, and the single-cell band
   * masks that did survive were deleted by the library 4-cell speck floor. The
   * payload shipped one bare `concentration: 0` feature, which to a client
   * painting three amber tones is indistinguishable from a rendering bug.
   */
  it("a catchment too small to band says so explicitly, not silently as band 0", () => {
    const mask = new Uint8Array(W * H);
    const acc = new Uint32Array(W * H);
    // Three contiguous cells with distinct accumulation — the live shape.
    for (let k = 0; k < 3; k++) {
      mask[5 * W + 5 + k] = 1;
      acc[5 * W + 5 + k] = k + 1;
    }
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox);
    expect(fc.features.length).toBeGreaterThan(0);
    const bands = new Set(
      fc.features.map((f) => (f.properties as { concentration: number }).concentration),
    );
    expect(bands).toEqual(new Set([0]));

    // The state must be SELF-DESCRIBING: name the cell count and the reason.
    for (const f of fc.features) {
      const basis = (f.properties as { concentrationBasis: string }).concentrationBasis;
      expect(basis).toContain("too small to band");
      expect(basis).toContain("3 DEM cells");
      expect(basis).toContain(String(MIN_BANDABLE_CATCHMENT_CELLS));
      // It must NOT be the bare generic string that hid the finding.
      expect(basis).not.toBe("modeled catchment extent");
    }
  });

  it("bands a realistically-sized catchment into three distinct nested bands", () => {
    // A valley draining to a central channel — well over the banding minimum.
    const mask = new Uint8Array(W * H).fill(1);
    const acc = new Uint32Array(W * H);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        acc[row * W + col] = Math.max(1, Math.round(500 - Math.abs(col - 15) * 30));
      }
    }
    expect(W * H).toBeGreaterThanOrEqual(MIN_BANDABLE_CATCHMENT_CELLS);

    const fc = deriveConcentrationBands(mask, acc, W, H, bbox);
    const bands = fc.features.map(
      (f) => (f.properties as { concentration: number }).concentration,
    );
    // All three bands genuinely materialize — the live payload had only one.
    expect(new Set(bands)).toEqual(new Set([0, 1, 2]));

    const areaOf = (concentration: number): number =>
      fcAreaSqFt({
        features: fc.features.filter(
          (f) => (f.properties as { concentration: number }).concentration === concentration,
        ),
      });
    // Nested and strictly decreasing — three rings, not three copies.
    expect(areaOf(0)).toBeGreaterThan(areaOf(1));
    expect(areaOf(1)).toBeGreaterThan(areaOf(2));

    for (const f of fc.features) {
      const basis = (f.properties as { concentrationBasis: string }).concentrationBasis;
      expect(basis).toBeTruthy();
      expect(basis).not.toContain("too small to band");
    }
  });

  it("does not delete a genuine small band to the library speck floor", () => {
    // A 16-cell catchment whose top decile is 2 cells: over the banding
    // minimum, but under the 4-cell speck floor bands 1/2 used to trace at.
    const mask = new Uint8Array(W * H);
    const acc = new Uint32Array(W * H);
    for (let k = 0; k < 16; k++) {
      const col = 5 + (k % 4);
      const row = 5 + Math.floor(k / 4);
      mask[row * W + col] = 1;
      acc[row * W + col] = k < 12 ? 1 : 100; // a concentrated 4-cell core
    }
    const fc = deriveConcentrationBands(mask, acc, W, H, bbox);
    const bands = new Set(
      fc.features.map((f) => (f.properties as { concentration: number }).concentration),
    );
    // The high-accumulation core must survive as its own band.
    expect(bands.has(0)).toBe(true);
    expect(bands.size).toBeGreaterThan(1);
  });

  it("returns nothing for an empty catchment mask", () => {
    const fc = deriveConcentrationBands(
      new Uint8Array(W * H),
      new Uint32Array(W * H),
      W,
      H,
      bbox,
    );
    expect(fc.features.length).toBe(0);
  });
});

describe("accumulationThresholdForResolution", () => {
  it("stays at the 50-cell base at the 10m reference resolution", () => {
    expect(accumulationThresholdForResolution(10)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });

  it("scales quadratically finer so channel density is resolution-invariant", () => {
    // Same PHYSICAL drainage-area cutoff: threshold * res^2 is constant.
    expect(accumulationThresholdForResolution(1)).toBe(5000); // 50 * 10^2
    expect(accumulationThresholdForResolution(2)).toBe(1250); // 50 * 5^2
    expect(accumulationThresholdForResolution(5)).toBe(200); // 50 * 2^2
  });

  it("never drops below the base for coarse DEMs (min 50)", () => {
    expect(accumulationThresholdForResolution(30)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });

  it("falls back to the base on degenerate resolutions", () => {
    expect(accumulationThresholdForResolution(0)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
    expect(accumulationThresholdForResolution(-1)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
    expect(accumulationThresholdForResolution(Number.NaN)).toBe(
      ACCUMULATION_THRESHOLD_BASE_CELLS,
    );
  });
});
