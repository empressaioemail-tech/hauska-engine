/**
 * Extract materializable design requirements from a generated briefing.
 *
 * Per Spec 51 §6, sections C (Regulatory Gates), D (Site Infrastructure)
 * and F (Neighboring Context) carry the discrete design constraints
 * that a downstream BIM / design tool can materialize back into model
 * geometry + code citations. The other five sections are summary,
 * threshold, envelope, or workflow narrative — useful to architects
 * but not directly turn-into-Revit-element material.
 *
 * The extractor splits each of the three sections into sentence-level
 * claims and emits one {@link MaterializableElement} per claim, in
 * document order. Citation tokens (`{{atom|briefing-source|...}}`,
 * `[[CODE:...]]`) are preserved verbatim inside the element text so
 * downstream consumers can re-use the same citation grammar.
 *
 * Sentence splitting policy:
 *   - Split on a period followed by whitespace, keeping the period
 *     attached to the preceding sentence.
 *   - Trim each sentence; drop empty results.
 *   - The mock generator's gap-note sentences (e.g. "No utility ...
 *     attached — request a utility availability letter from the
 *     jurisdiction.") survive as a single element each, which is the
 *     correct shape: a gap note IS still a downstream requirement
 *     ("order this study"), just not yet backed by a source.
 */

import {
  MATERIALIZABLE_SECTIONS,
  type BriefingSections,
  type MaterializableElement,
  type MaterializableSection,
} from "./types";

/**
 * Split a section body into sentence-level claims. Exported for the
 * unit test; the engine path uses {@link extractMaterializableElements}.
 */
export function splitSectionClaims(body: string): string[] {
  if (!body) return [];
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Walk the C / D / F sections of a generated briefing and return the
 * per-claim materializable elements in document order. Pure function;
 * no I/O.
 */
export function extractMaterializableElements(
  sections: BriefingSections,
): MaterializableElement[] {
  const out: MaterializableElement[] = [];
  for (const section of MATERIALIZABLE_SECTIONS) {
    const claims = splitSectionClaims(sections[section]);
    claims.forEach((text, index) => {
      out.push({ section: section as MaterializableSection, index, text });
    });
  }
  return out;
}
