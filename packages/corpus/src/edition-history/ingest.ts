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
): CodeEditionAtomInstance {
  const e = entry.edition;
  return {
    entityType: "code-edition",
    entityId: e.entityId,
    jurisdictionTenant: bundle.jurisdictionTenant,
    editionLabel: e.editionLabel,
    effectiveFrom: e.effectiveFrom,
    effectiveTo: e.effectiveTo,
    sectionIds: [],
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
    ),
  };
}

/**
 * Ingest a historical edition bundle from the acquisition agent.
 * Writes code-edition + temporal code-amendment atoms and updates the
 * jurisdiction-corpus adoption timeline for K2 edition-correct lookup.
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

    const edition = buildEditionAtom(bundle, entry, amendmentIds);
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

  const adoptedEditionIds = editionEntityIds;
  const currentEditionId =
    sortedEntries[sortedEntries.length - 1]?.edition.entityId ?? null;

  const corpusInst: JurisdictionCorpusAtomInstance = existingCorpus
    ? {
        ...existingCorpus,
        adoptedEditionIds: [
          ...new Set([
            ...existingCorpus.adoptedEditionIds,
            ...adoptedEditionIds,
          ]),
        ],
        currentEditionId:
          currentEditionId ?? existingCorpus.currentEditionId,
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
  };
}
