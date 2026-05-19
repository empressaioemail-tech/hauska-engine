/**
 * Synthesize CodeCrossReferenceAtomInstance + atom-link edges by
 * sniffing inline section symbols out of each section's bodyText.
 *
 * Same pattern as the hauska atomizer's body-level sniffer; reused
 * here so the post-migration corpus and a fresh-Municode-ingest
 * corpus produce the same xref shape.
 */

import { createHash } from "node:crypto";

import type {
  AtomLink,
  CodeCrossReferenceAtomInstance,
  CodeSectionAtomInstance,
} from "@hauska-engine/atoms";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

const SECTION_REFERENCE_RE = /§\s*([\w.()-]+)/g;
const SECTION_WORD_RE = /\bsection\s+([\w.()-]+)/gi;

const REFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
}> = [
  { pattern: /\bnotwithstanding\b/i, referenceType: "notwithstanding" },
  { pattern: /\bsubject to\b/i, referenceType: "subject-to" },
  { pattern: /\bas defined in\b/i, referenceType: "as-defined-in" },
  { pattern: /\bamends?\b/i, referenceType: "amends" },
  { pattern: /\bsupersedes?\b/i, referenceType: "supersedes" },
  { pattern: /\bsee\b/i, referenceType: "see" },
];

function inferReferenceType(context: string): CodeCrossReferenceAtomInstance["referenceType"] {
  for (const { pattern, referenceType } of REFERENCE_PATTERNS) {
    if (pattern.test(context)) return referenceType;
  }
  return "unknown";
}

function trimTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?]+$/, "");
}

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

function buildSectionId(
  jurisdictionTenant: string,
  editionSlug: string,
  sectionNumber: string,
): string {
  return `${jurisdictionTenant}/${editionSlug}/${slugify(normalizeSectionLabel(sectionNumber))}`;
}

function buildXrefId(
  jurisdictionTenant: string,
  editionSlug: string,
  fromSectionEntityId: string,
  serial: number,
): string {
  return `${jurisdictionTenant}/${editionSlug}/${slugify(fromSectionEntityId)}/xref-${serial}`;
}

/**
 * Extract a snippet of surrounding context around a match. ~100 chars
 * gives the eval-time reader enough to understand the citation.
 */
function extractContext(body: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(body.length, matchIndex + matchLength + 60);
  return body.slice(start, end).trim();
}

export interface SniffXrefsInput {
  sections: ReadonlyArray<CodeSectionAtomInstance>;
  /**
   * Map from a section's `entityId` to its `(jurisdictionTenant, codeEditionId)`
   * for cross-reference target resolution. Built from the section atoms.
   */
  sectionsByEdition: Map<
    string,
    Map<string, CodeSectionAtomInstance>
  >;
}

export interface SniffXrefsOutput {
  crossReferences: ReadonlyArray<CodeCrossReferenceAtomInstance>;
  links: ReadonlyArray<AtomLink>;
  /** Cross-references whose target couldn't be resolved within the corpus. */
  unresolvedCount: number;
}

export function buildSectionsByEdition(
  sections: ReadonlyArray<CodeSectionAtomInstance>,
): Map<string, Map<string, CodeSectionAtomInstance>> {
  const map = new Map<string, Map<string, CodeSectionAtomInstance>>();
  for (const section of sections) {
    const key = `${section.jurisdictionTenant}::${section.codeEditionId}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Map<string, CodeSectionAtomInstance>();
      map.set(key, bucket);
    }
    // Index multiple lookup forms so a body sniffer's parsed label
    // ("14.5") resolves against atoms stored with prefixed labels
    // ("Section 14.5", "Sec. 14.5", "§ 14.5", "CHAPTER 14").
    const raw = section.sectionNumber;
    const normalized = normalizeSectionLabel(raw);
    const stripped = stripSectionPrefix(raw);
    const strippedNormalized = stripSectionPrefix(normalized);
    bucket.set(raw, section);
    bucket.set(normalized, section);
    bucket.set(stripped, section);
    bucket.set(strippedNormalized, section);
  }
  return map;
}

export function sniffCrossReferences(
  input: SniffXrefsInput,
): SniffXrefsOutput {
  const crossReferences: CodeCrossReferenceAtomInstance[] = [];
  const links: AtomLink[] = [];
  let unresolvedCount = 0;
  let serial = 0;

  for (const section of input.sections) {
    const editionKey = `${section.jurisdictionTenant}::${section.codeEditionId}`;
    const bucket = input.sectionsByEdition.get(editionKey);
    if (!bucket) continue;

    const editionSlug = section.codeEditionId.includes("/")
      ? section.codeEditionId.split("/").slice(1).join("/")
      : section.codeEditionId;

    const seenLabels = new Set<string>();

    const processMatch = (matchText: string, label: string, contextStart: number) => {
      const trimmedLabel = trimTrailingPunctuation(label);
      if (!trimmedLabel) return;
      const normalizedLabel = normalizeSectionLabel(trimmedLabel);
      if (!normalizedLabel) return;
      const strippedLabel = stripSectionPrefix(normalizedLabel);
      const targetSection =
        bucket.get(trimmedLabel) ??
        bucket.get(normalizedLabel) ??
        bucket.get(strippedLabel);
      const context = extractContext(section.bodyText, contextStart, matchText.length);
      const dedupeKey = `${section.entityId}|${normalizedLabel}`;
      if (seenLabels.has(dedupeKey)) return;
      seenLabels.add(dedupeKey);

      // Only emit code-cross-reference atoms for refs that resolve to
      // an in-corpus section. ADR-010 defines code-cross-reference as
      // an in-corpus pointer ("a typed link from one section to
      // another"). Refs to external codes (IRC, IBC, etc.) are NOT
      // code-cross-references; they're external citations that
      // remain in the section body's prose. A future
      // `external-citation` atom type can model them properly; for
      // v1 we drop them rather than emit dangling atoms.
      if (!targetSection) {
        unresolvedCount++;
        return;
      }
      serial++;
      const xrefId = buildXrefId(
        section.jurisdictionTenant,
        editionSlug,
        section.entityId,
        serial,
      );
      const toSectionId = targetSection.entityId;
      const referenceType = inferReferenceType(context);
      const inst: CodeCrossReferenceAtomInstance = {
        entityType: "code-cross-reference",
        entityId: xrefId,
        jurisdictionTenant: section.jurisdictionTenant,
        fromSectionId: section.entityId,
        toSectionId,
        referenceText: matchText.trim(),
        referenceContext: context,
        referenceType,
        fetchedAt: section.fetchedAt,
        sourceAdapter: section.sourceAdapter,
        sourceUrl: section.sourceUrl,
        contentHash: hashContent(
          "code-cross-reference",
          xrefId,
          section.entityId,
          toSectionId,
          matchText,
        ),
      };
      crossReferences.push(inst);
      links.push({
        fromEntityType: "code-section",
        fromEntityId: section.entityId,
        toEntityType: "code-section",
        toEntityId: toSectionId,
        linkType: mapReferenceTypeToLinkType(referenceType),
        context,
      });
    };

    // Reset regex state per section (global regex mutability).
    SECTION_REFERENCE_RE.lastIndex = 0;
    SECTION_WORD_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = SECTION_REFERENCE_RE.exec(section.bodyText)) !== null) {
      const label = match[1];
      if (label) processMatch(match[0], label, match.index);
    }
    while ((match = SECTION_WORD_RE.exec(section.bodyText)) !== null) {
      const label = match[1];
      if (label) processMatch(match[0], label, match.index);
    }
  }

  return { crossReferences, links, unresolvedCount };
}

function mapReferenceTypeToLinkType(
  referenceType: CodeCrossReferenceAtomInstance["referenceType"],
): AtomLink["linkType"] {
  switch (referenceType) {
    case "see":
      return "see-also";
    case "notwithstanding":
      return "see-also";
    case "subject-to":
      return "subject-to";
    case "as-defined-in":
      return "as-defined-in";
    case "amends":
      return "amends";
    case "supersedes":
      return "supersedes";
    case "unknown":
    default:
      return "cites";
  }
}
