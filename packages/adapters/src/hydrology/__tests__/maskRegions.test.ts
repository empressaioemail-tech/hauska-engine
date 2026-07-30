import { describe, expect, it } from "vitest";

import {
  MAX_REGIONS,
  MAX_VERTICES_PER_RING,
  MIN_REGION_AREA_CELLS,
  maskArrayToDissolvedGeoJson,
  maskToRegions,
  signedArea,
  simplifyRing,
  smoothRing,
  traceMaskRings,
} from "../maskRegions.js";

/**
 * The regression these tests lock: both mask-to-GeoJSON converters used to
 * emit ONE SMALL AXIS-ALIGNED SQUARE per subsampled grid cell (the blue
 * checkerboard). Every assertion here is a mechanical signature that the
 * output is a TRACED, DISSOLVED region rather than a lattice of squares.
 */

const BBOX = { westLng: -97.7, southLat: 30.5, eastLng: -97.6, northLat: 30.6 };

function blockMask(
  width: number,
  height: number,
  hit: (col: number, row: number) => boolean,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (hit(col, row)) mask[row * width + col] = 1;
    }
  }
  return mask;
}

describe("maskToRegions — dissolve", () => {
  it("dissolves a solid block into ONE polygon, not N squares", () => {
    const W = 40;
    const H = 40;
    // 400 contiguous cells. The OLD converter at step = 40/12 = 3 would have
    // emitted ~49 disjoint squares for this block.
    const mask = blockMask(W, H, (c, r) => c >= 10 && c < 30 && r >= 10 && r < 30);
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBe(1);
    expect(regions[0]!.rings.length).toBe(1);
    // FAR fewer features than cells — the whole point of dissolving.
    expect(regions.length).toBeLessThan(400 / 50);
  });

  it("keeps disjoint regions separate — dissolve is not a merge-everything", () => {
    const W = 60;
    const H = 60;
    const mask = blockMask(
      W,
      H,
      (c, r) =>
        (c >= 5 && c < 15 && r >= 5 && r < 15) ||
        (c >= 40 && c < 50 && r >= 40 && r < 50),
    );
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBe(2);
  });

  it("emits an interior ring (hole) where the mask has a hole", () => {
    const W = 40;
    const H = 40;
    const mask = blockMask(
      W,
      H,
      (c, r) =>
        c >= 8 && c < 32 && r >= 8 && r < 32 && !(c >= 16 && c < 24 && r >= 16 && r < 24),
    );
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBe(1);
    // Shell + one hole ring.
    expect(regions[0]!.rings.length).toBe(2);
    // Net area is shell minus hole: 24² − 8² = 512 cells.
    expect(regions[0]!.areaCells).toBeGreaterThan(505);
    expect(regions[0]!.areaCells).toBeLessThan(515);
  });

  it("traces regions that touch the grid edge without leaking", () => {
    const W = 30;
    const H = 30;
    const mask = blockMask(W, H, (_c, r) => r < 10); // 300 cells along the north edge
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBe(1);
    expect(regions[0]!.areaCells).toBeGreaterThan(295);
    expect(regions[0]!.areaCells).toBeLessThan(301);
  });
});

describe("maskToRegions — no axis-aligned-square signature", () => {
  it("a solid DISC traces as a curved boundary, not a lattice of squares", () => {
    const W = 60;
    const H = 60;
    const R = 20;
    const mask = blockMask(W, H, (c, r) => Math.hypot(c - 30, r - 30) < R);
    const trueCells = mask.reduce((n, v) => n + v, 0);

    const fc = maskArrayToDissolvedGeoJson(mask, W, H, BBOX, { zone: "test" });
    expect(fc.features.length).toBe(1);
    const ring = fc.features[0]!.geometry.coordinates[0]!;

    // 1) A traced curve carries many vertices; a single grid square carries 5.
    expect(ring.length).toBeGreaterThan(20);

    // 2) BBOX-FILL RATIO. A disc fills pi/4 ≈ 0.785 of its bounding box; an
    // axis-aligned square (or a lattice of them covering the same extent)
    // fills ~1.0. This is the checkerboard's fingerprint.
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const bboxArea =
      (Math.max(...lngs) - Math.min(...lngs)) * (Math.max(...lats) - Math.min(...lats));
    let shoelace = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      shoelace += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
    }
    const fill = Math.abs(shoelace / 2) / bboxArea;
    expect(fill).toBeGreaterThan(0.7);
    expect(fill).toBeLessThan(0.85);

    // 3) Not every edge is axis-aligned — a lattice output has ONLY
    // axis-aligned edges.
    let diagonal = 0;
    for (let i = 1; i < ring.length; i++) {
      const dx = Math.abs(ring[i]![0] - ring[i - 1]![0]);
      const dy = Math.abs(ring[i]![1] - ring[i - 1]![1]);
      if (dx > 1e-9 && dy > 1e-9) diagonal++;
    }
    expect(diagonal).toBeGreaterThan(ring.length / 2);

    // 4) AREA HONESTY: the traced area matches the true masked cell count
    // (within the documented sub-cell corner-rounding loss), so the headline
    // area stats derived from this geometry are the real masked area.
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions[0]!.areaCells).toBeGreaterThan(trueCells * 0.99);
    expect(regions[0]!.areaCells).toBeLessThanOrEqual(trueCells);
  });

  it("traced area of a solid block equals the true cell count within one cell", () => {
    const W = 40;
    const H = 40;
    const mask = blockMask(W, H, (c, r) => c >= 10 && c < 30 && r >= 10 && r < 30);
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    // 400 true cells; the old subsampled emitter over-or-under-counted badly.
    expect(Math.abs(regions[0]!.areaCells - 400)).toBeLessThan(1);
  });
});

describe("maskToRegions — speck filter and caps", () => {
  it("drops sub-threshold specks", () => {
    const W = 60;
    const H = 60;
    const mask = blockMask(W, H, (c, r) => c >= 5 && c < 15 && r >= 5 && r < 15);
    mask[30 * W + 30] = 1; // 1-cell speck
    mask[35 * W + 35] = 1; // another
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBe(1);
    expect(regions[0]!.areaCells).toBeGreaterThan(95);
  });

  it("honours the minimum-area threshold as configured", () => {
    const W = 20;
    const H = 20;
    // A 3x3 = 9-cell region clears the 4-cell library default.
    const mask = blockMask(W, H, (c, r) => c >= 5 && c < 8 && r >= 5 && r < 8);
    expect(maskToRegions((c, r) => mask[r * W + c] === 1, W, H).length).toBe(1);
    expect(
      maskToRegions((c, r) => mask[r * W + c] === 1, W, H, {
        minRegionAreaCells: MIN_REGION_AREA_CELLS + 20,
      }).length,
    ).toBe(0);
    // A single cell is a speck under the library default but survives the
    // DELINEATED floor the catchment/ponding layers use (a real parcel
    // catchment on a coarse DEM can be one cell; zeroing it would lie).
    const speck = new Uint8Array(W * H);
    speck[10 * W + 10] = 1;
    expect(maskToRegions((c, r) => speck[r * W + c] === 1, W, H).length).toBe(0);
    expect(
      maskToRegions((c, r) => speck[r * W + c] === 1, W, H, {
        minRegionAreaCells: 1,
      }).length,
    ).toBe(1);
  });

  it("caps the feature count and the vertices per ring", () => {
    const W = 200;
    const H = 200;
    // A grid of many separate 4x4 blocks — far more regions than MAX_REGIONS.
    const mask = blockMask(W, H, (c, r) => c % 8 < 4 && r % 8 < 4);
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(regions.length).toBeLessThanOrEqual(MAX_REGIONS);

    const wiggly = blockMask(W, H, (c, r) => Math.hypot(c - 100, r - 100) < 90);
    const capped = maskToRegions((c, r) => wiggly[r * W + c] === 1, W, H, {
      maxVerticesPerRing: 24,
    });
    for (const region of capped) {
      for (const ring of region.rings) {
        expect(ring.length).toBeLessThanOrEqual(25); // 24 + closure
      }
    }
    const uncapped = maskToRegions((c, r) => wiggly[r * W + c] === 1, W, H);
    for (const region of uncapped) {
      for (const ring of region.rings) {
        expect(ring.length).toBeLessThanOrEqual(MAX_VERTICES_PER_RING + 1);
      }
    }
  });

  it("returns an empty collection for an empty mask — never a fabricated region", () => {
    const W = 20;
    const H = 20;
    const mask = new Uint8Array(W * H);
    const fc = maskArrayToDissolvedGeoJson(mask, W, H, BBOX, {});
    expect(fc.features.length).toBe(0);
  });
});

describe("simplify + smooth honesty bound", () => {
  it("no smoothed vertex moves more than the documented tolerance from the traced boundary", () => {
    const W = 60;
    const H = 60;
    // A diagonal wedge: the worst case for a staircase boundary.
    const mask = blockMask(W, H, (c, r) => c > 10 && r > 10 && c + r < 70);
    // The unrefined cell-edge trace IS the true boundary — every candidate
    // vertex is measured against it.
    const raw = traceMaskRings((c, r) => mask[r * W + c] === 1, W, H);
    const refined = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(raw.length).toBe(1);
    expect(refined.length).toBe(1);

    const trueRing = raw[0]!.points;
    const distToTrueBoundary = (p: [number, number]): number => {
      let best = Infinity;
      for (let i = 1; i < trueRing.length; i++) {
        const a = trueRing[i - 1]!;
        const b = trueRing[i]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
      }
      return best;
    };
    // DOCUMENTED TOLERANCE: simplify 0.5 cells + bounded smoothing 0.5 cells,
    // so no vertex sits more than ~1 mask cell off the real boundary.
    for (const p of refined[0]!.rings[0]!) {
      expect(distToTrueBoundary(p)).toBeLessThanOrEqual(1.0);
    }
    // And the SIMPLIFICATION genuinely reduces the raw staircase (Chaikin
    // then doubles the surviving vertices, so compare pre-smoothing).
    const simplifiedOnly = maskToRegions((c, r) => mask[r * W + c] === 1, W, H, {
      smoothingPasses: 0,
    });
    expect(simplifiedOnly[0]!.rings[0]!.length).toBeLessThan(trueRing.length);
  });

  it("collapses long straight runs — a 400-cell block is not 80 traced edges", () => {
    const W = 40;
    const H = 40;
    const mask = blockMask(W, H, (c, r) => c >= 10 && c < 30 && r >= 10 && r < 30);
    // The raw cell-edge trace of a 20x20 block is 80 unit segments.
    const raw = traceMaskRings((c, r) => mask[r * W + c] === 1, W, H);
    expect(raw[0]!.points.length).toBeGreaterThan(70);
    // Simplified: four corners plus closure.
    const simplified = maskToRegions((c, r) => mask[r * W + c] === 1, W, H, {
      smoothingPasses: 0,
    });
    expect(simplified[0]!.rings[0]!.length).toBeLessThanOrEqual(6);
  });

  it("smoothing never DILATES a region beyond the mask", () => {
    const W = 40;
    const H = 40;
    const mask = blockMask(W, H, (c, r) => c >= 10 && c < 30 && r >= 10 && r < 30);
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    for (const p of regions[0]!.rings[0]!) {
      expect(p[0]).toBeGreaterThanOrEqual(10);
      expect(p[0]).toBeLessThanOrEqual(30);
      expect(p[1]).toBeGreaterThanOrEqual(10);
      expect(p[1]).toBeLessThanOrEqual(30);
    }
    // Corner rounding can only REMOVE area, never add it.
    expect(regions[0]!.areaCells).toBeLessThanOrEqual(400);
  });

  it("simplifyRing collapses a straight staircase, smoothRing keeps closure", () => {
    const stair: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) {
      stair.push([i, 0], [i, 0]);
    }
    stair.push([0, 0]);
    const simplified = simplifyRing(
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
      0.5,
    );
    expect(simplified.length).toBeLessThan(7);
    const smoothed = smoothRing(simplified);
    expect(smoothed[0]).toEqual(smoothed[smoothed.length - 1]);
  });

  it("signedArea is positive for a shell and negative for a hole ring", () => {
    const W = 40;
    const H = 40;
    const mask = blockMask(
      W,
      H,
      (c, r) =>
        c >= 8 && c < 32 && r >= 8 && r < 32 && !(c >= 16 && c < 24 && r >= 16 && r < 24),
    );
    const regions = maskToRegions((c, r) => mask[r * W + c] === 1, W, H);
    expect(signedArea(regions[0]!.rings[0]!)).toBeGreaterThan(0);
    expect(signedArea(regions[0]!.rings[1]!)).toBeLessThan(0);
  });
});

describe("maskArrayToDissolvedGeoJson — WGS84 projection", () => {
  it("maps grid space onto the bbox with the standard hydrology convention", () => {
    const W = 20;
    const H = 20;
    const mask = blockMask(W, H, () => true); // whole grid
    const fc = maskArrayToDissolvedGeoJson(mask, W, H, BBOX, { zone: "catchment" });
    expect(fc.features.length).toBe(1);
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    // The full-grid region spans the whole bbox (corner rounding aside).
    expect(Math.min(...lngs)).toBeGreaterThanOrEqual(BBOX.westLng - 1e-9);
    expect(Math.max(...lngs)).toBeLessThanOrEqual(BBOX.eastLng + 1e-9);
    expect(Math.min(...lats)).toBeGreaterThanOrEqual(BBOX.southLat - 1e-9);
    expect(Math.max(...lats)).toBeLessThanOrEqual(BBOX.northLat + 1e-9);
    expect(fc.features[0]!.properties).toMatchObject({ zone: "catchment" });
  });
});
