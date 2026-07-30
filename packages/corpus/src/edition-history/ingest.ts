import { createHash } from "node:crypto";

import type {
  AtomLink,
  CodeAmendmentAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import type { EditionBundle } from "./bundle.js";

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

export interface EditionIngestResult {
  editionsWritten: number;
  amendmentsWritten: number;
  corpusUpdated: boolean;
  editionEntityIds: ReadonlyArray<string>;
  /**
   * The jurisdiction-corpus `currentEditionId` after this ingest.
   * Advances on temporal supersession (latest open-ended edition);
   * preserved when only historical (closed) editions are added.
   */
  currentEditionId: string | null;
}

function buildTemporalAmendment(
  bundle: EditionBundle,
  entry: EditionBundle["entries"][number],
): CodeAmendmentAtomInstance | null {
  const ord = entry.adoptionOrdinance;
  if (!ord) return null;
  const entityId = `${bundle.jurisdictionTenant}/${ord.ordinanceId}`;
  return {
    entityType: "code-amendment",
    entityId,
    jurisdictionTenant: bundle.jurisdictionTenant,
    amendmentScope: "temporal",
    ordinanceId: ord.ordinanceId,
    effectiveDate: ord.effectiveDate,
    authority: ord.authority,
    affectedSectionIds: ord.affectedSectionIds ?? [],
    amendmentText: ord.amendmentText ?? ord.title,
    replacesSectionContentHash: null,
    fetchedAt: bundle.generatedAt,
    sourceAdapter: entry.edition.sourceAdapter,
    sourceUrl: ord.sourceUrl,
    contentHash: hashContent(
      "code-amendment",
      entityId,
      ord.effectiveDate,
      ord.title,
    ),
  };
}

function buildEditionAtom(
  bundle: EditionBundle,
  entry: EditionBundle["entries"][number],
  amendmentIds: ReadonlyArray<string>,
  sectionIds: ReadonlyArray<string> = [],
): CodeEditionAtomInstance {
  const e = entry.edition;
  return {
    entityType: "code-edition",
    entityId: e.entityId,
    jurisdictionTenant: bundle.jurisdictionTenant,
    editionLabel: e.editionLabel,
    effectiveFrom: e.effectiveFrom,
    effectiveTo: e.effectiveTo,
    sectionIds: [...sectionIds],
    amendmentIds: [...amendmentIds],
    fetchedAt: bundle.generatedAt,
    sourceAdapter: e.sourceAdapter,
    sourceUrl: e.sourceUrl,
    contentHash: hashContent(
      "code-edition",
      e.entityId,
      e.editionLabel,
      e.effectiveFrom,
      e.effectiveTo ?? "",
      ...sectionIds,
    ),
  };
}

/**
 * Pick the jurisdiction's current edition: the open-ended edition
 * (`effectiveTo == null`) with the latest `effectiveFrom`.
 *
 * Historical ingests that only add closed editions therefore leave an
 * existing open-ended pointer alone (WDLL CORRECTION B / historical
 * protection). A superseding open-ended edition advances the pointer.
 */
export function selectCurrentEditionId(
  editions: ReadonlyArray<
    Pick<CodeEditionAtomInstance, "entityId" | "effectiveFrom" | "effectiveTo">
  >,
  fallback: string | null,
): string | null {
  const openEnded = editions.filter((e) => e.effectiveTo == null);
  if (openEnded.length === 0) return fallback;
  const sorted = [...openEnded].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  return sorted[sorted.length - 1]?.entityId ?? fallback;
}

/**
 * Ingest a historical edition bundle from the acquisition agent.
 * Writes code-edition + temporal code-amendment atoms and updates the
 * jurisdiction-corpus adoption timeline for K2 edition-correct lookup.
 *
 * When `options.sections` is provided, section atoms are written, contains
 * links emitted, and the owning edition's `sectionIds` is filled.
 *
 * `currentEditionId` advances when the ingested (or already-adopted)
 * open-ended edition with the latest `effectiveFrom` supersedes the
 * prior pointer. Closed historical editions do not advance it.
 */
export async function ingestEditionBundle(
  storage: StoragePort,
  bundle: EditionBundle,
  options?: {
    sections?: ReadonlyArray<CodeSectionAtomInstance>;
  },
): Promise<EditionIngestResult> {
  const sortedEntries = [...bundle.entries].sort((a, b) =>
    a.edition.effectiveFrom.localeCompare(b.edition.effectiveFrom),
  );

  const sectionsByEdition = new Map<string, string[]>();
  if (options?.sections?.length) {
    for (const section of options.sections) {
      const list = sectionsByEdition.get(section.codeEditionId) ?? [];
      list.push(section.entityId);
      sectionsByEdition.set(section.codeEditionId, list);
    }
  }

  const editionEntityIds: string[] = [];
  let amendmentsWritten = 0;
  const links: AtomLink[] = [];

  for (const entry of sortedEntries) {
    const amendment = buildTemporalAmendment(bundle, entry);
    const amendmentIds: string[] = [];
    if (amendment) {
      await storage.writeAtom(amendment);
      amendmentsWritten++;
      amendmentIds.push(amendment.entityId);
      for (const sectionId of amendment.affectedSectionIds) {
        links.push({
          fromEntityType: "code-amendment",
          fromEntityId: amendment.entityId,
          toEntityType: "code-section",
          toEntityId: sectionId,
          linkType: "amends",
        });
      }
    }

    const sectionIds = sectionsByEdition.get(entry.edition.entityId) ?? [];
    const existingEdition = await storage.getAtom(
      "code-edition",
      entry.edition.entityId,
    );
    const mergedSectionIds = [
      ...new Set([
        ...(existingEdition?.entityType === "code-edition"
          ? existingEdition.sectionIds
          : []),
        ...sectionIds,
      ]),
    ];

    const edition = buildEditionAtom(
      bundle,
      entry,
      amendmentIds.length > 0
        ? amendmentIds
        : existingEdition?.entityType === "code-edition"
          ? existingEdition.amendmentIds
          : [],
      mergedSectionIds,
    );
    // Preserve non-empty amendmentIds already on a stub when the bundle
    // entry omits a fresh adoption ordinance.
    if (
      amendmentIds.length === 0 &&
      existingEdition?.entityType === "code-edition" &&
      existingEdition.amendmentIds.length > 0
    ) {
      edition.amendmentIds = [...existingEdition.amendmentIds];
    }
    await storage.writeAtom(edition);
    editionEntityIds.push(edition.entityId);
    links.push({
      fromEntityType: "jurisdiction-corpus",
      fromEntityId: bundle.jurisdictionTenant,
      toEntityType: "code-edition",
      toEntityId: edition.entityId,
      linkType: "contains",
    });
  }

  if (options?.sections?.length) {
    await storage.writeAtoms(options.sections);
    for (const section of options.sections) {
      links.push({
        fromEntityType: "code-edition",
        fromEntityId: section.codeEditionId,
        toEntityType: "code-section",
        toEntityId: section.entityId,
        linkType: "contains",
      });
    }
  }

  if (links.length > 0) await storage.writeAtomLinks(links);

  const statuses = await storage.listJurisdictionStatus();
  const existingStatus = statuses.find(
    (s) => s.jurisdictionTenant === bundle.jurisdictionTenant,
  );
  const existingCorpus = await storage.getAtom(
    "jurisdiction-corpus",
    bundle.jurisdictionTenant,
  );

  const adoptedEditionIds = [
    ...new Set([
      ...(existingCorpus?.entityType === "jurisdiction-corpus"
        ? existingCorpus.adoptedEditionIds
        : []),
      ...editionEntityIds,
    ]),
  ];

  const editionSnapshots: Array<
    Pick<CodeEditionAtomInstance, "entityId" | "effectiveFrom" | "effectiveTo">
  > = [];
  for (const id of adoptedEditionIds) {
    const ed = await storage.getAtom("code-edition", id);
    if (ed?.entityType === "code-edition") {
      editionSnapshots.push({
        entityId: ed.entityId,
        effectiveFrom: ed.effectiveFrom,
        effectiveTo: ed.effectiveTo,
      });
    }
  }

  const existingCurrent =
    existingCorpus?.entityType === "jurisdiction-corpus"
      ? existingCorpus.currentEditionId
      : null;
  const currentEditionId = selectCurrentEditionId(
    editionSnapshots,
    existingCurrent ??
      sortedEntries[sortedEntries.length - 1]?.edition.entityId ??
      null,
  );

  const corpusInst: JurisdictionCorpusAtomInstance = existingCorpus
    ? {
        ...existingCorpus,
        adoptedEditionIds,
        currentEditionId,
        lastRefreshedAt: bundle.generatedAt,
        fetchedAt: bundle.generatedAt,
      }
    : {
        entityType: "jurisdiction-corpus",
        entityId: bundle.jurisdictionTenant,
        jurisdictionTenant: bundle.jurisdictionTenant,
        jurisdictionName: bundle.jurisdictionName,
        adoptedEditionIds,
        currentEditionId,
        coverageQualityBar: existingStatus?.qualityBar ?? "not-evaluated",
        lastRefreshedAt: bundle.generatedAt,
        fetchedAt: bundle.generatedAt,
        sourceAdapter: sortedEntries[0]!.edition.sourceAdapter,
        sourceUrl: sortedEntries[0]!.edition.sourceUrl,
        contentHash: hashContent(
          "jurisdiction-corpus",
          bundle.jurisdictionTenant,
          bundle.jurisdictionName,
          ...adoptedEditionIds,
        ),
      };

  await storage.writeAtom(corpusInst);

  return {
    editionsWritten: editionEntityIds.length,
    amendmentsWritten,
    corpusUpdated: true,
    editionEntityIds,
    currentEditionId,
  };
}
