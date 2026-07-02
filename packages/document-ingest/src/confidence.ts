/**
 * Asserted-baseline confidence seeding for document-derived atoms.
 *
 * A freshly extracted atom carries an ASSERTED widthed confidence
 * (`kind: "asserted"`, `n: 0`), NEVER a calibrated number. The value is
 * seeded from (a) the source-document quality (born-digital text is
 * higher-trust than a scan) and (b) the per-claim extraction confidence
 * the adapter reports (OCR / parse confidence). The live calibration
 * overlay in `packages/engine-core/src/calibration/` earns the
 * calibrated axis over time from adjudication + outcome signal.
 *
 * This mirrors the corpus `assertedBaselineFromSourceType` seed so the
 * document path and the code path speak one confidence language, but it
 * is kept local to this package (no cross-import into engine-core's
 * private calibration internals).
 */

import type { AssertedWidthedConfidence } from "@hauska-engine/atoms";

/**
 * Source-document quality baseline. Born-digital PDF text is the
 * highest-trust extraction source; a scan run through OCR is the lowest.
 * Aligned with the corpus source-quality baseline (pdf 0.82 ... web
 * 0.55) so the two paths are comparable.
 */
const SOURCE_QUALITY_BASELINE: Record<string, number> = {
  "born-digital-pdf": 0.82,
  structured: 0.8,
  api: 0.78,
  html: 0.72,
  ocr: 0.6,
  scan: 0.55,
  web: 0.55,
};

const DEFAULT_SOURCE_BASELINE = 0.65;

export type ExtractionSourceQuality = keyof typeof SOURCE_QUALITY_BASELINE;

export function assertedBaselineFromExtractionSource(
  source: string | null,
): number {
  const key = (source ?? "").trim().toLowerCase();
  return SOURCE_QUALITY_BASELINE[key] ?? DEFAULT_SOURCE_BASELINE;
}

export interface SeedConfidenceInput {
  /** Source-document quality (`born-digital-pdf`, `scan`, `structured`, ...). */
  sourceQuality: string | null;
  /**
   * Per-claim extraction confidence in [0, 1] the adapter reports (OCR /
   * parse confidence). When present it multiplicatively discounts the
   * source baseline; when absent the source baseline stands alone.
   */
  extractionConfidence?: number;
}

/**
 * Seed an asserted widthed confidence for a freshly minted atom.
 *
 * `value` = sourceBaseline * (extractionConfidence ?? 1), clamped to
 * [0, 1]. `intervalWidth` is deliberately WIDE (a single extraction with
 * no outcome signal is uncertain) and grows as the point estimate drops.
 * `n` is always 0 — no observations back an asserted seed. `kind` is
 * always `"asserted"`.
 */
export function seedAssertedConfidence(
  input: SeedConfidenceInput,
): AssertedWidthedConfidence {
  const baseline = assertedBaselineFromExtractionSource(input.sourceQuality);
  const extraction =
    input.extractionConfidence == null
      ? 1
      : clamp01(input.extractionConfidence);
  const value = clamp01(baseline * extraction);
  // Wide, honest interval: 0.20 floor, widening toward lower confidence.
  const intervalWidth = clamp01(0.2 + (1 - value) * 0.15);
  return { kind: "asserted", value, intervalWidth, n: 0 };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
