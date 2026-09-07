/**
 * Visual reading order for tagged-PDF structure trees.
 *
 * A structure tree in the wrong order passes every mechanical check
 * (/StructTreeRoot present, /MarkInfo /Marked true, /Lang set) and still reads
 * backwards to an actual screen reader, so the order is COMPUTED from glyph
 * positions and then MEASURED against the same predicate the external
 * acceptance instrument applies to the finished file.
 */

/**
 * Two baselines within this many points are one visual line. A single row on
 * these sheets mixes a 6.5pt chip with a 9pt label and their baselines differ
 * by around 2pt, so a stricter band would split one row into two and a looser
 * one would merge two rows into one.
 *
 * The external instrument uses the same 3.0pt band. Writer and checker are
 * deliberately stated in both places rather than shared, because a checker
 * that imports the writer's constant cannot detect the writer changing it.
 */
export const READING_ORDER_BAND_PT = 3.0;

export interface Positioned {
  x: number;
  y: number;
}

/**
 * Bands of baselines within READING_ORDER_BAND_PT, top to bottom, left to
 * right inside a band.
 *
 * The band is DIAMETER-CAPPED against the band's first baseline rather than
 * chained against the previous one. Chaining lets a band grow without limit
 * (a→b→c each within tolerance, a to c far outside it), which puts two runs
 * six points apart next to each other and reads as an inversion to any checker
 * using the same tolerance.
 */
export function orderForReading<T extends Positioned>(runs: readonly T[]): T[] {
  const byY = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: T[] = [];
  let band: T[] = [];
  let bandTop = Number.POSITIVE_INFINITY;
  const flush = (): void => {
    band.sort((a, b) => a.x - b.x || b.y - a.y);
    out.push(...band);
    band = [];
  };
  for (const run of byY) {
    if (band.length === 0) {
      bandTop = run.y;
      band.push(run);
      continue;
    }
    if (bandTop - run.y <= READING_ORDER_BAND_PT) {
      band.push(run);
      continue;
    }
    flush();
    bandTop = run.y;
    band.push(run);
  }
  if (band.length > 0) flush();
  return out;
}

/**
 * Adjacent pairs that read backwards: same-line pairs must advance in x, and a
 * following run must never sit meaningfully ABOVE its predecessor.
 *
 * Returns a count, never a boolean, because the count is the diagnostic: a
 * single inversion is a band-tolerance question and forty is a broken order.
 */
export function countReadingOrderInversions(ordered: ReadonlyArray<Positioned>): number {
  let inversions = 0;
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (Math.abs(a.y - b.y) <= READING_ORDER_BAND_PT) {
      if (b.x < a.x - 0.5) inversions += 1;
    } else if (b.y > a.y + READING_ORDER_BAND_PT) {
      inversions += 1;
    }
  }
  return inversions;
}
