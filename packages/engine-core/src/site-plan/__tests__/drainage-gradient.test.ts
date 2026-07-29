import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { computeD8Field } from "@hauska-engine/adapters/hydrology";

import {
  GRADIENT_INTENSITY_FLOOR,
  GRADIENT_MAX_AXIS_PX,
  GRADIENT_RAMP_STOPS,
  buildDrainageGradient,
  computeGradientIntensity,
  downsampleIntensity,
  gradientRampColor,
} from "../drainage-gradient.js";

const bbox = { westLng: -97.33, southLat: 30.09, eastLng: -97.31, northLat: 30.11 };

/** Valley DEM: flow converges into a fixed column and drains south. */
function valleyDem(width: number, height: number, valleyCol: number): Float32Array {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = Math.abs(col - valleyCol) * 2 + (height - row) * 0.5;
    }
  }
  return values;
}

function decodeGradientPng(pngBase64: string): PNG {
  return PNG.sync.read(Buffer.from(pngBase64, "base64"));
}

describe("gradientRampColor", () => {
  it("stays inside ONE blue family with alpha monotonic non-decreasing in intensity", () => {
    let prevAlpha = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const c = gradientRampColor(t);
      // Blue family: the blue channel dominates red at every stop (water
      // reads as water — never a second hue).
      expect(c.b).toBeGreaterThan(c.r);
      expect(c.a).toBeGreaterThanOrEqual(prevAlpha - 1e-9);
      prevAlpha = c.a;
    }
    // Deep end is saturated and dark; toe is light and faint.
    expect(gradientRampColor(1).a).toBeGreaterThan(0.8);
    expect(gradientRampColor(0).a).toBe(0);
    expect(gradientRampColor(1).b).toBeLessThan(gradientRampColor(0.12).b);
    // Documented stops are themselves monotonic in t.
    for (let i = 1; i < GRADIENT_RAMP_STOPS.length; i++) {
      expect(GRADIENT_RAMP_STOPS[i]!.t).toBeGreaterThan(GRADIENT_RAMP_STOPS[i - 1]!.t);
      expect(GRADIENT_RAMP_STOPS[i]!.a).toBeGreaterThanOrEqual(GRADIENT_RAMP_STOPS[i - 1]!.a);
    }
  });
});

describe("computeGradientIntensity", () => {
  it("derives intensity from the REAL D8 field: channel cells outrank sheet flow; nodata cells are NaN", () => {
    const W = 32;
    const H = 32;
    const elevation = valleyDem(W, H, 16);
    // A nodata pocket in the corner.
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) elevation[row * W + col] = Number.NaN;
    }
    const d8 = computeD8Field(elevation, W, H);
    const { intensity, maxAccumulation } = computeGradientIntensity({
      elevation,
      width: W,
      height: H,
      accumulation: d8.accumulation,
      rainfallDepthMm: 241,
    });
    expect(maxAccumulation).toBeGreaterThan(10);
    // The valley bottom (max accumulation) carries the highest intensity.
    let maxI = 0;
    let maxIdx = 0;
    for (let i = 0; i < intensity.length; i++) {
      if (Number.isFinite(intensity[i]!) && intensity[i]! > maxI) {
        maxI = intensity[i]!;
        maxIdx = i;
      }
    }
    expect(maxI).toBeCloseTo(1, 5);
    expect(Math.abs((maxIdx % W) - 16)).toBeLessThanOrEqual(1);
    // Nodata cells carry NaN (never painted).
    expect(Number.isNaN(intensity[0]!)).toBe(true);
  });
});

describe("downsampleIntensity", () => {
  it("caps the longest axis at the documented limit with mask-aware averaging", () => {
    const W = 1500;
    const H = 300;
    const field = new Float32Array(W * H).fill(0.5);
    const out = downsampleIntensity(field, W, H);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(GRADIENT_MAX_AXIS_PX);
    expect(out.intensity[Math.floor(out.intensity.length / 2)]!).toBeCloseTo(0.5, 5);
  });

  it("passes small grids through untouched", () => {
    const field = new Float32Array(24 * 24).fill(0.25);
    const out = downsampleIntensity(field, 24, 24);
    expect(out.width).toBe(24);
    expect(out.height).toBe(24);
  });
});

describe("buildDrainageGradient", () => {
  const W = 48;
  const H = 48;

  function build(elevation: Float32Array) {
    const d8 = computeD8Field(elevation, W, H);
    return buildDrainageGradient({
      elevation,
      width: W,
      height: H,
      accumulation: d8.accumulation,
      bbox,
      rainfallDepthMm: 241,
      demResolutionMeters: 10,
      rainfallDepthInches: 9.5,
    });
  }

  it("emits the PINNED gradient contract: pngBase64 + WGS84 bbox + provenance note", () => {
    const gradient = build(valleyDem(W, H, 24));
    expect(gradient).not.toBeNull();
    // THE PINNED CONTRACT SHAPE (the PE leg codes to this).
    expect(gradient).toMatchObject({
      pngBase64: expect.any(String),
      bbox: {
        westLng: bbox.westLng,
        southLat: bbox.southLat,
        eastLng: bbox.eastLng,
        northLat: bbox.northLat,
      },
      note: expect.any(String),
    });
    // The note records DEM resolution + design storm, and the honesty line.
    expect(gradient!.note).toContain("10 m per pixel");
    expect(gradient!.note).toContain("9.5 inch");
    expect(gradient!.note).toContain("not a measurement source");
  });

  it("encodes a TRANSPARENT-background PNG: alpha 0 on nodata + below-floor cells, visible water elsewhere", () => {
    const elevation = valleyDem(W, H, 24);
    // Nodata block well away from the valley — must stay fully transparent
    // even after the feather pass.
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) elevation[row * W + col] = Number.NaN;
    }
    const gradient = build(elevation);
    expect(gradient).not.toBeNull();
    const png = decodeGradientPng(gradient!.pngBase64);
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(GRADIENT_MAX_AXIS_PX);
    // The nodata pocket's interior pixel is fully transparent.
    const nodataIdx = (2 * png.width + 2) * 4;
    expect(png.data[nodataIdx + 3]).toBe(0);
    // The valley column carries visible saturated water.
    let maxAlpha = 0;
    let visible = 0;
    let total = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const a = png.data[i * 4 + 3]!;
      total++;
      if (a > 0) visible++;
      if (a > maxAlpha) maxAlpha = a;
    }
    // Deep saturated core — the feather pass softens a one-cell channel,
    // so the decoded peak sits below the raw ramp max but well above the
    // sheet-flow band.
    expect(maxAlpha).toBeGreaterThan(120);
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(total); // NOTHING painted outside the model
    // Every painted pixel stays in the blue family.
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      if (png.data[o + 3]! > 0) {
        expect(png.data[o + 2]!).toBeGreaterThanOrEqual(png.data[o]!);
      }
    }
  });

  it("caps the longest axis at 640 px", () => {
    const bigW = 800;
    const bigH = 200;
    const elevation = new Float32Array(bigW * bigH);
    for (let row = 0; row < bigH; row++) {
      for (let col = 0; col < bigW; col++) {
        elevation[row * bigW + col] = Math.abs(col - 400) * 2 + (bigH - row) * 0.5;
      }
    }
    const d8 = computeD8Field(elevation, bigW, bigH);
    const gradient = buildDrainageGradient({
      elevation,
      width: bigW,
      height: bigH,
      accumulation: d8.accumulation,
      bbox,
      rainfallDepthMm: 241,
      demResolutionMeters: 10,
      rainfallDepthInches: 9.5,
    });
    expect(gradient).not.toBeNull();
    const png = decodeGradientPng(gradient!.pngBase64);
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(GRADIENT_MAX_AXIS_PX);
  });

  it("returns null on a degenerate field (all nodata) — an absent gradient is honest, a fabricated one never ships", () => {
    const elevation = new Float32Array(W * H).fill(Number.NaN);
    const gradient = build(elevation);
    expect(gradient).toBeNull();
  });

  it("keeps the intensity floor meaningful: floor sits above zero and below the first visible stop", () => {
    expect(GRADIENT_INTENSITY_FLOOR).toBeGreaterThan(0);
    expect(GRADIENT_INTENSITY_FLOOR).toBeLessThan(GRADIENT_RAMP_STOPS[1]!.t);
  });
});
