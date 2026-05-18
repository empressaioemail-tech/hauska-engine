/**
 * Structural tree types — Stream 1B.
 *
 * Per 49 §B.2: chapter / article / division / section / subsection /
 * definition / cross-reference / amendment / note. The tree is the
 * typed normalization Stream 1B produces from adapter output; Stream
 * 1B's atomization step walks the tree to emit atoms.
 *
 * Cross-references carry a label at extraction time; resolution to a
 * target section node happens after the entire tree is built (the
 * target may appear later in the stream).
 */

export type StructuralNodeKind =
  | "code-tree"
  | "chapter"
  | "article"
  | "division"
  | "section"
  | "subsection"
  | "definition"
  | "cross-reference"
  | "amendment"
  | "note";

export interface CodeTreeNode {
  kind: "code-tree";
  jurisdictionTenant: string;
  jurisdictionName: string;
  editionLabel: string;
  publicationDate: string;
  sourceAdapter: string;
  sourceUrl: string;
  fetchedAt: string;
  children: StructuralNode[];
}

export interface ChapterNode {
  kind: "chapter";
  label: string;
  title: string;
  sourceAnchor?: string;
  children: StructuralNode[];
}

export interface ArticleNode {
  kind: "article";
  label: string;
  title: string;
  sourceAnchor?: string;
  children: StructuralNode[];
}

export interface DivisionNode {
  kind: "division";
  label: string;
  title: string;
  sourceAnchor?: string;
  children: StructuralNode[];
}

export interface SectionNode {
  kind: "section";
  /** Section number as printed ("5.04", "1.01", "R301.1"). */
  sectionNumber: string;
  title: string;
  sourceAnchor?: string;
  bodyText: string;
  children: StructuralNode[];
}

export interface SubsectionNode {
  kind: "subsection";
  /** Subsection path label ("(b)", "(b)(2)"). */
  subsectionPath: string;
  bodyText: string;
  children: StructuralNode[];
}

export interface DefinitionNode {
  kind: "definition";
  term: string;
  definitionText: string;
  definingSectionLabel?: string;
}

export interface CrossReferenceNode {
  kind: "cross-reference";
  referenceText: string;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
  fromSectionLabel?: string;
  targetSectionLabel?: string;
  referenceContext?: string;
}

export interface AmendmentNode {
  kind: "amendment";
  ordinanceId: string;
  effectiveDate: string;
  authority: string;
  affectedSectionLabels: ReadonlyArray<string>;
  amendmentText: string;
}

export interface NoteNode {
  kind: "note";
  noteType: string;
  text: string;
}

export type StructuralNode =
  | ChapterNode
  | ArticleNode
  | DivisionNode
  | SectionNode
  | SubsectionNode
  | DefinitionNode
  | CrossReferenceNode
  | AmendmentNode
  | NoteNode;

export interface ExtractionQualityReport {
  totalSections: number;
  totalDefinitions: number;
  totalCrossReferences: number;
  totalAmendments: number;
  unresolvedCrossReferences: number;
  /** True when at least one section / one definition / one cross-reference. */
  hasMinimumViableStructure: boolean;
}
