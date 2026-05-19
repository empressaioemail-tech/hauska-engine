/**
 * End-to-end migration: read legacy rows, transform, synthesize
 * editions + corpora + cross-references, write to a StoragePort.
 *
 * The orchestrator is storage-port-agnostic; pass `InMemoryStorage`
 * for dry-run / eval, or the Postgres-backed port (once it lands)
 * for production write.
 */

import type {
  CodeAmendmentAtomInstance,
  CodeCrossReferenceAtomInstance,
  CodeDefinitionAtomInstance,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
  AtomLink,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import type { LegacyClient } from "./legacy-client.js";
import { transformBatch, type TransformBatchResult } from "./transform.js";
import {
  buildJurisdictionDisplayNames,
  buildEditionLabelMap,
} from "./edition-labels.js";
import { synthesizeEditionsAndCorpora } from "./synthesize-editions.js";
import {
  buildSectionsByEdition,
  sniffCrossReferences,
} from "./synthesize-xrefs.js";

export interface MigrationFilter {
  jurisdictionKey?: string;
  codeBook?: string;
  /**
   * Optional explicit allow-list of code books within the jurisdiction.
   * Mutually-supportive with `codeBook` (single). When provided,
   * legacy code_atoms rows whose code_book is not in the list are
   * dropped post-fetch.
   */
  codeBooks?: ReadonlyArray<string>;
}

export interface MigrationReport {
  filter: MigrationFilter | null;
  sectionsTransformed: number;
  sectionsDroppedNullSection: number;
  sectionsDroppedEmptyBody: number;
  sectionCollisions: TransformBatchResult["collisions"];
  editionsSynthesized: number;
  corporaSynthesized: number;
  crossReferencesSynthesized: number;
  crossReferencesResolved: number;
  crossReferencesUnresolvedSkipped: number;
  amendmentsSynthesized: number;
  definitionsSynthesized: number;
  /** Composition + cross-reference + amendment edges combined. */
  atomLinksEmitted: number;
}

export interface MigrationResult {
  report: MigrationReport;
  /** All atoms written to storage. Useful for downstream eval. */
  sections: ReadonlyArray<CodeSectionAtomInstance>;
  editions: ReadonlyArray<CodeEditionAtomInstance>;
  corpora: ReadonlyArray<JurisdictionCorpusAtomInstance>;
  crossReferences: ReadonlyArray<CodeCrossReferenceAtomInstance>;
  definitions: ReadonlyArray<CodeDefinitionAtomInstance>;
  amendments: ReadonlyArray<CodeAmendmentAtomInstance>;
  links: ReadonlyArray<AtomLink>;
}

export interface RunMigrationOptions {
  legacy: LegacyClient;
  storage: StoragePort;
  filter?: MigrationFilter;
}

export async function runMigration(
  options: RunMigrationOptions,
): Promise<MigrationResult> {
  const sources = await options.legacy.listSources();
  const sourceNameById = new Map<string, string>();
  for (const source of sources) {
    sourceNameById.set(source.id, source.source_name);
  }

  const rawRows = await options.legacy.readAtoms(options.filter ?? {});
  const allowedBooks = options.filter?.codeBooks
    ? new Set(options.filter.codeBooks)
    : null;
  const rows = allowedBooks
    ? rawRows.filter((r) => allowedBooks.has(r.code_book))
    : rawRows;
  const transformResult = transformBatch(rows, { sourceNameById });

  const editionLabels = buildEditionLabelMap();
  const displayNames = buildJurisdictionDisplayNames();

  const synthResult = synthesizeEditionsAndCorpora({
    jurisdictionDisplayNames: displayNames,
    sections: transformResult.instances,
    editionLabels,
  });

  const sectionsByEdition = buildSectionsByEdition(transformResult.instances);
  const xrefResult = sniffCrossReferences({
    sections: transformResult.instances,
    sectionsByEdition,
  });

  const definitions: CodeDefinitionAtomInstance[] = [];
  const amendments: CodeAmendmentAtomInstance[] = [];

  await options.storage.writeAtoms([
    ...transformResult.instances,
    ...synthResult.editions,
    ...synthResult.corpora,
    ...xrefResult.crossReferences,
  ]);
  const allLinks: AtomLink[] = [
    ...synthResult.compositionLinks,
    ...xrefResult.links,
  ];
  await options.storage.writeAtomLinks(allLinks);

  for (const corpus of synthResult.corpora) {
    await options.storage.upsertJurisdictionStatus({
      jurisdictionTenant: corpus.jurisdictionTenant,
      jurisdictionName: corpus.jurisdictionName,
      currentEditionDid: corpus.currentEditionId
        ? `did:hauska:code-edition:${corpus.currentEditionId}`
        : null,
      qualityBar: "not-evaluated",
      top3Score: null,
      sectionNumScore: null,
      crossRefScore: null,
      atomCount: transformResult.instances.filter(
        (s) => s.jurisdictionTenant === corpus.jurisdictionTenant,
      ).length,
      lastRefreshedAt: corpus.lastRefreshedAt,
      driftStatus: "clean",
    });
  }

  // Post-2026-05-19 policy: synthesize-xrefs only emits resolved
  // refs; unresolvedCount tracks "would-be xrefs that didn't resolve"
  // for diagnostic purposes but doesn't appear in the emitted
  // crossReferences list.
  const resolvedXrefs = xrefResult.crossReferences.length;

  return {
    report: {
      filter: options.filter ?? null,
      sectionsTransformed: transformResult.instances.length,
      sectionsDroppedNullSection: transformResult.droppedNullSection,
      sectionsDroppedEmptyBody: transformResult.droppedEmptyBody,
      sectionCollisions: transformResult.collisions,
      editionsSynthesized: synthResult.editions.length,
      corporaSynthesized: synthResult.corpora.length,
      crossReferencesSynthesized: xrefResult.crossReferences.length,
      crossReferencesResolved: resolvedXrefs,
      crossReferencesUnresolvedSkipped: xrefResult.unresolvedCount,
      amendmentsSynthesized: amendments.length,
      definitionsSynthesized: definitions.length,
      atomLinksEmitted: allLinks.length,
    },
    sections: transformResult.instances,
    editions: synthResult.editions,
    corpora: synthResult.corpora,
    crossReferences: xrefResult.crossReferences,
    definitions,
    amendments,
    links: allLinks,
  };
}
