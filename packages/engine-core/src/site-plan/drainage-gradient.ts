import { PNG } from "pngjs";

import type { BboxWgs84 } from "@hauska-engine/adapters";

/**
 * WATER GRADIENT raster (2026-07-29, Flood & Drainage v2 — the 10x core).
 *
 * Colorizes the modeled drainage field into ONE transparent-background PNG
 * that reads as water: concentrated flow and modeled ponding blended into a
 * smooth blue ramp with depth/intensity-graded alpha. The SAME raster
 * renders on the customer map (PE leg drapes it by its WGS84 bbox) and
 * composites onto the PDF sheet over the aerial imagery — one artifact,
 * every surface.
 *
 * PINNED CONTRACT (the PE leg codes to this):
 *
 *   gradient: {
 *     pngBase64: string,
 *     bbox: { westLng, southLat, eastLng, northLat },
 *     note: string,
 *   }
 *
 * HONESTY: the gradient derives ONLY from the computed D8 field (flow
 * accumulation) and the SAME ponding proxy the study's rainfall model uses
 * over the same DEM. Cells with no modeled water are FULLY transparent;
 * nothing is painted outside the modeled area. The note records the DEM
 * resolution and the design storm. It is a visualization aid, never a
 * measurement source.
 *
 * ORIENTATION: PNG row 0 = the bbox's NORTH edge (standard raster order,
 * matching the DEM grid the study parses).
 */

export interface FloodDrainageGradient {
  /** Transparent-background RGBA PNG, base64 (no data-URI prefix). */
  pngBase64: string;
  /** WGS84 bbox the raster maps onto (the padded catchment bbox). */
  bbox: BboxWgs84;
  /** Provenance sentence: derivation, DEM resolution, design storm. */
  note: string;
}

/** Longest raster axis cap (px) — keeps the payload map-friendly. */
export const GRADIENT_MAX_AXIS_PX = 640;

/**
 * Ponding weight in the blended intensity field: relative pond depth
 * contributes at most this much intensity, so broad shallow ponding reads
 * as a light wash while concentrated flow (channel cores) owns the deep
 * saturated end of the ramp.
 */
export const GRADIENT_POND_WEIGHT = 0.35;

/** Ponding floor from the native rainfall proxy: depths under 5 mm are not
 * modeled standing water and stay transparent. */
export const GRADIENT_POND_FLOOR_M = 0.005;

/** Intensity floor: cells below this stay FULLY transparent (outside the
 * modeled water field). */
export const GRADIENT_INTENSITY_FLOOR = 0.02;

/**
 * THE WATER RAMP — one blue family (hue ≈ 210°), light desaturated sheet
 * flow into deep saturated ponding/channel cores. Alpha grades with the
 * same axis so thin water is faint and deep water is emphatic. Stops are
 * interpolated linearly in RGB + alpha; alpha is monotonic non-decreasing
 * in intensity (tested).
 */
export const GRADIENT_RAMP_STOPS: ReadonlyArray<{
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
}> = [
  { t: 0.0, r: 0xd6, g: 0xe9, b: 0xf7, a: 0.0 }, // transparent toe (same hue)
  { t: 0.12, r: 0xd6, g: 0xe9, b: 0xf7, a: 0.14 }, // faint sheet flow
  { t: 0.35, r: 0xa8, g: 0xd0, b: 0xec, a: 0.34 }, // shallow wash
  { t: 0.6, r: 0x5e, g: 0x9d, b: 0xd1, a: 0.56 }, // gathering flow
  { t: 0.85, r: 0x2f, g: 0x6f, b: 0xae, a: 0.76 }, // strong channel
  { t: 1.0, r: 0x1b, g: 0x4e, b: 0x86, a: 0.9 }, // deep saturated core
];

/** Ramp lookup: intensity t (0..1) → RGBA (a in 0..1). Exported for tests. */
export function gradientRampColor(t: number): { r: number; g: number; b: number; a: number } {
  const x = Math.min(1, Math.max(0, t));
  const stops = GRADIENT_RAMP_STOPS;
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1]!;
    const hi = stops[i]!;
    if (x <= hi.t) {
      const span = hi.t - lo.t || 1;
      const f = (x - lo.t) / span;
      return {
        r: Math.round(lo.r + (hi.r - lo.r) * f),
        g: Math.round(lo.g + (hi.g - lo.g) * f),
        b: Math.round(lo.b + (hi.b - lo.b) * f),
        a: lo.a + (hi.a - lo.a) * f,
      };
    }
  }
  const last = stops[stops.length - 1]!;
  return { r: last.r, g: last.g, b: last.b, a: last.a };
}

export interface BuildDrainageGradientOptions {
  /** Row-major elevation grid (NaN = nodata), row 0 = north. */
  elevation: Float32Array;
  width: number;
  height: number;
  /** D8 flow accumulation for the SAME grid (cells of upstream flow). */
  accumulation: Uint32Array;
  /** The WGS84 bbox the grid maps (the padded catchment bbox). */
  bbox: BboxWgs84;
  /** Design-storm depth in mm (drives the ponding component + the note). */
  rainfallDepthMm: number;
  /** For the note. */
  demResolutionMeters: number;
  rainfallDepthInches: number;
}

/**
 * Blended intensity field, exported for tests:
 *
 *   f  = log1p(acc) / log1p(maxAcc)        — concentrated-flow intensity
 *   pd = pondDepth / rainfallDepth          — relative modeled pond depth
 *        (native proxy: rainfall × min(1, 10/acc), 5 mm floor)
 *   intensity = max(f, POND_WEIGHT × pd)
 *
 * NaN-elevation cells are NaN (no support → transparent, always).
 */
export function computeGradientIntensity(
  options: Pick<
    BuildDrainageGradientOptions,
    "elevation" | "width" | "height" | "accumulation" | "rainfallDepthMm"
  >,
): { intensity: Float32Array; maxAccumulation: number } {
  const { elevation, width, height, accumulation, rainfallDepthMm } = options;
  const n = width * height;
  let maxAcc = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(elevation[i]!)) continue;
    if (accumulation[i]! > maxAcc) maxAcc = accumulation[i]!;
  }
  const intensity = new Float32Array(n);
  const logMax = Math.log1p(maxAcc);
  const rainfallM = rainfallDepthMm / 1000;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(elevation[i]!)) {
      intensity[i] = Number.NaN;
      continue;
    }
    const acc = accumulation[i]!;
    const flow = logMax > 0 ? Math.log1p(acc) / logMax : 0;
    let pond = 0;
    if (rainfallM > 0 && acc > 0) {
      const pondDepthM = rainfallM * Math.min(1, (1 / acc) * 10);
      if (pondDepthM > GRADIENT_POND_FLOOR_M) pond = pondDepthM / rainfallM;
    }
    intensity[i] = Math.max(flow, GRADIENT_POND_WEIGHT * pond);
  }
  return { intensity, maxAccumulation: maxAcc };
}

/** Mask-aware block-average downsample to fit the longest-axis cap. */
export function downsampleIntensity(
  intensity: Float32Array,
  width: number,
  height: number,
  maxAxisPx: number = GRADIENT_MAX_AXIS_PX,
): { intensity: Float32Array; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxAxisPx) return { intensity, width, height };
  const scale = maxAxisPx / longest;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy / outH) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) / outH) * height));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox / outW) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) / outW) * width));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = intensity[y * width + x]!;
          if (!Number.isFinite(v)) continue;
          sum += v;
          count++;
        }
      }
      out[oy * outW + ox] = count > 0 ? sum / count : Number.NaN;
    }
  }
  return { intensity: out, width: outW, height: outH };
}

/**
 * One 3×3 binomial blur pass ((1,2,1)² / 16) — the soft-edge feather. The
 * blur runs on the zero-filled field so edges feather smoothly; cells with
 * no blurred signal stay at 0 → transparent.
 */
export function featherIntensity(
  intensity: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const zeroed = new Float32Array(intensity.length);
  for (let i = 0; i < intensity.length; i++) {
    zeroed[i] = Number.isFinite(intensity[i]!) ? intensity[i]! : 0;
  }
  const out = new Float32Array(intensity.length);
  const k = [1, 2, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const w = k[dy + 1]! * k[dx + 1]!;
          sum += zeroed[yy * width + xx]! * w;
          wsum += w;
        }
      }
      out[y * width + x] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return out;
}

function buildGradientNote(options: BuildDrainageGradientOptions): string {
  return (
    "Modeled water gradient derived from D8 flow accumulation with modeled ponding, " +
    `blended and alpha graded, over the USGS 3DEP elevation model at ${options.demResolutionMeters} m per pixel. ` +
    `Design storm ${options.rainfallDepthInches} inch, 100-yr 24-hr. ` +
    "Visualization aid, not a measurement source."
  );
}

/**
 * Build the water-gradient raster from the computed D8 field. Returns null
 * when the field is degenerate (no finite cells, or no accumulated flow at
 * all) — an absent gradient is honest; a fabricated one never ships.
 */
export function buildDrainageGradient(
  options: BuildDrainageGradientOptions,
): FloodDrainageGradient | null {
  const { width, height } = options;
  if (width < 2 || height < 2) return null;
  const { intensity, maxAccumulation } = computeGradientIntensity(options);
  if (maxAccumulation < 1) return null;

  const scaled = downsampleIntensity(intensity, width, height);
  const feathered = featherIntensity(scaled.intensity, scaled.width, scaled.height);

  let anyVisible = false;
  const png = new PNG({ width: scaled.width, height: scaled.height });
  for (let i = 0; i < feathered.length; i++) {
    const t = feathered[i]!;
    const o = i * 4;
    if (!Number.isFinite(t) || t < GRADIENT_INTENSITY_FLOOR) {
      png.data[o] = 0;
      png.data[o + 1] = 0;
      png.data[o + 2] = 0;
      png.data[o + 3] = 0;
      continue;
    }
    const c = gradientRampColor(t);
    png.data[o] = c.r;
    png.data[o + 1] = c.g;
    png.data[o + 2] = c.b;
    png.data[o + 3] = Math.round(c.a * 255);
    if (png.data[o + 3]! > 0) anyVisible = true;
  }
  if (!anyVisible) return null;

  const bytes = PNG.sync.write(png);
  return {
    pngBase64: bytes.toString("base64"),
    bbox: options.bbox,
    note: buildGradientNote(options),
  };
}
