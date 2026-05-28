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
  AtomInstance,
  AttachedDocumentAtomInstance,
  CodeAmendmentAtomInstance,
  CodeCrossReferenceAtomInstance,
  CodeDefinitionAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  DeliverableLetterAtomInstance,
  DeliverableLetterRenderAtomInstance,
  DetailCalloutSpecAtomInstance,
  JurisdictionCorpusAtomInstance,
  ProductSpecReferenceAtomInstance,
  ResponseTaskAtomInstance,
  SheetContentExtractionAtomInstance,
  BriefRunAtomInstance,
  PropertyWorkspaceAtomInstance,
  WorkspaceAttachmentAtomInstance,
  WorkspaceShareEdgeAtomInstance,
} from "./instances.js";
import { deliverableLetterCompleteness } from "./instances.js";

/**
 * Storage-side accessor injected at bootstrap time. The retrieval API
 * implements this against the Postgres index + IPFS fetch path; tests
 * implement in-memory variants. Keyed over the full atom union
 * (code-corpus + Cortex L-surface).
 */
export interface InstanceLookup {
  get<T extends AtomInstance>(
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
      const scopeLabel =
        inst.amendmentScope === "jurisdictional-overlay"
          ? `jurisdictional overlay (${inst.overlayOperation})`
          : "temporal amendment";
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Ordinance ${inst.ordinanceId} — ${scopeLabel}, effective ${inst.effectiveDate}, ${inst.authority}. ${inst.amendmentText}`,
        `Ordinance ${inst.ordinanceId} (${scopeLabel})`,
      );
      return {
        prose,
        typed: {
          ordinanceId: inst.ordinanceId,
          amendmentScope: inst.amendmentScope,
          effectiveDate: inst.effectiveDate,
          authority: inst.authority,
          affectedSectionIds: inst.affectedSectionIds,
          jurisdictionTenant: inst.jurisdictionTenant,
          ...(inst.amendmentScope === "jurisdictional-overlay"
            ? {
                baseEditionId: inst.baseEditionId,
                overlayOperation: inst.overlayOperation,
              }
            : {}),
        },
        keyMetrics: [
          { label: "Ordinance", value: inst.ordinanceId },
          { label: "Scope", value: inst.amendmentScope },
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

  // -------------------------------------------------------------------
  // Cortex (L-surface) atoms — L1 through L6 per the 2026-05-19 Lane A.2
  // dispatch. Each lands in its own PR; this block accretes registrations.
  // -------------------------------------------------------------------

  const responseTask: AtomRegistration<
    "response-task",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "response-task",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    // Audit-chain event types. The atom record holds current state;
    // these let consumers compose an event-sourced view from the
    // storage event log without the atom carrying the chain inline.
    eventTypes: [
      "response-task.opened",
      "response-task.progressed",
      "response-task.completed",
      "response-task.cancelled",
    ],
    // ADR-017: response-task is engagement workflow data, private to the
    // owning tenant. Never a public-catalog atom.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"response-task">> => {
      const inst = await lookup.get<ResponseTaskAtomInstance>(
        "response-task",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `response-task/${entityId}`,
        ) as ContextSummary<"response-task">;
      }
      const dueClause = inst.dueAt ? ` Due ${inst.dueAt}.` : "";
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.title} — ${inst.description} (${inst.state}).${dueClause}`,
        `${inst.title} (${inst.state})`,
      );
      return {
        prose,
        typed: {
          title: inst.title,
          description: inst.description,
          state: inst.state,
          createdAt: inst.createdAt,
          dueAt: inst.dueAt,
          completedAt: inst.completedAt,
          sourceClientCommentId: inst.sourceClientCommentId,
          findingId: inst.findingId,
          engagementId: inst.engagementId,
          actorId: inst.actorId,
          principalActorId: inst.principalActorId,
        },
        keyMetrics: [
          { label: "State", value: inst.state },
          { label: "Title", value: inst.title },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.completedAt ?? inst.createdAt,
        },
        scopeFiltered,
      };
    },
  };

  const sheetContentExtraction: AtomRegistration<
    "sheet-content-extraction",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "sheet-content-extraction",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: [
      "sheet-content-extraction.produced",
      "sheet-content-extraction.re-extracted",
    ],
    // ADR-017: sheet extractions are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"sheet-content-extraction">> => {
      const inst = await lookup.get<SheetContentExtractionAtomInstance>(
        "sheet-content-extraction",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `sheet-content-extraction/${entityId}`,
        ) as ContextSummary<"sheet-content-extraction">;
      }
      const label = inst.pageLabel || inst.sourceSheetId;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Sheet ${label} — ${inst.extractedTextSegments.length} text segments, ${inst.structuredAnnotations.length} structured annotations (OCR: ${inst.ocrModel}).`,
        `Sheet ${label} extraction`,
      );
      return {
        prose,
        typed: {
          sourceSheetId: inst.sourceSheetId,
          engagementId: inst.engagementId,
          pageLabel: inst.pageLabel,
          textSegmentCount: inst.extractedTextSegments.length,
          annotationCount: inst.structuredAnnotations.length,
          ocrModel: inst.ocrModel,
          actorId: inst.actorId,
        },
        keyMetrics: [
          { label: "Sheet", value: label },
          { label: "Annotations", value: inst.structuredAnnotations.length },
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

  const attachedDocument: AtomRegistration<
    "attached-document",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "attached-document",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: [
      "attached-document.ingested",
      "attached-document.re-parsed",
    ],
    // ADR-017: attached documents are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"attached-document">> => {
      const inst = await lookup.get<AttachedDocumentAtomInstance>(
        "attached-document",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `attached-document/${entityId}`,
        ) as ContextSummary<"attached-document">;
      }
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.title} (${inst.documentType}). ${inst.extractedText}`,
        `${inst.title} (${inst.documentType})`,
      );
      return {
        prose,
        typed: {
          title: inst.title,
          documentType: inst.documentType,
          engagementId: inst.engagementId,
          originalBlobRef: inst.originalBlobRef,
          actorId: inst.actorId,
        },
        keyMetrics: [
          { label: "Title", value: inst.title },
          { label: "Type", value: inst.documentType },
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

  const deliverableLetter: AtomRegistration<
    "deliverable-letter",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "deliverable-letter",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    // Leaf composition: per-section provenance refs (response-task /
    // sheet-content-extraction / finding / adjudication-state) are nested
    // data fields, not flat owned-child slots, so they aren't declared
    // as composition edges. Consumers traverse them by reading sections.
    composition: [],
    eventTypes: [
      "deliverable-letter.drafted",
      "deliverable-letter.section-revised",
      "deliverable-letter.sent",
    ],
    // ADR-017: deliverable letters are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"deliverable-letter">> => {
      const inst = await lookup.get<DeliverableLetterAtomInstance>(
        "deliverable-letter",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `deliverable-letter/${entityId}`,
        ) as ContextSummary<"deliverable-letter">;
      }
      const completeness = deliverableLetterCompleteness(inst.sections);
      const completeClause = completeness.complete
        ? "complete"
        : `incomplete (missing: ${completeness.missing.join(", ")})`;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.title} — ${inst.status}, ${inst.sections.length} sections, ${completeClause}.`,
        `${inst.title} (${inst.status})`,
      );
      return {
        prose,
        typed: {
          title: inst.title,
          status: inst.status,
          engagementId: inst.engagementId,
          recipientActorId: inst.recipientActorId,
          sectionCount: inst.sections.length,
          complete: completeness.complete,
          missingSections: completeness.missing,
          createdAt: inst.createdAt,
          sentAt: inst.sentAt,
          actorId: inst.actorId,
          principalActorId: inst.principalActorId,
        },
        keyMetrics: [
          { label: "Status", value: inst.status },
          { label: "Sections", value: inst.sections.length },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.sentAt ?? inst.createdAt,
        },
        scopeFiltered,
      };
    },
  };

  const detailCalloutSpec: AtomRegistration<
    "detail-callout-spec",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "detail-callout-spec",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: [
      "detail-callout-spec.created",
      "detail-callout-spec.pushed",
      "detail-callout-spec.applied",
      "detail-callout-spec.rejected",
    ],
    // ADR-017: detail-callout specs are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"detail-callout-spec">> => {
      const inst = await lookup.get<DetailCalloutSpecAtomInstance>(
        "detail-callout-spec",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `detail-callout-spec/${entityId}`,
        ) as ContextSummary<"detail-callout-spec">;
      }
      const detailType = inst.spec.detailType;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Detail callout (${detailType}) — push state: ${inst.pushState}${inst.apsTaskRef ? `, APS task ${inst.apsTaskRef}` : ""}.`,
        `Detail callout (${detailType}, ${inst.pushState})`,
      );
      return {
        prose,
        typed: {
          detailType,
          pushState: inst.pushState,
          engagementId: inst.engagementId,
          apsTaskRef: inst.apsTaskRef,
          findingId: inst.findingId,
          responseTaskId: inst.responseTaskId,
          createdAt: inst.createdAt,
          pushedAt: inst.pushedAt,
          actorId: inst.actorId,
          principalActorId: inst.principalActorId,
        },
        keyMetrics: [
          { label: "Detail type", value: detailType },
          { label: "Push state", value: inst.pushState },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.pushedAt ?? inst.createdAt,
        },
        scopeFiltered,
      };
    },
  };

  const productSpecReference: AtomRegistration<
    "product-spec-reference",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "product-spec-reference",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: [
      "product-spec-reference.created",
      "product-spec-reference.verified",
      "product-spec-reference.status-changed",
    ],
    // ADR-017: product-spec references are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"product-spec-reference">> => {
      const inst = await lookup.get<ProductSpecReferenceAtomInstance>(
        "product-spec-reference",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `product-spec-reference/${entityId}`,
        ) as ContextSummary<"product-spec-reference">;
      }
      const product = `${inst.product.name} (${inst.product.manufacturer})`;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${product} — ${inst.esrNumber}, status: ${inst.status} (verified ${inst.lastVerifiedAt}).`,
        `${inst.esrNumber} — ${inst.status}`,
      );
      return {
        prose,
        typed: {
          productName: inst.product.name,
          manufacturer: inst.product.manufacturer,
          esrNumber: inst.esrNumber,
          status: inst.status,
          lastVerifiedAt: inst.lastVerifiedAt,
          statusChangeCount: inst.statusHistory.length,
          engagementId: inst.engagementId,
          findingId: inst.findingId,
          responseTaskId: inst.responseTaskId,
          actorId: inst.actorId,
          principalActorId: inst.principalActorId,
        },
        keyMetrics: [
          { label: "ESR", value: inst.esrNumber },
          { label: "Status", value: inst.status },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.lastVerifiedAt,
        },
        scopeFiltered,
      };
    },
  };

  const deliverableLetterRender: AtomRegistration<
    "deliverable-letter-render",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "deliverable-letter-render",
    domain: "cortex",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    // Leaf composition: `sourceLetterRef` is a peer reference (the
    // render is derived-from, not owns, its source letter); consumers
    // resolve the DID themselves. Consistent with L1-L5 leaf shapes.
    composition: [],
    // A render is an immutable produced artifact — a single event type.
    eventTypes: ["deliverable-letter-render.produced"],
    // ADR-017: renders are engagement workflow data.
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"deliverable-letter-render">> => {
      const inst = await lookup.get<DeliverableLetterRenderAtomInstance>(
        "deliverable-letter-render",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `deliverable-letter-render/${entityId}`,
        ) as ContextSummary<"deliverable-letter-render">;
      }
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.format.toUpperCase()} render of ${inst.sourceLetterRef} (source version ${inst.sourceLetterVersion}), produced ${inst.renderedAt}.`,
        `${inst.format.toUpperCase()} render`,
      );
      return {
        prose,
        typed: {
          sourceLetterRef: inst.sourceLetterRef,
          sourceLetterVersion: inst.sourceLetterVersion,
          format: inst.format,
          blobRef: inst.blobRef,
          renderedAt: inst.renderedAt,
          renderedByActorId: inst.renderedByActorId,
        },
        keyMetrics: [
          { label: "Format", value: inst.format },
          { label: "Source letter", value: inst.sourceLetterRef },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.renderedAt,
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
  registry.register(responseTask);
  registry.register(sheetContentExtraction);
  registry.register(attachedDocument);
  registry.register(deliverableLetter);
  registry.register(detailCalloutSpec);
  registry.register(productSpecReference);
  registry.register(deliverableLetterRender);

  // -------------------------------------------------------------------
  // Brokerage workspace atoms — V1 per 2026-05-28 dispatch.
  // -------------------------------------------------------------------

  const propertyWorkspace: AtomRegistration<
    "property-workspace",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "property-workspace",
    domain: "brokerage",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [
      {
        childEntityType: "workspace-attachment",
        childMode: "compact",
        dataKey: "attachments",
        forwardRef: true,
      },
      {
        childEntityType: "brief-run",
        childMode: "compact",
        dataKey: "briefRuns",
        forwardRef: true,
      },
      {
        childEntityType: "workspace-share-edge",
        childMode: "compact",
        dataKey: "shareEdges",
        forwardRef: true,
      },
    ],
    eventTypes: [
      "property-workspace.created",
      "property-workspace.updated",
      "property-workspace.shared",
    ],
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"property-workspace">> => {
      const inst = await lookup.get<PropertyWorkspaceAtomInstance>(
        "property-workspace",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `property-workspace/${entityId}`,
        ) as ContextSummary<"property-workspace">;
      }
      const addr = `${inst.address.line1}, ${inst.address.city}, ${inst.address.stateOrProvince}`;
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Property workspace at ${addr}. Owner ${inst.owner.did}, ${inst.collaborators.length} collaborator(s), ${inst.listingUrls.length} listing URL(s).`,
        addr,
      );
      return {
        prose,
        typed: {
          did: inst.did,
          addressLine1: inst.address.line1,
          city: inst.address.city,
          ownerDid: inst.owner.did,
          collaboratorCount: inst.collaborators.length,
          listingUrlCount: inst.listingUrls.length,
          updatedAt: inst.updatedAt,
        },
        keyMetrics: [
          { label: "Owner", value: inst.owner.did },
          { label: "Listings", value: inst.listingUrls.length },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.updatedAt,
        },
        scopeFiltered,
      };
    },
  };

  const briefRun: AtomRegistration<
    "brief-run",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "brief-run",
    domain: "brokerage",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: ["brief-run.generated", "brief-run.revised"],
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"brief-run">> => {
      const inst = await lookup.get<BriefRunAtomInstance>("brief-run", entityId);
      if (!inst) {
        return notFoundSummary(`brief-run/${entityId}`) as ContextSummary<"brief-run">;
      }
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Brief run for ${inst.workspaceDid} — confidence ${inst.confidence}, ${inst.citationRefs.length} citation(s), generated ${inst.generatedAt}.`,
        `Brief (${Math.round(inst.confidence * 100)}% confidence)`,
      );
      return {
        prose,
        typed: {
          did: inst.did,
          workspaceDid: inst.workspaceDid,
          confidence: inst.confidence,
          citationCount: inst.citationRefs.length,
          generatedAt: inst.generatedAt,
        },
        keyMetrics: [
          { label: "Confidence", value: inst.confidence },
          { label: "Citations", value: inst.citationRefs.length },
        ],
        relatedAtoms: inst.citationRefs.map((ref) => ({
          kind: "atom" as const,
          entityType: parseCitationEntityType(ref.citationDid),
          entityId: parseCitationEntityId(ref.citationDid),
          displayLabel: ref.sourceType,
        })),
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.generatedAt,
        },
        scopeFiltered,
      };
    },
  };

  const workspaceAttachment: AtomRegistration<
    "workspace-attachment",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "workspace-attachment",
    domain: "brokerage",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "card",
    composition: [],
    eventTypes: ["workspace-attachment.added", "workspace-attachment.updated"],
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"workspace-attachment">> => {
      const inst = await lookup.get<WorkspaceAttachmentAtomInstance>(
        "workspace-attachment",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `workspace-attachment/${entityId}`,
        ) as ContextSummary<"workspace-attachment">;
      }
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `${inst.kind} attachment on ${inst.workspaceDid} uploaded by ${inst.uploader.did}.`,
        `${inst.kind} attachment`,
      );
      return {
        prose,
        typed: {
          did: inst.did,
          workspaceDid: inst.workspaceDid,
          kind: inst.kind,
          uploaderDid: inst.uploader.did,
          uri: inst.uri ?? null,
        },
        keyMetrics: [
          { label: "Kind", value: inst.kind },
          { label: "Workspace", value: inst.workspaceDid },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.updatedAt,
        },
        scopeFiltered,
      };
    },
  };

  const workspaceShareEdge: AtomRegistration<
    "workspace-share-edge",
    ["card", "compact", "inline", "expanded", "focus"]
  > = {
    entityType: "workspace-share-edge",
    domain: "brokerage",
    supportedModes: ["card", "compact", "inline", "expanded", "focus"] as const,
    defaultMode: "compact",
    composition: [],
    eventTypes: ["workspace-share-edge.created", "workspace-share-edge.revoked"],
    accessPolicy: "tenant-private",
    contextSummary: async (
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"workspace-share-edge">> => {
      const inst = await lookup.get<WorkspaceShareEdgeAtomInstance>(
        "workspace-share-edge",
        entityId,
      );
      if (!inst) {
        return notFoundSummary(
          `workspace-share-edge/${entityId}`,
        ) as ContextSummary<"workspace-share-edge">;
      }
      const { prose, scopeFiltered } = audienceLensesProse(
        scope,
        `Share edge ${inst.fromUserDid} → ${inst.toUserDid} on ${inst.workspaceDid} at ${inst.sharedAt}. Reshare ${inst.consentFlags.canReshare ? "allowed" : "denied"}.`,
        `Share ${inst.fromUserDid} → ${inst.toUserDid}`,
      );
      return {
        prose,
        typed: {
          did: inst.did,
          fromUserDid: inst.fromUserDid,
          toUserDid: inst.toUserDid,
          workspaceDid: inst.workspaceDid,
          sharedAt: inst.sharedAt,
          consentFlags: inst.consentFlags,
        },
        keyMetrics: [
          { label: "From", value: inst.fromUserDid },
          { label: "To", value: inst.toUserDid },
        ],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: `${inst.entityId}@${inst.contentHash}`,
          latestEventAt: inst.sharedAt,
        },
        scopeFiltered,
      };
    },
  };

  registry.register(propertyWorkspace);
  registry.register(briefRun);
  registry.register(workspaceAttachment);
  registry.register(workspaceShareEdge);

  return registry;
}

function parseCitationEntityId(citationDid: string): string {
  const parts = citationDid.split(":");
  return parts.slice(3).join(":");
}

function parseCitationEntityType(citationDid: string): string {
  const parts = citationDid.split(":");
  return parts[2] ?? "unknown";
}
