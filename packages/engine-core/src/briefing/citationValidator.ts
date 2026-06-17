/**
 * Post-generation citation validation.
 *
 * The engine emits two citation forms (Spec 51 §2):
 *   - `{{atom|briefing-source|<id>|<displayLabel>}}` — pipe-delimited,
 *     post-DA-PI-1F1. The deprecated `{{atom:type:id:label}}` shape is
 *     forbidden; a regression test in `lib/empressa-atom` enforces it
 *     and we re-enforce here so a model regression cannot leak through.
 *   - `[[CODE:<atomId>]]` — code-section atom citations.
 *
 * Validation policy: every token's id must resolve to a known
 * briefing-source / code-section. Unknown tokens are STRIPPED from the
 * narrative and reported back to the route via the `invalidCitations`
 * list so observability captures the regression. Stripping (rather
 * than failing) keeps the contract: a missing-source case becomes a
 * gap note, not a 500.
 *
 * The regex is intentionally local to this module rather than re-using
 * `INLINE_ATOM_REGEX` from `lib/empressa-atom` because we need the
 * `displayLabel` capture group exactly the way the renderer reads it
 * (the empressa-atom regex is `g`-flagged and shared, sharing it would
 * couple the validator to that module's stateful `lastIndex` dance).
 */

const BRIEFING_SOURCE_TOKEN_RE =
  /\{\{atom\|briefing-source\|([^|]+)\|([^}]+)\}\}/g;
const CODE_SECTION_TOKEN_RE = /\[\[CODE:([^\]]+)\]\]/g;
const DEPRECATED_TOKEN_RE = /\{\{atom:[^}]+\}\}/g;

export interface CitationResolvers {
  /** Returns true when the briefing-source id is known to the engine. */
  isKnownBriefingSourceId(id: string): boolean;
  /** Returns true when the code-section atom id is known to the engine. */
  isKnownCodeSectionId(id: string): boolean;
}

export interface CitationScanResult {
  /** Narrative with every invalid token + every deprecated-shape token stripped. */
  cleaned: string;
  /**
   * The exact strings that were stripped — useful for the route's
   * observability log without having to re-run the scan caller-side.
   */
  invalidTokens: string[];
}

/** Run the validation on one section body. */
export function validateSectionCitations(
  text: string,
  resolvers: CitationResolvers,
  options: { allowCitations: boolean },
): CitationScanResult {
  const invalid: string[] = [];
  let cleaned = text;

  // Strip deprecated-shape tokens first — they are always invalid.
  cleaned = cleaned.replace(DEPRECATED_TOKEN_RE, (match) => {
    invalid.push(match);
    return "";
  });

  if (!options.allowCitations) {
    // Sections A + G are not allowed to cite anything; remove every
    // citation token if any leaked through despite the prompt's
    // explicit instruction.
    cleaned = cleaned.replace(BRIEFING_SOURCE_TOKEN_RE, (match) => {
      invalid.push(match);
      return "";
    });
    cleaned = cleaned.replace(CODE_SECTION_TOKEN_RE, (match) => {
      invalid.push(match);
      return "";
    });
    return { cleaned, invalidTokens: invalid };
  }

  cleaned = cleaned.replace(BRIEFING_SOURCE_TOKEN_RE, (match, id: string) => {
    if (!resolvers.isKnownBriefingSourceId(id)) {
      invalid.push(match);
      return "";
    }
    return match;
  });
  cleaned = cleaned.replace(CODE_SECTION_TOKEN_RE, (match, id: string) => {
    if (!resolvers.isKnownCodeSectionId(id)) {
      invalid.push(match);
      return "";
    }
    return match;
  });

  return { cleaned, invalidTokens: invalid };
}
