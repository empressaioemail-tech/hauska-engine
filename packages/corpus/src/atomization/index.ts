/**
 * Atomization — Stream 1B.
 *
 * Consumes the structural tree from Stream 1B's extractor and emits
 * typed atom instances + atom-link edges per 27 §Stream B + 49 §B.3.
 *
 * Produces:
 *   - one `code-section` atom per section node
 *   - one `code-definition` atom per definition node
 *   - one `code-cross-reference` atom per cross-reference node
 *   - one `code-amendment` atom per amendment node
 *   - one `code-edition` atom aggregating sections + amendments
 *   - one `jurisdiction-corpus` atom referencing the edition
 *
 * Each atom carries provenance (source adapter, fetched-at, content
 * hash). The atomizer also emits the cross-reference + composition
 * edges that storage indexes into the atom_links table.
 *
 * Section IDs are deterministic so amendments / cross-references can
 * reference them stably across runs:
 *   `code-section/<jurisdictionTenant>/<editionLabelSlug>/<sectionNumberSlug>`
 */

import { createHash } from "node:crypto";

import type { AccessPolicy, AtomLink } from "@hauska-engine/atoms";
import type {
  CodeAmendmentAtomInstance,
  CodeCrossReferenceAtomInstance,
  CodeDefinitionAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";

import type {
  CodeTreeNode,
  CrossReferenceNode,
  DefinitionNode,
  SectionNode,
  StructuralNode,
} from "../extraction/types.js";

export interface AtomizationResult {
  jurisdictionCorpus: JurisdictionCorpusAtomInstance;
  edition: CodeEditionAtomInstance;
  sections: ReadonlyArray<CodeSectionAtomInstance>;
  definitions: ReadonlyArray<CodeDefinitionAtomInstance>;
  amendments: ReadonlyArray<CodeAmendmentAtomInstance>;
  crossReferences: ReadonlyArray<CodeCrossReferenceAtomInstance>;
  links: ReadonlyArray<AtomLink>;
}

export interface AtomizeOptions {
  /**
   * ADR-017 access tier tagged onto the emitted `jurisdiction-corpus`
   * atom. Per the 2026-05-19 Sync 4.5 sprint, partnership-pending
   * jurisdictions ingest as `"platform-internal"`; partnership-
   * confirmed ingest as `"public-free"` (also the default when this
   * option is omitted).
   */
  accessPolicy?: AccessPolicy;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Strip subsection parens so cross-reference targets resolve to the
 * parent section. "5.04(b)" -> "5.04"; "R301.1(a)(2)" -> "R301.1".
 */
function normalizeSectionLabel(label: string): string {
  return label.replace(/\([^)]*\)/g, "").trim();
}

/**
 * Sniff "Amends § X.YZ" / "Amends Section X.YZ" out of free amendment
 * text. Adapter-side amendment-record blocks may not populate
 * `affectedSectionLabels`; this is the secondary signal.
 */
function sniffAffectedSectionLabels(text: string): ReadonlyArray<string> {
  const labels = new Set<string>();
  const trim = (raw: string): string => raw.replace(/[.,;:!?]+$/, "");
  const symbolMatches = text.matchAll(/§\s*([\w.()-]+)/g);
  for (const m of symbolMatches) {
    if (m[1]) labels.add(trim(m[1]));
  }
  const wordMatches = text.matchAll(/\bsection\s+([\w.()-]+)/gi);
  for (const m of wordMatches) {
    if (m[1]) labels.add(trim(m[1]));
  }
  return Array.from(labels);
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

function buildEditionId(jurisdictionTenant: string, editionLabel: string): string {
  return `${jurisdictionTenant}/${slugify(editionLabel)}`;
}

function buildJurisdictionId(jurisdictionTenant: string): string {
  return jurisdictionTenant;
}

function buildDefinitionId(
  jurisdictionTenant: string,
  editionSlug: string,
  term: string,
): string {
  return `${jurisdictionTenant}/${editionSlug}/${slugify(term)}`;
}

function buildAmendmentId(
  jurisdictionTenant: string,
  ordinanceId: string,
): string {
  return `${jurisdictionTenant}/${slugify(ordinanceId)}`;
}

function buildCrossReferenceId(
  jurisdictionTenant: string,
  editionSlug: string,
  fromSectionId: string,
  index: number,
): string {
  return `${jurisdictionTenant}/${editionSlug}/${slugify(fromSectionId)}/xref-${index}`;
}

/**
 * Walks the structural tree and emits typed atoms.
 *
 * The walk is one pass; we collect sections first, then resolve
 * cross-reference targets against the collected sections in a second
 * pass. Definitions and amendments are emitted alongside sections.
 */
export function atomize(
  tree: CodeTreeNode,
  options: AtomizeOptions = {},
): AtomizationResult {
  const jurisdictionTenant = tree.jurisdictionTenant;
  const editionLabel = tree.editionLabel;
  const editionSlug = slugify(editionLabel);
  const editionId = buildEditionId(jurisdictionTenant, editionLabel);
  const jurisdictionId = buildJurisdictionId(jurisdictionTenant);

  const sections: CodeSectionAtomInstance[] = [];
  const definitions: CodeDefinitionAtomInstance[] = [];
  const amendments: CodeAmendmentAtomInstance[] = [];
  const crossReferences: CodeCrossReferenceAtomInstance[] = [];
  const links: AtomLink[] = [];

  const sectionIdByLabel = new Map<string, string>();
  let xrefSerial = 0;

  function walkSection(
    section: SectionNode,
    subsectionPath: string | null,
  ): void {
    const sectionId = buildSectionId(
      jurisdictionTenant,
      editionSlug,
      section.sectionNumber || section.title,
    );
    sectionIdByLabel.set(section.sectionNumber, sectionId);
    sectionIdByLabel.set(normalizeSectionLabel(section.sectionNumber), sectionId);
    const inst: CodeSectionAtomInstance = {
      entityType: "code-section",
      entityId: sectionId,
      jurisdictionTenant,
      codeEditionId: editionId,
      sectionNumber: section.sectionNumber,
      title: section.title,
      subsectionPath,
      bodyText: section.bodyText,
      fetchedAt: tree.fetchedAt,
      sourceAdapter: tree.sourceAdapter,
      sourceUrl: tree.sourceUrl,
      contentHash: hashContent(
        "code-section",
        sectionId,
        section.sectionNumber,
        section.title,
        subsectionPath ?? "",
        section.bodyText,
      ),
    };
    sections.push(inst);
    links.push({
      fromEntityType: "code-edition",
      fromEntityId: editionId,
      toEntityType: "code-section",
      toEntityId: sectionId,
      linkType: "contains",
    });
    walkChildrenOfSection(section, sectionId);
  }

  function walkChildrenOfSection(
    section: SectionNode,
    sectionId: string,
  ): void {
    for (const child of section.children) {
      visit(child, { containerSectionId: sectionId, containerSection: section });
    }
  }

  function emitDefinition(
    def: DefinitionNode,
    containerSectionId: string | null,
  ): void {
    const defId = buildDefinitionId(jurisdictionTenant, editionSlug, def.term);
    const inst: CodeDefinitionAtomInstance = {
      entityType: "code-definition",
      entityId: defId,
      jurisdictionTenant,
      codeEditionId: editionId,
      term: def.term,
      definitionText: def.definitionText,
      definingSectionId: containerSectionId,
      scope: containerSectionId ? "section" : "code",
      fetchedAt: tree.fetchedAt,
      sourceAdapter: tree.sourceAdapter,
      sourceUrl: tree.sourceUrl,
      contentHash: hashContent("code-definition", defId, def.term, def.definitionText),
    };
    definitions.push(inst);
    if (containerSectionId) {
      links.push({
        fromEntityType: "code-section",
        fromEntityId: containerSectionId,
        toEntityType: "code-definition",
        toEntityId: defId,
        linkType: "defines",
      });
    }
  }

  function emitCrossReference(
    xref: CrossReferenceNode,
    containerSectionId: string | null,
    containerSectionNumber: string | null,
  ): void {
    xrefSerial += 1;
    const fromLabel = containerSectionNumber ?? xref.fromSectionLabel ?? `corpus-${xrefSerial}`;
    const fromSectionId =
      containerSectionId ??
      buildSectionId(jurisdictionTenant, editionSlug, fromLabel);
    const xrefId = buildCrossReferenceId(
      jurisdictionTenant,
      editionSlug,
      fromSectionId,
      xrefSerial,
    );
    const toSectionId = xref.targetSectionLabel
      ? buildSectionId(jurisdictionTenant, editionSlug, xref.targetSectionLabel)
      : "";
    const inst: CodeCrossReferenceAtomInstance = {
      entityType: "code-cross-reference",
      entityId: xrefId,
      jurisdictionTenant,
      fromSectionId,
      toSectionId,
      referenceText: xref.referenceText,
      referenceContext: xref.referenceContext ?? null,
      referenceType: xref.referenceType,
      fetchedAt: tree.fetchedAt,
      sourceAdapter: tree.sourceAdapter,
      sourceUrl: tree.sourceUrl,
      contentHash: hashContent(
        "code-cross-reference",
        xrefId,
        fromSectionId,
        toSectionId,
        xref.referenceText,
      ),
    };
    crossReferences.push(inst);
    if (toSectionId) {
      links.push({
        fromEntityType: "code-section",
        fromEntityId: fromSectionId,
        toEntityType: "code-section",
        toEntityId: toSectionId,
        linkType: mapReferenceTypeToLinkType(xref.referenceType),
        ...(xref.referenceContext ? { context: xref.referenceContext } : {}),
      });
    }
  }

  function visit(
    node: StructuralNode,
    ctx: {
      containerSectionId: string | null;
      containerSection: SectionNode | null;
    },
  ): void {
    switch (node.kind) {
      case "chapter":
      case "article":
      case "division":
        for (const child of node.children) visit(child, ctx);
        break;
      case "section":
        walkSection(node, null);
        break;
      case "subsection": {
        // Subsections live under sections; promote subsection paths
        // into the parent section by stamping the path into a child
        // section atom. The current 49 §B.3 default leans toward one
        // atom per section root; we represent subsections as separate
        // section atoms when they carry body text, so the eval
        // harness can score against subsection-level retrievability.
        if (ctx.containerSection) {
          const synthetic: SectionNode = {
            kind: "section",
            sectionNumber: `${ctx.containerSection.sectionNumber}${node.subsectionPath}`,
            title: ctx.containerSection.title,
            bodyText: node.bodyText,
            children: node.children,
          };
          walkSection(synthetic, node.subsectionPath);
        }
        break;
      }
      case "definition":
        emitDefinition(node, ctx.containerSectionId);
        break;
      case "cross-reference":
        emitCrossReference(
          node,
          ctx.containerSectionId,
          ctx.containerSection?.sectionNumber ?? null,
        );
        break;
      case "amendment": {
        const amendId = buildAmendmentId(jurisdictionTenant, node.ordinanceId);
        const declaredLabels = node.affectedSectionLabels.length
          ? node.affectedSectionLabels
          : sniffAffectedSectionLabels(node.amendmentText);
        const affectedSectionIds = declaredLabels
          .map((label) =>
            sectionIdByLabel.get(label) ??
            sectionIdByLabel.get(normalizeSectionLabel(label)),
          )
          .filter((id): id is string => Boolean(id));
        const inst: CodeAmendmentAtomInstance = {
          entityType: "code-amendment",
          entityId: amendId,
          jurisdictionTenant,
          // Stream 1B's extractor produces in-jurisdiction amendment
          // records; the ADR-019 Layer 2 jurisdictional overlay is
          // emitted by the layered-substrate ingest path, not here.
          amendmentScope: "temporal",
          ordinanceId: node.ordinanceId,
          effectiveDate: node.effectiveDate,
          authority: node.authority,
          affectedSectionIds,
          amendmentText: node.amendmentText,
          replacesSectionContentHash: null,
          fetchedAt: tree.fetchedAt,
          sourceAdapter: tree.sourceAdapter,
          sourceUrl: tree.sourceUrl,
          contentHash: hashContent(
            "code-amendment",
            amendId,
            node.ordinanceId,
            node.effectiveDate,
            node.amendmentText,
          ),
        };
        amendments.push(inst);
        for (const affectedId of affectedSectionIds) {
          links.push({
            fromEntityType: "code-amendment",
            fromEntityId: amendId,
            toEntityType: "code-section",
            toEntityId: affectedId,
            linkType: "amends",
          });
        }
        break;
      }
      case "note":
        // Notes don't promote to atoms in v1 — they remain part of
        // their parent section's bodyText (extraction folded them in).
        break;
    }
  }

  for (const child of tree.children) {
    visit(child, { containerSectionId: null, containerSection: null });
  }

  const editionFetchedAt = tree.fetchedAt;
  const editionInstance: CodeEditionAtomInstance = {
    entityType: "code-edition",
    entityId: editionId,
    jurisdictionTenant,
    editionLabel,
    effectiveFrom: tree.publicationDate || editionFetchedAt,
    effectiveTo: null,
    sectionIds: sections.map((s) => s.entityId),
    amendmentIds: amendments.map((a) => a.entityId),
    fetchedAt: editionFetchedAt,
    sourceAdapter: tree.sourceAdapter,
    sourceUrl: tree.sourceUrl,
    contentHash: hashContent(
      "code-edition",
      editionId,
      editionLabel,
      ...sections.map((s) => s.contentHash),
      ...amendments.map((a) => a.contentHash),
    ),
  };

  const jurisdictionCorpusInstance: JurisdictionCorpusAtomInstance = {
    entityType: "jurisdiction-corpus",
    entityId: jurisdictionId,
    jurisdictionTenant,
    jurisdictionName: tree.jurisdictionName,
    adoptedEditionIds: [editionId],
    currentEditionId: editionId,
    coverageQualityBar: "not-evaluated",
    lastRefreshedAt: editionFetchedAt,
    fetchedAt: editionFetchedAt,
    sourceAdapter: tree.sourceAdapter,
    sourceUrl: tree.sourceUrl,
    contentHash: hashContent(
      "jurisdiction-corpus",
      jurisdictionId,
      tree.jurisdictionName,
      editionId,
      options.accessPolicy ?? "public-free",
    ),
    ...(options.accessPolicy ? { accessPolicy: options.accessPolicy } : {}),
  };

  links.push({
    fromEntityType: "jurisdiction-corpus",
    fromEntityId: jurisdictionId,
    toEntityType: "code-edition",
    toEntityId: editionId,
    linkType: "contains",
  });

  return {
    jurisdictionCorpus: jurisdictionCorpusInstance,
    edition: editionInstance,
    sections,
    definitions,
    amendments,
    crossReferences,
    links,
  };
}

function mapReferenceTypeToLinkType(
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown",
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
