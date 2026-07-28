import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { duotonePngIntoAccent } from "../duotone.js";

/**
 * SHEET STANDARD §20: imagery desaturates into the ONE accent hue — never
 * full colour, never a second hue. The duotone maps per-pixel luminance into
 * the accent's hue+saturation (the token sheet's `.duotone` recipe).
 */

const ACCENT = { r: 89 / 255, g: 128 / 255, b: 166 / 255 }; // --color-accent #5980a6

function makePng(pixels: Array<[number, number, number, number]>, width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  pixels.forEach(([r, g, b, a], i) => {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = a;
  });
  return new Uint8Array(PNG.sync.write(png));
}

function hueOf(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null; // achromatic
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h;
}

describe("duotonePngIntoAccent (§20)", () => {
  it("maps every chromatic pixel onto the accent hue — no second hue survives", () => {
    const src = makePng(
      [
        [255, 0, 0, 255], // red
        [0, 255, 0, 255], // green
        [0, 0, 255, 255], // blue
        [255, 255, 0, 255], // yellow
      ],
      2,
      2,
    );
    const out = PNG.sync.read(Buffer.from(duotonePngIntoAccent(src, ACCENT)));
    const accentHue = hueOf(ACCENT.r, ACCENT.g, ACCENT.b)!;
    for (let i = 0; i < 4; i++) {
      const r = out.data[i * 4]! / 255;
      const g = out.data[i * 4 + 1]! / 255;
      const b = out.data[i * 4 + 2]! / 255;
      const h = hueOf(r, g, b);
      if (h !== null) {
        expect(Math.abs(h - accentHue)).toBeLessThan(0.02);
      }
      expect(out.data[i * 4 + 3]).toBe(255); // alpha preserved
    }
  });

  it("keeps the luminance ordering of the source (darker stays darker)", () => {
    const src = makePng(
      [
        [10, 10, 10, 255],
        [240, 240, 240, 255],
      ],
      2,
      1,
    );
    const out = PNG.sync.read(Buffer.from(duotonePngIntoAccent(src, ACCENT)));
    const lum = (i: number) =>
      0.2126 * out.data[i * 4]! + 0.7152 * out.data[i * 4 + 1]! + 0.0722 * out.data[i * 4 + 2]!;
    expect(lum(0)).toBeLessThan(lum(1));
  });

  it("throws on undecodable bytes (caller degrades honestly, never fails the export)", () => {
    expect(() => duotonePngIntoAccent(new TextEncoder().encode("not a png"), ACCENT)).toThrow();
  });
});
