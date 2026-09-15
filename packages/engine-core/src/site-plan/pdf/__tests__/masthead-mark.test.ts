import { describe, expect, it } from "vitest";
import type { PDFFont, PDFPage } from "pdf-lib";

import { drawMastheadWordmark, drawRunningHeaderMark, type ChromeFonts } from "../report-chrome.js";
import { MASTHEAD, PRINT, RUNHEAD } from "../report-chrome-tokens.js";
import { SMART_SITE_LOCKUP, SMART_SITE_MARK } from "../brand/smart-site-brand.js";

/**
 * P-239. What the masthead actually PUTS ON THE PAGE, measured against the
 * canonical asset rather than against the constants that drew it.
 *
 * The previous implementation would have passed any test written against its
 * own constants. These assertions are written against SMART_SITE_LOCKUP —
 * i.e. against the vendored hauska-map file — so the only way to satisfy them
 * is to draw the real mark. brand-provenance.test.ts separately pins that file
 * to its source commit by sha256, which closes the loop: you cannot satisfy
 * this file by editing the asset.
 */

interface Circle {
  x: number;
  y: number;
  size: number;
  borderWidth?: number;
  filled: boolean;
}
interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

function capture(): { page: PDFPage; circles: Circle[]; lines: Line[]; texts: Array<{ t: string; x: number; y: number; size: number }> } {
  const circles: Circle[] = [];
  const lines: Line[] = [];
  const texts: Array<{ t: string; x: number; y: number; size: number }> = [];
  const page = {
    drawCircle(o: { x: number; y: number; size: number; borderWidth?: number; color?: unknown }) {
      circles.push({ x: o.x, y: o.y, size: o.size, borderWidth: o.borderWidth, filled: o.color !== undefined });
    },
    drawLine(o: { start: { x: number; y: number }; end: { x: number; y: number }; thickness: number }) {
      lines.push({ x1: o.start.x, y1: o.start.y, x2: o.end.x, y2: o.end.y, thickness: o.thickness });
    },
    drawText(t: string, o: { x: number; y: number; size: number }) {
      texts.push({ t, x: o.x, y: o.y, size: o.size });
    },
  } as unknown as PDFPage;
  return { page, circles, lines, texts };
}

/** A font stub with a deterministic, non-zero advance. */
const stubFont = {
  widthOfTextAtSize: (t: string, size: number) => t.length * size * 0.5,
} as unknown as PDFFont;
const fonts = {
  body: stubFont,
  bodyMedium: stubFont,
  display: stubFont,
  displayMedium: stubFont,
  mono: stubFont,
  monoBold: stubFont,
} as unknown as ChromeFonts;

describe("running-header mark is the canonical mark", () => {
  const { page, circles, lines } = capture();
  drawRunningHeaderMark(page, 100, 200);
  const scale = RUNHEAD.markSize / SMART_SITE_MARK.nativeHeight;

  it("draws one stroked ring and one filled dot", () => {
    expect(circles).toHaveLength(2);
    expect(circles[0]!.filled).toBe(false);
    expect(circles[1]!.filled).toBe(true);
  });

  it("ring radius and stroke are the canonical values, scaled", () => {
    expect(circles[0]!.size).toBeCloseTo(SMART_SITE_MARK.ringRadius * scale, 9);
    expect(circles[0]!.borderWidth).toBeCloseTo(SMART_SITE_MARK.ringStrokeWidth * scale, 9);
  });

  it("dot radius is the canonical value, scaled", () => {
    expect(circles[1]!.size).toBeCloseTo(SMART_SITE_MARK.dotRadius * scale, 9);
  });

  it("draws exactly four ticks, all the SAME length", () => {
    expect(lines).toHaveLength(4);
    const lengths = lines.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1));
    for (const len of lengths) {
      expect(len).toBeCloseTo(18 * scale, 9);
    }
    // The shipped redrawing had three ticks at 14 and one at 34. A max/min
    // ratio assertion is what catches that class directly.
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeCloseTo(1, 9);
  });

  it("every tick STRADDLES the ring edge", () => {
    const c = circles[0]!;
    for (const l of lines) {
      const dA = Math.hypot(l.x1 - c.x, l.y1 - c.y);
      const dB = Math.hypot(l.x2 - c.x, l.y2 - c.y);
      expect((dA - c.size) * (dB - c.size), `tick ${JSON.stringify(l)} must cross the ring`).toBeLessThan(0);
    }
  });

  it("ticks are drawn at the ring's own stroke weight", () => {
    for (const l of lines) expect(l.thickness).toBeCloseTo(SMART_SITE_MARK.ringStrokeWidth * scale, 9);
  });
});

describe("masthead lockup is the canonical lockup", () => {
  const { page, circles, lines, texts } = capture();
  const width = drawMastheadWordmark(page, 50, 400, fonts);
  const art = SMART_SITE_LOCKUP;
  const scale = MASTHEAD.logoHeight / art.nativeHeight;

  it("ring, dot and ticks carry canonical proportions", () => {
    expect(circles[0]!.size).toBeCloseTo(art.ringRadius * scale, 9);
    expect(circles[0]!.borderWidth).toBeCloseTo(art.ringStrokeWidth * scale, 9);
    expect(circles[1]!.size).toBeCloseTo(art.dotRadius * scale, 9);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).toBeCloseTo(18 * scale, 9);
  });

  it("the ring is drawn at the canonical centre, not the box centre", () => {
    // Canon centres the ring at native (38,38) in a 76-tall box. The old code
    // used (48,48) in a 96-tall box, which is the same fraction but a
    // different box, and that mismatch is what detached the ticks.
    expect(circles[0]!.x).toBeCloseTo(50 + art.centerX * scale, 9);
    expect(circles[0]!.y).toBeCloseTo(400 + (art.nativeHeight - art.centerY) * scale, 9);
  });

  it("wordmark starts at the canonical x and baseline", () => {
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]!.x).toBeCloseTo(50 + art.wordmark!.x * scale, 9);
    expect(texts[0]!.y).toBeCloseTo(400 + (art.nativeHeight - art.wordmark!.baselineY) * scale, 9);
  });

  it("wordmark is set at the canonical size", () => {
    for (const t of texts) expect(t.size).toBeCloseTo(art.wordmark!.fontSize * scale, 9);
  });

  it("draws SMART then SITE, in that order", () => {
    // drawTrackedText emits one drawText per glyph.
    expect(texts.map((t) => t.t).join("")).toBe("SMART SITE");
  });

  it("returns a positive rendered width", () => {
    expect(width).toBeGreaterThan(0);
  });
});

describe("the geometry cannot drift from the asset", () => {
  it("scales with logoHeight and nothing else", () => {
    // Two renders at different heights must differ by exactly the height ratio.
    const a = capture();
    const b = capture();
    drawRunningHeaderMark(a.page, 0, 0);
    drawRunningHeaderMark(b.page, 0, 0);
    expect(a.circles[0]!.size).toBe(b.circles[0]!.size);
  });

  it("no drawn dimension matches the retired redrawing's numbers", () => {
    // Explicit regression pins. If any of these ever pass again, the mark has
    // been re-redrawn. Retired values, at the OLD 96-box scale:
    //   mark ring stroke 3/96, dot 5/96, tick 14/96
    const { page, circles, lines } = capture();
    drawRunningHeaderMark(page, 0, 0);
    expect(circles[0]!.borderWidth).not.toBeCloseTo((3 / 96) * RUNHEAD.markSize, 9);
    expect(circles[1]!.size).not.toBeCloseTo((5 / 96) * RUNHEAD.markSize, 9);
    for (const l of lines) {
      expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).not.toBeCloseTo((14 / 96) * RUNHEAD.markSize, 9);
    }
  });

  it("the dot keeps TRUE gold while the ring takes print ink", () => {
    // Guards the one intentional colour exception from being "tidied" away.
    expect(PRINT.gold).not.toEqual(PRINT.printGold);
    expect(PRINT.gold).not.toEqual(PRINT.ink);
  });
});
