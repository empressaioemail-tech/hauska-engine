/**
 * Model-code structural extractor — Layer 1 (ADR-019).
 *
 * Turns a Code Connect section + chapter tree (`IccCodeDocument`, from
 * the ICC adapter) into Layer 1 model-code atoms: `code-edition`,
 * `code-section`, `code-cross-reference`, `code-definition`.
 *
 * This is distinct from the generic `atomization.atomize()` because the
 * ADR-019 interim deep-link footing makes a Layer 1 `code-section`
 * structurally different from a Layer 2 / Layer 3 hosted section:
 *
 *   - `verbatimTextDeepLink` is SET, to ICC's free Digital Codes
 *     viewer. The model-code text is copyrighted by ICC; Hauska deep-
 *     links it rather than hosting it.
 *   - `bodyText` carries the REASONING LAYER — Hauska's structural
 *     summary of what the section governs — NOT the verbatim normative
 *     text. The verbatim text Code Connect returns is consumed here as
 *     input to the reasoning-layer step and to cross-reference /
 *     definition detection, and is then discarded, never persisted.
 *
 * The reasoning-layer generator is a provider-agnostic hook with a
 * deterministic, non-LLM default ({@link deterministicReasoningLayer})
 * built only from structure (heading, chapter, edition, table / figure
 * counts, cross-reference labels, defined terms) — never from verbatim
 * prose, so the default cannot leak copyrighted text. The ingest CLI
 * binds the hook to a Claude call for a substantive plain-language
 * summary; tests bind a deterministic stub. This mirrors the
 * `curated-queries` `LlmQueryGenerator` pattern.
 *
 * Layer 1 is the shared model-code base: one `code-edition` per I-Code
 * edition, referenced by every jurisdiction that adopts it. It ingests
 * under the synthetic `icc-model-code` tenant, not a city tenant.
 */

import { createHash } from "node:crypto";

import type { AtomLink, LinkType } from "@hauska-engine/atoms";
import type {
  CodeCrossReferenceAtomInstance,
  CodeDefinitionAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
} from "@hauska-engine/atoms";

import {
  ICC_MODEL_CODE_TENANT,
  type CodeConnectSection,
  type IccCodeDocument,
} from "../adapters/icc-code-connect/index.js";

/** Reference type taxonomy shared with the adapter / atomizer. */
export type CodeReferenceType =
  | "see"
  | "notwithstanding"
  | "subject-to"
  | "as-defined-in"
  | "amends"
  | "supersedes"
  | "unknown";

/* ──────────────────────────────────────────────────────────────────────
 *  Reasoning-layer hook
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Inputs to the reasoning-layer generator. `verbatimText` is the
 * Code Connect normative text — supplied so an LLM hook can summarize
 * it, but it MUST NOT be echoed into the output (ADR-019 deep-links the
 * verbatim text, never hosts it); the deterministic default ignores it.
 * Every other field is structure, which Layer 1 hosts freely.
 */
export interface ReasoningLayerInput {
  codeName: string;
  editionLabel: string;
  chapterNumber: string;
  chapterHeading: string;
  sectionNumber: string;
  sectionHeading: string;
  /** Verbatim normative text — for an LLM summarizer; never persisted. */
  verbatimText: string;
  tableCount: number;
  figureCount: number;
  crossReferenceLabels: ReadonlyArray<string>;
  definedTerms: ReadonlyArray<string>;
  /** The free-viewer URL the verbatim text lives at. */
  verbatimTextDeepLink: string;
}

/**
 * Generates a Layer 1 section's reasoning-layer `bodyText`. Sync or
 * async (an LLM hook is async). Bound to a Claude call by the ingest
 * CLI; defaults to {@link deterministicReasoningLayer}.
 */
export type ModelCodeReasoningLayer = (
  input: ReasoningLayerInput,
) => string | Promise<string>;

/**
 * Deterministic, non-LLM reasoning layer. Composes a structural
 * descriptor from hierarchy + counts only — it never reads
 * `input.verbatimText`, so it cannot reproduce copyrighted normative
 * text. This is the floor; the LLM hook enriches it with a substantive
 * summary of what the section governs.
 */
export const deterministicReasoningLayer: ModelCodeReasoningLayer = (
  input,
) => {
  const parts: string[] = [
    `Section ${input.sectionNumber} (${input.sectionHeading}) of the ${input.editionLabel}, Chapter ${input.chapterNumber} (${input.chapterHeading}).`,
  ];
  const facts: string[] = [];
  if (input.tableCount > 0) {
    facts.push(`${input.tableCount} table${input.tableCount === 1 ? "" : "s"}`);
  }
  if (input.figureCount > 0) {
    facts.push(
      `${input.figureCount} figure${input.figureCount === 1 ? "" : "s"}`,
    );
  }
  if (input.definedTerms.length > 0) {
    facts.push(
      `defines ${input.definedTerms.length} term${input.definedTerms.length === 1 ? "" : "s"} (${input.definedTerms.join(", ")})`,
    );
  }
  if (input.crossReferenceLabels.length > 0) {
    facts.push(
      `cross-references ${input.crossReferenceLabels.join(", ")}`,
    );
  }
  if (facts.length > 0) {
    parts.push(`Structure: ${facts.join("; ")}.`);
  }
  parts.push(
    `Layer 1 model-code base section on the ADR-019 interim deep-link footing — the verbatim normative text is published by ICC and is not hosted here; see ${input.verbatimTextDeepLink}.`,
  );
  return parts.join(" ");
};

/* ──────────────────────────────────────────────────────────────────────
 *  Options + result
 * ──────────────────────────────────────────────────────────────────── */

export interface ModelCodeExtractionOptions {
  /** Tenant the shared Layer 1 base ingests under. Default `icc-model-code`. */
  modelCodeTenant?: string;
  /** Reasoning-layer generator. Default {@link deterministicReasoningLayer}. */
  reasoningLayer?: ModelCodeReasoningLayer;
  /** ISO-8601 edition effective date. Default `<year>-01-01`. */
  effectiveFrom?: string;
  /** ISO-8601 fetch timestamp stamped on every atom. Default now. */
  fetchedAt?: string;
}

export interface ModelCodeExtractionResult {
  edition: CodeEditionAtomInstance;
  sections: ReadonlyArray<CodeSectionAtomInstance>;
  definitions: ReadonlyArray<CodeDefinitionAtomInstance>;
  crossReferences: ReadonlyArray<CodeCrossReferenceAtomInstance>;
  links: ReadonlyArray<AtomLink>;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Helpers
 * ──────────────────────────────────────────────────────────────────── */

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Strip subsection parens so xref targets resolve to the parent section. */
function normalizeSectionLabel(label: string): string {
  return label.replace(/\([^)]*\)/g, "").trim();
}

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

/** The editionId slug component, e.g. `2021-international-residential-code`. */
function editionSlug(editionLabel: string): string {
  return slugify(editionLabel);
}

/** Stable `code-edition` entityId: `<tenant>/<editionSlug>`. */
export function modelCodeEditionEntityId(
  tenant: string,
  editionLabel: string,
): string {
  return `${tenant}/${editionSlug(editionLabel)}`;
}

/**
 * Stable `code-section` entityId:
 * `<tenant>/<editionSlug>/<sectionNumberSlug>`. Exported so the Layer 1
 * eval rubric computes the same DID a curated query expects.
 */
export function modelCodeSectionEntityId(
  tenant: string,
  editionLabel: string,
  sectionNumber: string,
): string {
  return `${tenant}/${editionSlug(editionLabel)}/${slugify(
    normalizeSectionLabel(sectionNumber),
  )}`;
}

/** Stable `code-definition` entityId: `<tenant>/<editionSlug>/<termSlug>`. */
export function modelCodeDefinitionEntityId(
  tenant: string,
  editionLabel: string,
  term: string,
): string {
  return `${tenant}/${editionSlug(editionLabel)}/${slugify(term)}`;
}

/**
 * Model-code cross-reference pattern. Mirrors the ICC adapter's
 * `MODEL_CODE_REFERENCE_RE` — I-Code prose cites sister sections by
 * name ("Section R301.2", "Table R301.2(1)", "Chapter 11").
 */
const MODEL_CODE_REFERENCE_RE =
  /\b(?:Sections?|Tables?|Chapters?|§)\s+([A-Z]?\d[\w.()-]*)/g;

const REFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  referenceType: CodeReferenceType;
}> = [
  { pattern: /\bnotwithstanding\b/i, referenceType: "notwithstanding" },
  { pattern: /\bsubject to\b/i, referenceType: "subject-to" },
  { pattern: /\bas defined in\b/i, referenceType: "as-defined-in" },
  { pattern: /\bin accordance with\b/i, referenceType: "subject-to" },
  { pattern: /\bsee\b/i, referenceType: "see" },
];

function inferReferenceType(text: string): CodeReferenceType {
  for (const { pattern, referenceType } of REFERENCE_PATTERNS) {
    if (pattern.test(text)) return referenceType;
  }
  return "unknown";
}

function mapReferenceTypeToLinkType(referenceType: CodeReferenceType): LinkType {
  switch (referenceType) {
    case "see":
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

/** The ICC free Digital Codes viewer URL for an edition. */
function editionViewerUrl(codeAbbrev: string, year: number): string {
  return `https://codes.iccsafe.org/content/${codeAbbrev}${year}`;
}

/**
 * The deep-link a section's verbatim text lives at. Prefers the
 * Code Connect-supplied `viewerUrl`; otherwise synthesizes an
 * edition-level URL with a section anchor.
 *
 * @assumption The section-anchor synthesis (`#<sectionNumber>`) is a
 * placeholder until the ICC viewer's anchor scheme is confirmed
 * (ADR-019 "deep-link target granularity" open decision).
 */
function sectionDeepLink(
  section: CodeConnectSection,
  editionUrl: string,
): string {
  if (section.viewerUrl && section.viewerUrl.length > 0) {
    return section.viewerUrl;
  }
  return `${editionUrl}#${encodeURIComponent(section.sectionNumber)}`;
}

/** Join a section's prose content into the verbatim-text input. */
function verbatimTextOf(section: CodeConnectSection): string {
  return section.content
    .filter((n): n is { kind: "prose"; text: string } => n.kind === "prose")
    .map((n) => n.text)
    .join("\n\n");
}

interface ParsedReference {
  referenceText: string;
  targetLabel: string;
  referenceType: CodeReferenceType;
  referenceContext: string;
}

/** Parse model-code cross-references out of one section's prose nodes. */
function parseReferences(section: CodeConnectSection): ParsedReference[] {
  const refs: ParsedReference[] = [];
  for (const node of section.content) {
    if (node.kind !== "prose") continue;
    for (const match of node.text.matchAll(MODEL_CODE_REFERENCE_RE)) {
      const targetLabel = (match[1] ?? "").replace(/[.,;:]+$/, "");
      if (!targetLabel) continue;
      refs.push({
        referenceText: match[0].replace(/[.,;:]+$/, ""),
        targetLabel,
        referenceType: inferReferenceType(node.text),
        referenceContext: node.text,
      });
    }
  }
  return refs;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Extractor
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Extract Layer 1 model-code atoms from an assembled I-Code edition.
 *
 * Async because the reasoning-layer hook may be an LLM call. The walk
 * is two passes: pass one builds the section-number → entityId map so
 * pass two can resolve cross-reference targets within the edition.
 */
export async function extractModelCodeAtoms(
  document: IccCodeDocument,
  options: ModelCodeExtractionOptions = {},
): Promise<ModelCodeExtractionResult> {
  const tenant = options.modelCodeTenant ?? ICC_MODEL_CODE_TENANT;
  const reasoningLayer = options.reasoningLayer ?? deterministicReasoningLayer;
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();

  const { title } = document;
  const editionLabel = `${title.year} ${title.name}`;
  const editionId = modelCodeEditionEntityId(tenant, editionLabel);
  const editionUrl = editionViewerUrl(title.codeAbbrev, title.year);
  const effectiveFrom = options.effectiveFrom ?? `${title.year}-01-01`;

  // Pass 1 — section-number → entityId, for xref resolution.
  const sectionIdByNumber = new Map<string, string>();
  for (const { sections } of document.chapters) {
    for (const section of sections) {
      const id = modelCodeSectionEntityId(
        tenant,
        editionLabel,
        section.sectionNumber,
      );
      sectionIdByNumber.set(
        normalizeSectionLabel(section.sectionNumber),
        id,
      );
    }
  }

  const sections: CodeSectionAtomInstance[] = [];
  const definitions: CodeDefinitionAtomInstance[] = [];
  const crossReferences: CodeCrossReferenceAtomInstance[] = [];
  const links: AtomLink[] = [];
  let xrefSerial = 0;

  // Pass 2 — build atoms.
  for (const { chapter, sections: chapterSections } of document.chapters) {
    const isDefinitionsChapter = /^definitions$/i.test(chapter.heading.trim());

    for (const section of chapterSections) {
      const sectionId = modelCodeSectionEntityId(
        tenant,
        editionLabel,
        section.sectionNumber,
      );
      const deepLink = sectionDeepLink(section, editionUrl);
      const verbatimText = verbatimTextOf(section);
      const refs = parseReferences(section);
      const definedTerms = section.definedTerms ?? [];
      const tableCount = section.content.filter(
        (n) => n.kind === "table",
      ).length;
      const figureCount = section.content.filter(
        (n) => n.kind === "figure",
      ).length;

      const bodyText = await reasoningLayer({
        codeName: title.name,
        editionLabel,
        chapterNumber: chapter.chapterNumber,
        chapterHeading: chapter.heading,
        sectionNumber: section.sectionNumber,
        sectionHeading: section.heading,
        verbatimText,
        tableCount,
        figureCount,
        crossReferenceLabels: refs.map((r) => r.targetLabel),
        definedTerms: definedTerms.map((d) => d.term),
        verbatimTextDeepLink: deepLink,
      });

      const sectionAtom: CodeSectionAtomInstance = {
        entityType: "code-section",
        entityId: sectionId,
        jurisdictionTenant: tenant,
        codeEditionId: editionId,
        sectionNumber: section.sectionNumber,
        title: section.heading,
        subsectionPath: null,
        bodyText,
        verbatimTextDeepLink: deepLink,
        fetchedAt,
        sourceAdapter: "icc-code-connect",
        sourceUrl: deepLink,
        contentHash: hashContent(
          "code-section",
          sectionId,
          section.sectionNumber,
          section.heading,
          bodyText,
          deepLink,
        ),
      };
      sections.push(sectionAtom);
      links.push({
        fromEntityType: "code-edition",
        fromEntityId: editionId,
        toEntityType: "code-section",
        toEntityId: sectionId,
        linkType: "contains",
      });

      // Definitions.
      for (const term of definedTerms) {
        const defId = modelCodeDefinitionEntityId(
          tenant,
          editionLabel,
          term.term,
        );
        definitions.push({
          entityType: "code-definition",
          entityId: defId,
          jurisdictionTenant: tenant,
          codeEditionId: editionId,
          term: term.term,
          definitionText: term.definition,
          definingSectionId: sectionId,
          // A term in the I-Code Definitions chapter is code-wide;
          // an inline definition elsewhere is section-scoped.
          scope: isDefinitionsChapter ? "code" : "section",
          fetchedAt,
          sourceAdapter: "icc-code-connect",
          sourceUrl: deepLink,
          contentHash: hashContent(
            "code-definition",
            defId,
            term.term,
            term.definition,
          ),
        });
        links.push({
          fromEntityType: "code-section",
          fromEntityId: sectionId,
          toEntityType: "code-definition",
          toEntityId: defId,
          linkType: "defines",
        });
      }

      // Cross-references.
      for (const ref of refs) {
        xrefSerial += 1;
        const xrefId = `${tenant}/${editionSlug(editionLabel)}/${slugify(
          section.sectionNumber,
        )}/xref-${xrefSerial}`;
        const toSectionId =
          sectionIdByNumber.get(normalizeSectionLabel(ref.targetLabel)) ?? "";
        crossReferences.push({
          entityType: "code-cross-reference",
          entityId: xrefId,
          jurisdictionTenant: tenant,
          fromSectionId: sectionId,
          toSectionId,
          referenceText: ref.referenceText,
          referenceContext: ref.referenceContext,
          referenceType: ref.referenceType,
          fetchedAt,
          sourceAdapter: "icc-code-connect",
          sourceUrl: deepLink,
          contentHash: hashContent(
            "code-cross-reference",
            xrefId,
            sectionId,
            toSectionId,
            ref.referenceText,
          ),
        });
        if (toSectionId) {
          links.push({
            fromEntityType: "code-section",
            fromEntityId: sectionId,
            toEntityType: "code-section",
            toEntityId: toSectionId,
            linkType: mapReferenceTypeToLinkType(ref.referenceType),
            context: ref.referenceContext,
          });
        }
      }
    }
  }

  const edition: CodeEditionAtomInstance = {
    entityType: "code-edition",
    entityId: editionId,
    jurisdictionTenant: tenant,
    editionLabel,
    effectiveFrom,
    effectiveTo: null,
    sectionIds: sections.map((s) => s.entityId),
    // Layer 1 base carries no amendments — jurisdictional modifications
    // are Layer 2 overlay atoms, produced by the per-city ingest path.
    amendmentIds: [],
    fetchedAt,
    sourceAdapter: "icc-code-connect",
    sourceUrl: editionUrl,
    contentHash: hashContent(
      "code-edition",
      editionId,
      editionLabel,
      ...sections.map((s) => s.contentHash),
    ),
  };

  return { edition, sections, definitions, crossReferences, links };
}
