/**
 * Deduplication for re-aggregated per-discipline findings (WS1).
 *
 * Collapses findings whose normalized text bodies are identical after
 * citation validation. Preserves the higher-confidence survivor.
 */

import type { EngineFinding } from "../types";

/** Normalize finding text for dedupe comparison. */
export function normalizeFindingText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Deduplicate findings by normalized `text`. When two findings collide,
 * keep the one with higher `confidence`; ties favor the earlier entry.
 */
export function deduplicateFindings(
  findings: ReadonlyArray<EngineFinding>,
): { findings: EngineFinding[]; deduplicatedCount: number } {
  const byText = new Map<string, EngineFinding>();
  let deduplicatedCount = 0;

  for (const finding of findings) {
    const key = normalizeFindingText(finding.text);
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, finding);
      continue;
    }
    deduplicatedCount += 1;
    if (finding.confidence > existing.confidence) {
      byText.set(key, finding);
    }
  }

  return { findings: [...byText.values()], deduplicatedCount };
}
