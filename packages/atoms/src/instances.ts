/**
 * Engine-side atom-instance shapes for Bump 1 code atoms.
 *
 * The shapes here are the concrete payload that gets pinned to IPFS
 * and indexed in Postgres per ADR-010. Each shape extends the same
 * `BaseAtomInstance` carrying jurisdiction tenant, source provenance,
 * and a content hash (the storage layer maps content hash to CID).
 */

export interface BaseAtomInstance {
  entityType: string;
  /** Stable local id within entityType. Combined with entityType into a DID per ADR-011. */
  entityId: string;
  jurisdictionTenant: string;
  /** ISO-8601 timestamp at which the source was last fetched. */
  fetchedAt: string;
  /** Adapter name (`municode-html`, `ecode360-html`, `raw-pdf`, ...). */
  sourceAdapter: string;
  /** Source URL for citation. */
  sourceUrl: string;
  /** Content hash (sha256 hex) of the canonical body. Maps to CID at storage time. */
  contentHash: string;
}

export interface CodeSectionAtomInstance extends BaseAtomInstance {
  entityType: "code-section";
  codeEditionId: string;
  sectionNumber: string;
  title: string;
  subsectionPath: string | null;
  bodyText: string;
}

export interface CodeDefinitionAtomInstance extends BaseAtomInstance {
  entityType: "code-definition";
  codeEditionId: string;
  term: string;
  definitionText: string;
  /** Section the definition is published in. Empty if global glossary. */
  definingSectionId: string | null;
  /** Scope of the definition. */
  scope: "section" | "chapter" | "code";
}

export interface CodeAmendmentAtomInstance extends BaseAtomInstance {
  entityType: "code-amendment";
  ordinanceId: string;
  effectiveDate: string;
  authority: string;
  affectedSectionIds: ReadonlyArray<string>;
  amendmentText: string;
  /** Prior CID being superseded per ADR-011 chain semantics. Empty for first ingest. */
  replacesSectionContentHash: string | null;
}

export interface CodeCrossReferenceAtomInstance extends BaseAtomInstance {
  entityType: "code-cross-reference";
  fromSectionId: string;
  toSectionId: string;
  referenceText: string;
  referenceContext: string | null;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
}

export interface CodeEditionAtomInstance extends BaseAtomInstance {
  entityType: "code-edition";
  editionLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sectionIds: ReadonlyArray<string>;
  amendmentIds: ReadonlyArray<string>;
}

export interface JurisdictionCorpusAtomInstance extends BaseAtomInstance {
  entityType: "jurisdiction-corpus";
  jurisdictionName: string;
  adoptedEditionIds: ReadonlyArray<string>;
  currentEditionId: string | null;
  /** Eval-harness pass state per 49 §B.4. */
  coverageQualityBar:
    | "not-evaluated"
    | "failing"
    | "passing"
    | "passing-recalibrated";
  lastRefreshedAt: string;
}

export type CodeAtomInstance =
  | CodeSectionAtomInstance
  | CodeDefinitionAtomInstance
  | CodeAmendmentAtomInstance
  | CodeCrossReferenceAtomInstance
  | CodeEditionAtomInstance
  | JurisdictionCorpusAtomInstance;

export type CodeAtomEntityType = CodeAtomInstance["entityType"];

export const CODE_ATOM_ENTITY_TYPES: ReadonlyArray<CodeAtomEntityType> = [
  "code-section",
  "code-definition",
  "code-amendment",
  "code-cross-reference",
  "code-edition",
  "jurisdiction-corpus",
];
