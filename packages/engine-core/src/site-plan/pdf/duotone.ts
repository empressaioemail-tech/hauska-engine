import { PNG } from "pngjs";

/**
 * SHEET STANDARD v1.0 §20 · DUOTONE: the aerial raster passes through the
 * duotone treatment so it desaturates into the ONE accent hue — never full
 * colour, never a second hue. This reproduces the Industry token sheet's
 * `.duotone` recipe (`mix-blend-mode: color` with the accent over the image):
 * each pixel keeps its own luminance and takes the accent's hue + saturation.
 *
 * Implemented with pngjs (pure JS, no native build) so the engine can decode
 * the Esri export PNG, remap pixels, and re-encode for pdf-lib embedding.
 * Nothing is burned into the raster — overlay marks stay vector (§20).
 */

export interface RgbUnit {
  r: number;
  g: number;
  b: number;
}

function rgbToHsl(c: RgbUnit): { h: number; s: number; l: number } {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6 : 0)) / 6;
  else if (max === c.g) h = ((c.b - c.r) / d + 2) / 6;
  else h = ((c.r - c.g) / d + 4) / 6;
  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): RgbUnit {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3),
    g: hueToRgb(p, q, h),
    b: hueToRgb(p, q, h - 1 / 3),
  };
}

/**
 * Duotones a PNG into the accent hue: per-pixel luminance (Rec. 709 weights)
 * carried into HSL lightness under the accent's hue + saturation. Alpha is
 * preserved. Throws on undecodable bytes — callers degrade honestly.
 */
export function duotonePngIntoAccent(pngBytes: Uint8Array, accent: RgbUnit): Uint8Array {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  const { h, s } = rgbToHsl(accent);
  const data = png.data;
  // Precompute the 256-step lightness → RGB ramp (single hue, single sat).
  const ramp = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = hslToRgb(h, s, i / 255);
    ramp[i * 3] = Math.round(c.r * 255);
    ramp[i * 3 + 1] = Math.round(c.g * 255);
    ramp[i * 3 + 2] = Math.round(c.b * 255);
  }
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.min(
      255,
      Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!),
    );
    data[i] = ramp[lum * 3]!;
    data[i + 1] = ramp[lum * 3 + 1]!;
    data[i + 2] = ramp[lum * 3 + 2]!;
  }
  return new Uint8Array(PNG.sync.write(png));
}
