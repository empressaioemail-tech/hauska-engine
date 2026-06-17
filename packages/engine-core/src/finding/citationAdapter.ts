/**
 * Citation-token validation adapter.
 *
 * Per Phase 1A decision Ask #1 (reuse) the AIR-1 finding engine and
 * the briefing engine share ONE validator implementation —
 * `validateSectionCitations` from `../briefing/citationValidator.js`. The
 * grammar is identical (`{{atom|briefing-source|<id>|<label>}}` and
 * `[[CODE:<atomId>]]`) so re-implementing would only invite drift.
 *
 * Findings have no Section A/G concept — every finding's `text` may
 * carry citations — so the engine always passes `allowCitations: true`.
 * This module exposes a `validateInlineCitations` alias so the call
 * site reads naturally; the implementation is the same function.
 */

import {
  validateSectionCitations,
  type CitationResolvers,
  type CitationScanResult,
} from "../briefing/citationValidator.js";

export type { CitationResolvers, CitationScanResult };

/**
 * Validate one finding-text body against the supplied resolver
 * lookups. Strips unknown tokens, returns the cleaned text + the
 * stripped strings.
 *
 * Thin alias for {@link validateSectionCitations} with
 * `allowCitations: true` baked in. The "section" wording in the
 * underlying name is briefing-engine ergonomics — the function itself
 * is grammar-only and works on any free-text body.
 */
export function validateInlineCitations(
  text: string,
  resolvers: CitationResolvers,
): CitationScanResult {
  return validateSectionCitations(text, resolvers, { allowCitations: true });
}
