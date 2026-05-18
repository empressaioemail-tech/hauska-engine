/**
 * Engine-side atom registry bootstrap.
 *
 * `bootstrapEngineAtomRegistry()` returns a configured AtomRegistry
 * with every Bump 1 code-atom type registered. The registry's
 * contextSummary functions consume an `InstanceLookup` that the
 * storage layer satisfies — until storage lands the lookup is
 * unimplemented and contextSummary returns a clear "not yet wired"
 * payload so callers fail loudly instead of silently returning
 * empty atoms.
 */

import {
  createAtomRegistry,
  type AtomRegistration,
  type AtomRegistry,
  type ContextSummary,
  type Scope,
} from "@hauska-engine/atom-contract-pin";

import type {
  CodeAmendmentAtomInstance,
  CodeAtomInstance,
  CodeCrossReferenceAtomInstance,
  CodeDefinitionAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "./instances.js";

/**
 * Storage-side accessor injected at bootstrap time. The retrieval API
 * implements this against the Postgres index + IPFS fetch path; tests
 * implement in-memory variants.
 */
export interface InstanceLookup {
  get<T extends CodeAtomInstance>(
    entityType: T["entityType"],
    entityId: string,
  ): Promise<T | null>;
}

const NOT_WIRED_LOOKUP: InstanceLookup = {
  async get() {
    throw new Error(
      "InstanceLookup not configured. Call bootstrapEngineAtomRegistry({ lookup }) with a storage-backed lookup before resolving contextSummary.",
    );
  },
};

function notFoundSummary(reason: string): ContextSummary {
  return {
    prose: `Atom not found: ${reason}`,
    typed: {},
    keyMetrics: [],
    relatedAtoms: [],
    historyProvenance: { latestEventId: "", latestEventAt: "" },
    scopeFiltered: false,
  };
}

function audienceLensesProse(scope: Scope, full: string, compact: string): {
  prose: string;
  scopeFiltered: boolean;
} {
  if (scope.audience === "ai") {
    return { prose: full, scopeFiltered: false };
  }
  if (scope.audience === "user") {
    return { prose: compact, scopeFiltered: true };
  }
  return { prose: full, scopeFiltered: false };
}

export interface BootstrapOptions {
  lookup?: InstanceLookup;
}

export function bootstrapEngineAtomRegistry(
  options: BootstrapOptions = {},
): AtomRegistry {
  const lookup = options.lookup ?? NOT_WIRED_LOOKUP;
  const registry = createAtomRegistry();

  const codeSection: AtomRegistration<"code-section", ["card", "compact", "inline", "expanded", "focus"]> = {
    entityType: "code-section",
    domain: "code-corpus",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [
      { childEntityType: "code-cross-reference", childMode: "compact", dataKey: "crossReferences", forwardRef: true },
      { childEntityType: "code-definition", childMode: "inline", dataKey: "definedTerms", forwardRef: true },
      { childEntityType: "code-amendment", childMode: "compact", dataKey: "amendments", forwardRef: true },
    ],
    eventTypes: [
      "code-section.ingested",
      "code-section.amended",
      "code-section.superseded",
      "code-section.cross-reference-resolved",
    ],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"code-section">> => {
      const inst = await lookup.get<CodeSectionAtomInstance>("code-section", entityId);
      if (!inst) return notFoundSummary(`code-section/${entityId}`) as ContextSummary<"code-section">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.sectionNumber} ${inst.title}. ${inst.bodyText}`,
        `${inst.sectionNumber} ${inst.title}`,
      );
      return {
        prose,
        typed: {
          sectionNumber: inst.sectionNumber,
          title: inst.title,
          subsectionPath: inst.subsectionPath,
          jurisdictionTenant: inst.jurisdictionTenant,
          codeEditionId: inst.codeEditionId,
          sourceAdapter: inst.sourceAdapter,
          sourceUrl: inst.sourceUrl,
          fetchedAt: inst.fetchedAt,
        },
        keyMetrics: [
          { label: "Section", value: inst.sectionNumber },
          { label: "Jurisdiction", value: inst.jurisdictionTenant },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.fetchedAt,
        },
        scopeFiltered,
      };
    },
  };

  const codeDefinition: AtomRegistration<"code-definition", ["compact", "inline"]> = {
    entityType: "code-definition",
    domain: "code-corpus",
    supportedModes: ["compact", "inline"] as const,
    defaultMode: "compact",
    composition: [],
    eventTypes: ["code-definition.ingested", "code-definition.amended"],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"code-definition">> => {
      const inst = await lookup.get<CodeDefinitionAtomInstance>("code-definition", entityId);
      if (!inst) return notFoundSummary(`code-definition/${entityId}`) as ContextSummary<"code-definition">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.term} — ${inst.definitionText}`,
        inst.term,
      );
      return {
        prose,
        typed: {
          term: inst.term,
          definitionText: inst.definitionText,
          jurisdictionTenant: inst.jurisdictionTenant,
          definingSectionId: inst.definingSectionId,
          scope: inst.scope,
        },
        keyMetrics: [{ label: "Term", value: inst.term }],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.fetchedAt,
        },
        scopeFiltered,
      };
    },
  };

  const codeAmendment: AtomRegistration<"code-amendment", ["compact", "card"]> = {
    entityType: "code-amendment",
    domain: "code-corpus",
    supportedModes: ["compact", "card"] as const,
    defaultMode: "compact",
    composition: [
      { childEntityType: "code-section", childMode: "compact", dataKey: "affectedSections", forwardRef: true },
    ],
    eventTypes: ["code-amendment.ingested", "code-amendment.effective"],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"code-amendment">> => {
      const inst = await lookup.get<CodeAmendmentAtomInstance>("code-amendment", entityId);
      if (!inst) return notFoundSummary(`code-amendment/${entityId}`) as ContextSummary<"code-amendment">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Ordinance ${inst.ordinanceId} (effective ${inst.effectiveDate}, ${inst.authority}). ${inst.amendmentText}`,
        `Ordinance ${inst.ordinanceId}`,
      );
      return {
        prose,
        typed: {
          ordinanceId: inst.ordinanceId,
          effectiveDate: inst.effectiveDate,
          authority: inst.authority,
          affectedSectionIds: inst.affectedSectionIds,
          jurisdictionTenant: inst.jurisdictionTenant,
        },
        keyMetrics: [
          { label: "Ordinance", value: inst.ordinanceId },
          { label: "Effective", value: inst.effectiveDate },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.fetchedAt,
        },
        scopeFiltered,
      };
    },
  };

  const codeCrossReference: AtomRegistration<"code-cross-reference", ["inline", "compact"]> = {
    entityType: "code-cross-reference",
    domain: "code-corpus",
    supportedModes: ["inline", "compact"] as const,
    defaultMode: "inline",
    composition: [],
    eventTypes: ["code-cross-reference.ingested", "code-cross-reference.resolved"],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"code-cross-reference">> => {
      const inst = await lookup.get<CodeCrossReferenceAtomInstance>("code-cross-reference", entityId);
      if (!inst) return notFoundSummary(`code-cross-reference/${entityId}`) as ContextSummary<"code-cross-reference">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.referenceType.toUpperCase()}: ${inst.referenceText} ${inst.referenceContext ?? ""}`.trim(),
        inst.referenceText,
      );
      return {
        prose,
        typed: {
          fromSectionId: inst.fromSectionId,
          toSectionId: inst.toSectionId,
          referenceText: inst.referenceText,
          referenceType: inst.referenceType,
          jurisdictionTenant: inst.jurisdictionTenant,
        },
        keyMetrics: [{ label: "Reference", value: inst.referenceText }],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.fetchedAt,
        },
        scopeFiltered,
      };
    },
  };

  const codeEdition: AtomRegistration<"code-edition", ["card", "compact"]> = {
    entityType: "code-edition",
    domain: "code-corpus",
    supportedModes: ["card", "compact"] as const,
    defaultMode: "card",
    composition: [
      { childEntityType: "code-section", childMode: "compact", dataKey: "sections", forwardRef: true },
      { childEntityType: "code-amendment", childMode: "compact", dataKey: "amendments", forwardRef: true },
    ],
    eventTypes: ["code-edition.published", "code-edition.superseded"],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"code-edition">> => {
      const inst = await lookup.get<CodeEditionAtomInstance>("code-edition", entityId);
      if (!inst) return notFoundSummary(`code-edition/${entityId}`) as ContextSummary<"code-edition">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.editionLabel} — ${inst.sectionIds.length} sections, effective from ${inst.effectiveFrom}${inst.effectiveTo ? ` to ${inst.effectiveTo}` : ""}.`,
        inst.editionLabel,
      );
      return {
        prose,
        typed: {
          editionLabel: inst.editionLabel,
          effectiveFrom: inst.effectiveFrom,
          effectiveTo: inst.effectiveTo,
          sectionCount: inst.sectionIds.length,
          amendmentCount: inst.amendmentIds.length,
        },
        keyMetrics: [
          { label: "Edition", value: inst.editionLabel },
          { label: "Sections", value: inst.sectionIds.length },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.fetchedAt,
        },
        scopeFiltered,
      };
    },
  };

  const jurisdictionCorpus: AtomRegistration<"jurisdiction-corpus", ["card", "compact"]> = {
    entityType: "jurisdiction-corpus",
    domain: "code-corpus",
    supportedModes: ["card", "compact"] as const,
    defaultMode: "card",
    composition: [
      { childEntityType: "code-edition", childMode: "compact", dataKey: "adoptedEditions", forwardRef: true },
    ],
    eventTypes: [
      "jurisdiction-corpus.loaded",
      "jurisdiction-corpus.refreshed",
      "jurisdiction-corpus.quality-bar-passed",
      "jurisdiction-corpus.quality-bar-failed",
    ],
    contextSummary: async (entityId: string, scope: Scope): Promise<ContextSummary<"jurisdiction-corpus">> => {
      const inst = await lookup.get<JurisdictionCorpusAtomInstance>("jurisdiction-corpus", entityId);
      if (!inst) return notFoundSummary(`jurisdiction-corpus/${entityId}`) as ContextSummary<"jurisdiction-corpus">;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.jurisdictionName} — ${inst.adoptedEditionIds.length} editions, current: ${inst.currentEditionId ?? "none"}. Quality bar: ${inst.coverageQualityBar}.`,
        inst.jurisdictionName,
      );
      return {
        prose,
        typed: {
          jurisdictionName: inst.jurisdictionName,
          adoptedEditionIds: inst.adoptedEditionIds,
          currentEditionId: inst.currentEditionId,
          coverageQualityBar: inst.coverageQualityBar,
          lastRefreshedAt: inst.lastRefreshedAt,
        },
        keyMetrics: [
          { label: "Jurisdiction", value: inst.jurisdictionName },
          { label: "Quality", value: inst.coverageQualityBar },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.lastRefreshedAt,
        },
        scopeFiltered,
      };
    },
  };

  registry.register(codeSection);
  registry.register(codeDefinition);
  registry.register(codeAmendment);
  registry.register(codeCrossReference);
  registry.register(codeEdition);
  registry.register(jurisdictionCorpus);

  return registry;
}
