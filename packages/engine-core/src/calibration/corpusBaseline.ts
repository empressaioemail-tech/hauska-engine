/**
 * Asserted-confidence baseline for corpus atoms seeded from source quality.
 * Born-digital PDF > Municode/api > html > web.
 */

const SOURCE_QUALITY_BASELINE: Record<string, number> = {
  pdf: 0.82,
  api: 0.78,
  html: 0.72,
  web: 0.55,
};

const DEFAULT_CORPUS_BASELINE = 0.65;

export function assertedBaselineFromSourceType(sourceType: string | null): number {
  const key = (sourceType ?? "").trim().toLowerCase();
  return SOURCE_QUALITY_BASELINE[key] ?? DEFAULT_CORPUS_BASELINE;
}

/** Derive atom class for sparse within-partition fallback (section family). */
export function atomClassFromCodeRef(codeRef: string | null): string {
  const ref = (codeRef ?? "").trim().toUpperCase();
  if (!ref) return "unknown";
  const match = /^([A-Z]+)?\s*(\d+)/.exec(ref.replace(/[^A-Z0-9.\s-]/gi, ""));
  if (match?.[1] && match[2]) {
    const chapter = match[2].slice(0, 1);
    return `${match[1]}-${chapter}xx`;
  }
  return ref.split(/[.\s-]/)[0] || "unknown";
}
