import fontkit from "@pdf-lib/fontkit";

/**
 * §21 · VERTICAL RHYTHM — the metrics-driven line-box model.
 *
 * pdf-lib positions text by BASELINE; CSS positions text by LINE BOX. The
 * 2026-07-28 live-sheet defect (caps crowding the hairline rule above every
 * summary row) came from spacing rules by fixed offsets from the baseline
 * without accounting for the font's ascent/cap-height. This module closes
 * that gap by reconstructing the CSS line-box model from real font metrics.
 *
 * CSS-EQUIVALENCE MAPPING (padding + half-leading model)
 * ──────────────────────────────────────────────────────
 * A CSS row cell is:   border-top (the rule) → padding-top → line box →
 *                      padding-bottom → next border-top.
 * A CSS line box of `line-height: L` at font-size S is `L × S` tall. The
 * glyph content area is `(ascent − descent) / unitsPerEm × S` tall and is
 * centred in the line box; the space above/below it is the HALF-LEADING:
 *
 *   halfLeading        = (L·S − (ascent − descent)·S/upm) / 2
 *   baselineFromBoxTop = halfLeading + ascent·S/upm
 *   capTopFromBoxTop   = baselineFromBoxTop − capHeight·S/upm
 *
 * With the vendored Barlow faces (upm 1000, ascent 1000, descent −200,
 * capHeight 700) a 13px body line at line-height 1.6 gives, in px:
 *   lineBoxHeight 20.8 · halfLeading 2.6 · baselineFromBoxTop 15.6 ·
 *   capTopFromBoxTop 6.5 · descentBelowBaseline 2.6
 * so a summary row (padding space-2 = 6.8px each side) puts the cap tops
 * 6.8 + 6.5 = 13.3px below the rule above, and the next rule 2.6 + 2.6 +
 * 6.8 = 12px below the baseline — the mock's rhythm, reproduced from
 * metrics instead of eyeballed offsets.
 *
 * DELIBERATE SIMPLIFICATION: all cells of a row share the row's governing
 * line box (the value cell's) and draw on its baseline. CSS grid cells with
 * differing font sizes top-align instead (sub-2px divergence at these
 * sizes); one shared baseline is the sheet-craft-correct reading.
 *
 * Everything here is pure and unit-agnostic: sizes in, same unit out. The
 * renderer feeds PDF points; the standard documents px @96dpi (multiply by
 * 0.75 to land the same physical measure).
 */

/** Vertical metrics of a font face, in font units. */
export interface FontVerticalMetrics {
  unitsPerEm: number;
  /** Typographic ascent, positive up. */
  ascent: number;
  /** Typographic descent, NEGATIVE (font-unit convention). */
  descent: number;
  /** Cap height above the baseline. */
  capHeight: number;
}

/** Reads vertical metrics from a vendored TTF via fontkit (same parser pdf-lib embeds with). */
export function fontVerticalMetrics(bytes: Uint8Array): FontVerticalMetrics {
  const font = fontkit.create(bytes) as unknown as FontVerticalMetrics;
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    capHeight: font.capHeight,
  };
}

/** The resolved CSS-equivalent line box for (font, size, line-height ratio). */
export interface LineBox {
  /** `lineHeightRatio × size` — the full line-box height. */
  lineBoxHeight: number;
  /** Half-leading: space between line-box top and the glyph content area. */
  halfLeading: number;
  /** Distance from line-box top down to the baseline. */
  baselineFromBoxTop: number;
  /** Distance from line-box top down to the cap top (uppercase flat top). */
  capTopFromBoxTop: number;
  /** Glyph descent below the baseline (positive). */
  descentBelowBaseline: number;
  /** The font size this box was computed for. */
  fontSize: number;
}

/** Computes the line box from real metrics — the §21 primitive. */
export function lineBox(metrics: FontVerticalMetrics, size: number, lineHeightRatio: number): LineBox {
  const scale = size / metrics.unitsPerEm;
  const ascent = metrics.ascent * scale;
  const descent = -metrics.descent * scale; // positive
  const capHeight = metrics.capHeight * scale;
  const contentHeight = ascent + descent;
  const lineBoxHeight = size * lineHeightRatio;
  const halfLeading = (lineBoxHeight - contentHeight) / 2;
  const baselineFromBoxTop = halfLeading + ascent;
  return {
    lineBoxHeight,
    halfLeading,
    baselineFromBoxTop,
    capTopFromBoxTop: baselineFromBoxTop - capHeight,
    descentBelowBaseline: descent,
    fontSize: size,
  };
}

/**
 * A placed row in page space (PDF y grows UP): rule → padTop → line box(es)
 * → padBottom → next rule.
 */
export interface PlacedRowBoxes {
  /** y of the rule this row hangs from (as given). */
  ruleY: number;
  /** y of the top of the first line box (ruleY − padTop). */
  boxTopY: number;
  /** y of the cap top of the first line. */
  capTopY: number;
  /** Baseline y per line, first line first. */
  baselines: number[];
  /** y where the NEXT rule goes (after padBottom). */
  nextRuleY: number;
}

/** Places a row of `lines` line boxes below a rule at `ruleY` (§21 row model). */
export function placeRowBelowRule(
  ruleY: number,
  lb: LineBox,
  opts: { padTop: number; padBottom: number; lines?: number },
): PlacedRowBoxes {
  const lines = Math.max(1, opts.lines ?? 1);
  const boxTopY = ruleY - opts.padTop;
  const baselines: number[] = [];
  for (let i = 0; i < lines; i++) {
    baselines.push(boxTopY - i * lb.lineBoxHeight - lb.baselineFromBoxTop);
  }
  return {
    ruleY,
    boxTopY,
    capTopY: boxTopY - lb.capTopFromBoxTop,
    baselines,
    nextRuleY: boxTopY - lines * lb.lineBoxHeight - opts.padBottom,
  };
}

/**
 * §21 rhythm-capture seam: one record per rhythm-governed text row actually
 * drawn, exported on `PdfSitePlanResult.rhythm` so the rhythm gate can
 * assert the invariants numerically without rasterizing.
 */
export interface RhythmRow {
  page: 1 | 2 | 3;
  /** e.g. "group-heading" | "kv-row" | "segment-head" | "segment-row" |
   * "provenance-head" | "provenance-row" | "legend-row" | "strip-cell". */
  kind: string;
  /** y of the rule directly above the row; null when the row has none. */
  ruleY: number | null;
  boxTopY: number;
  capTopY: number;
  baselineY: number;
  lineBoxHeightPt: number;
  padTopPt: number;
  halfLeadingPt: number;
  fontSizePt: number;
  lines: number;
  /** Bottom of the row incl. padBottom — where the next rule goes. */
  bottomY: number;
}

/** Collects RhythmRow records during a render (no-op cost when unread). */
export class RhythmCapture {
  readonly rows: RhythmRow[] = [];

  row(
    page: 1 | 2 | 3,
    kind: string,
    placed: PlacedRowBoxes,
    lb: LineBox,
    padTopPt: number,
    opts: { ruleDrawn?: boolean } = {},
  ): void {
    this.rows.push({
      page,
      kind,
      ruleY: opts.ruleDrawn === false ? null : placed.ruleY,
      boxTopY: placed.boxTopY,
      capTopY: placed.capTopY,
      baselineY: placed.baselines[0]!,
      lineBoxHeightPt: lb.lineBoxHeight,
      padTopPt,
      halfLeadingPt: lb.halfLeading,
      fontSizePt: lb.fontSize,
      lines: placed.baselines.length,
      bottomY: placed.nextRuleY,
    });
  }
}
