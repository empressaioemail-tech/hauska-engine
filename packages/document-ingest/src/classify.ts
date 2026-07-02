/**
 * Document classifier — routes a pinned document to the best adapter.
 *
 * Each registered adapter scores the document via `classify()`; the
 * highest scorer wins. The generic adapter returns a low non-zero floor,
 * so an unrecognized document always routes to the generic adapter rather
 * than failing to classify (commitment #1: never hard-fail).
 */

import type { DocumentAdapter, PinnedDocument } from "./types.js";

export interface ClassificationResult {
  adapter: DocumentAdapter;
  score: number;
}

/**
 * Pick the adapter with the highest classify() score. Ties break toward
 * the earlier-registered adapter (typed adapters should be registered
 * before the generic fallback). Returns null only when no adapters are
 * registered.
 */
export function classifyDocument(
  doc: PinnedDocument,
  adapters: ReadonlyArray<DocumentAdapter>,
): ClassificationResult | null {
  let best: ClassificationResult | null = null;
  for (const adapter of adapters) {
    let score = 0;
    try {
      score = adapter.classify(doc);
    } catch {
      // A misbehaving classifier must not break routing — treat as 0.
      score = 0;
    }
    if (best === null || score > best.score) {
      best = { adapter, score };
    }
  }
  return best;
}
