/**
 * Slug + section-label normalization mirroring atomization's helpers.
 * Duplicated here so the migration tool doesn't have to reach into
 * @hauska-engine/corpus's atomization internals; same algorithm.
 */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function normalizeSectionLabel(label: string): string {
  return label.replace(/\([^)]*\)/g, "").trim();
}

/**
 * Strip common section-label prefixes for cross-reference lookup.
 * Lets the body sniffer's "14.5" match section atoms stored under
 * "Section 14.5", "Sec. 14.5", "§ 14.5", "CHAPTER 14", "Article 14",
 * etc. The lookup index includes both the raw label and the stripped
 * form so legacy variability doesn't sink xref resolution.
 */
export function stripSectionPrefix(label: string): string {
  return label
    .replace(/^§\s*/i, "")
    .replace(/^(section|sec\.?|chapter|ch\.?|article|art\.?|division|div\.?)\s+/i, "")
    .trim();
}

export function buildEditionSlug(codeBook: string, edition: string): string {
  return slugify(`${codeBook}-${edition}`);
}
