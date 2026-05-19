/**
 * Structural extractor — walks the adapter's NormalizedBlock stream
 * and builds a typed StructuralNode tree.
 *
 * The extractor is source-family-agnostic — Municode HTML and eCode360
 * both produce the same NormalizedBlock contract per Stream 1A. Per-
 * source-family quirks land as targeted normalizers inside the adapters,
 * not as branches inside the extractor.
 *
 * Depth inference: heading depth in NormalizedBlock is 1-6. We map
 * depth -> structural kind via a configurable schema; the default
 * mapping handles common Municode shape (1=chapter, 2=article, 3=section,
 * 4+=subsection).
 */

import type {
  NormalizedBlock,
  NormalizedCode,
} from "../adapters/types.js";
import type {
  CodeTreeNode,
  StructuralNode,
  SectionNode,
  CrossReferenceNode,
  AmendmentNode,
  DefinitionNode,
} from "./types.js";

export interface ExtractorOptions {
  /**
   * Maps heading depth (1..6) to structural kind. Defaults to:
   *   1 -> chapter
   *   2 -> article
   *   3 -> section
   *   4 -> subsection
   *   5 -> subsection
   *   6 -> subsection
   */
  headingDepthSchema?: Record<
    number,
    "chapter" | "article" | "division" | "section" | "subsection"
  >;
}

const DEFAULT_SCHEMA: Record<
  number,
  "chapter" | "article" | "division" | "section" | "subsection"
> = {
  1: "chapter",
  2: "article",
  3: "section",
  4: "subsection",
  5: "subsection",
  6: "subsection",
};

/** Munge a heading label / text into (sectionNumber, title). */
function splitHeadingLabel(text: string): { label: string; title: string } {
  // Match leading "§ 5.04" or "Chapter 1" / "Article 1" / "5.04".
  const symbolMatch = text.match(/^§\s*([\w.()-]+)\s*[—–-]?\s*(.*)$/);
  if (symbolMatch) {
    return { label: symbolMatch[1] ?? "", title: (symbolMatch[2] ?? "").trim() };
  }
  // Handle abbreviated forms (Sec., Ch., Art., Div.) plus the full
  // words. Trailing dot is consumed; the number that follows is the
  // section label. "Sec. 14.01.001 - Adopted." -> label "14.01.001",
  // title "Adopted."
  const abbrevMatch = text.match(
    /^(Chapter|Ch\.?|Article|Art\.?|Division|Div\.?|Section|Sec\.?)\s+([\w.-]+)\s*[—–-]?\s*(.*)$/i,
  );
  if (abbrevMatch) {
    return {
      label: abbrevMatch[2] ?? "",
      title: (abbrevMatch[3] ?? "").trim() || (abbrevMatch[1] ?? ""),
    };
  }
  const numericMatch = text.match(/^([\w.-]+)\s+(.*)$/);
  if (numericMatch) {
    return {
      label: numericMatch[1] ?? "",
      title: (numericMatch[2] ?? "").trim(),
    };
  }
  return { label: "", title: text };
}

export function buildCodeTree(
  normalized: NormalizedCode,
  options: ExtractorOptions = {},
): CodeTreeNode {
  const schema = options.headingDepthSchema ?? DEFAULT_SCHEMA;
  const root: CodeTreeNode = {
    kind: "code-tree",
    jurisdictionTenant: normalized.metadata.jurisdictionTenant,
    jurisdictionName: normalized.metadata.jurisdictionName,
    editionLabel: normalized.metadata.editionLabel,
    publicationDate: normalized.metadata.publicationDate,
    sourceAdapter: normalized.metadata.sourceAdapter,
    sourceUrl: normalized.metadata.sourceUrl,
    fetchedAt: normalized.metadata.fetchedAt,
    children: [],
  };

  // Stack of containers we're currently nested inside, paired with
  // the depth they sit at. Headings of equal or shallower depth pop
  // back to a sibling slot.
  const stack: Array<{
    depth: number;
    container: { children: StructuralNode[] };
  }> = [{ depth: 0, container: root }];

  const cursor: { currentSection: SectionNode | null } = { currentSection: null };

  const pushAtDepth = (node: StructuralNode, depth: number) => {
    while (stack.length > 1 && (stack[stack.length - 1]?.depth ?? 0) >= depth) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (!top) {
      root.children.push(node);
    } else {
      top.container.children.push(node);
    }
    // Container-typed nodes become the new top of the stack.
    if (
      node.kind === "chapter" ||
      node.kind === "article" ||
      node.kind === "division" ||
      node.kind === "section" ||
      node.kind === "subsection"
    ) {
      stack.push({ depth, container: node });
    }
    if (node.kind === "section") cursor.currentSection = node;
  };

  for (const block of normalized.blocks) {
    switch (block.kind) {
      case "heading": {
        const kind = schema[block.depth] ?? "section";
        const { label, title } = splitHeadingLabel(block.label ?? block.text);
        const baseAnchor = block.sourceAnchor;
        if (kind === "chapter") {
          pushAtDepth(
            {
              kind: "chapter",
              label,
              title,
              ...(baseAnchor ? { sourceAnchor: baseAnchor } : {}),
              children: [],
            },
            block.depth,
          );
        } else if (kind === "article") {
          pushAtDepth(
            {
              kind: "article",
              label,
              title,
              ...(baseAnchor ? { sourceAnchor: baseAnchor } : {}),
              children: [],
            },
            block.depth,
          );
        } else if (kind === "division") {
          pushAtDepth(
            {
              kind: "division",
              label,
              title,
              ...(baseAnchor ? { sourceAnchor: baseAnchor } : {}),
              children: [],
            },
            block.depth,
          );
        } else if (kind === "section") {
          pushAtDepth(
            {
              kind: "section",
              sectionNumber: label,
              title,
              ...(baseAnchor ? { sourceAnchor: baseAnchor } : {}),
              bodyText: "",
              children: [],
            },
            block.depth,
          );
        } else if (kind === "subsection") {
          pushAtDepth(
            {
              kind: "subsection",
              subsectionPath: label,
              bodyText: "",
              children: [],
            },
            block.depth,
          );
        }
        break;
      }
      case "paragraph": {
        const top = stack[stack.length - 1]?.container as
          | SectionNode
          | { children: StructuralNode[]; bodyText?: string }
          | undefined;
        if (top && "bodyText" in top && typeof top.bodyText === "string") {
          top.bodyText = top.bodyText
            ? `${top.bodyText}\n${block.text}`
            : block.text;
        } else if (top) {
          // Not inside a body-bearing container; surface as a stray note.
          top.children.push({
            kind: "note",
            noteType: "stray-prose",
            text: block.text,
          });
        }
        break;
      }
      case "definition": {
        const defn: DefinitionNode = {
          kind: "definition",
          term: block.term,
          definitionText: block.definitionText,
          ...(block.definedInSectionLabel
            ? { definingSectionLabel: block.definedInSectionLabel }
            : {}),
        };
        const top = stack[stack.length - 1]?.container ?? root;
        top.children.push(defn);
        break;
      }
      case "cross-reference": {
        const fromLabel = cursor.currentSection?.sectionNumber;
        const xref: CrossReferenceNode = {
          kind: "cross-reference",
          referenceText: block.referenceText,
          referenceType: block.referenceType,
          ...(fromLabel ? { fromSectionLabel: fromLabel } : {}),
          ...(block.targetSectionLabel
            ? { targetSectionLabel: block.targetSectionLabel }
            : {}),
          ...(block.referenceContext
            ? { referenceContext: block.referenceContext }
            : {}),
        };
        const top = stack[stack.length - 1]?.container ?? root;
        top.children.push(xref);
        break;
      }
      case "amendment-record": {
        const amend: AmendmentNode = {
          kind: "amendment",
          ordinanceId: block.ordinanceId,
          effectiveDate: block.effectiveDate,
          authority: block.authority,
          affectedSectionLabels: block.affectedSectionLabels,
          amendmentText: block.amendmentText,
        };
        root.children.push(amend);
        break;
      }
      case "note": {
        const top = stack[stack.length - 1]?.container ?? root;
        top.children.push({
          kind: "note",
          noteType: block.noteType,
          text: block.text,
        });
        break;
      }
      case "table":
      case "figure":
        // Tables and figures are not yet promoted into the structural
        // tree; future versions may attach them under the current
        // section as a child note variant. Skipped for v1.
        break;
    }
  }

  return root;
}

/**
 * Quality report driven by 49 §B.2 exit gate (>= 95% accuracy on a 50
 * section ground-truth sample). The report here gives operators a
 * minimum-viable-structure signal so the pipeline-runner can fail-fast
 * before atomization on demonstrably-bad extraction output.
 */
export function reportExtractionQuality(
  tree: CodeTreeNode,
): import("./types.js").ExtractionQualityReport {
  let sections = 0;
  let definitions = 0;
  let crossRefs = 0;
  let amendments = 0;
  let unresolvedXrefs = 0;

  function walk(node: StructuralNode | CodeTreeNode) {
    if (node.kind === "section") sections++;
    if (node.kind === "definition") definitions++;
    if (node.kind === "cross-reference") {
      crossRefs++;
      if (!node.targetSectionLabel) unresolvedXrefs++;
    }
    if (node.kind === "amendment") amendments++;
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  }

  walk(tree);

  return {
    totalSections: sections,
    totalDefinitions: definitions,
    totalCrossReferences: crossRefs,
    totalAmendments: amendments,
    unresolvedCrossReferences: unresolvedXrefs,
    hasMinimumViableStructure: sections > 0 && crossRefs > 0,
  };
}
