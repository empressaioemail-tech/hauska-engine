/**
 * Path C: live re-ingestion of a target jurisdiction's source via the
 * Stream 1A MunicodeHtmlAdapter in JSON mode.
 *
 * Per the 2026-05-19 dispatch, Bastrop UDC zoning sections are absent
 * from legacy `code_atoms` (the 189 atoms there are early CoO chapters
 * capped by `maxTocNodes: 30`). Path C re-ingests the UDC subtree
 * directly from Municode's JSON API, atomizes via the corpus pipeline,
 * and writes to the StoragePort the caller passes in.
 *
 * Zero Neon dependency — runs entirely against the public Municode
 * source + a StoragePort instance.
 */

import {
  MunicodeHtmlAdapter,
  type CodeReference,
} from "@hauska-engine/corpus/adapters";
import { atomize, type AtomizationResult } from "@hauska-engine/corpus/atomization";
import { buildCodeTree, reportExtractionQuality } from "@hauska-engine/corpus/extraction";
import type { StoragePort } from "@hauska-engine/storage";

export interface PathCIngestOptions {
  storage: StoragePort;
  jurisdictionTenant: string;
  jurisdictionName: string;
  editionLabel: string;
  /** Municode JSON-API config. */
  clientId: number;
  librarySlug: string;
  stateAbbr: string;
  /**
   * Top-level chapter filter regex. Required for Path C — the whole
   * point is to scope the walk to the UDC / zoning subtree.
   */
  chapterFilter: RegExp;
  /** Per-run leaf-fetch budget. Defaults to 60. */
  maxLeafFetches?: number;
  /** Optional pre-configured adapter (lets tests stub the walker). */
  adapter?: MunicodeHtmlAdapter;
}

export interface PathCIngestReport {
  jurisdictionTenant: string;
  sectionsIngested: number;
  definitionsIngested: number;
  crossReferencesIngested: number;
  crossReferencesResolved: number;
  amendmentsIngested: number;
  editionEntityId: string;
  jurisdictionCorpusEntityId: string;
  atomLinksEmitted: number;
  /** Extraction-quality report from Stream 1B for the assembled corpus. */
  extractionQuality: ReturnType<typeof reportExtractionQuality>;
  /** Sample of the first 25 ingested section entityIds + numbers + titles. */
  sectionSample: ReadonlyArray<{
    entityId: string;
    sectionNumber: string;
    title: string;
  }>;
}

export interface PathCIngestResult {
  report: PathCIngestReport;
  atomization: AtomizationResult;
}

export async function runPathCIngest(
  options: PathCIngestOptions,
): Promise<PathCIngestResult> {
  const adapter =
    options.adapter ??
    new MunicodeHtmlAdapter({
      clientId: options.clientId,
      librarySlug: options.librarySlug,
      stateAbbr: options.stateAbbr,
      chapterFilter: options.chapterFilter,
      ...(options.maxLeafFetches !== undefined
        ? { maxLeafFetches: options.maxLeafFetches }
        : {}),
    });

  const reference: CodeReference = {
    sourceId: `${options.clientId}:${options.librarySlug}:${options.stateAbbr}:${options.jurisdictionTenant}-udc`,
    jurisdictionTenant: options.jurisdictionTenant,
    editionLabel: options.editionLabel,
    sourceUrl: `https://library.municode.com/${options.stateAbbr.toLowerCase()}/${options.librarySlug}/codes/code_of_ordinances`,
  };

  const raw = await adapter.fetch(reference);
  const normalized = await adapter.normalize(raw);
  const tree = buildCodeTree({
    ...normalized,
    metadata: {
      ...normalized.metadata,
      jurisdictionName: options.jurisdictionName,
    },
  });
  const extractionQuality = reportExtractionQuality(tree);
  const rawAtomization = atomize(tree);
  // Dedupe sections by entityId — the Municode JSON walker can emit
  // the same Doc through multiple TOC paths (intermediate-article
  // envelopes overlap). Mirrors the Path B transformBatch policy:
  // keep the first occurrence; the storage writeAtoms call would
  // overwrite-on-second-write anyway, but dedupe here so the report
  // counts reflect post-storage reality.
  const sectionSeen = new Set<string>();
  const dedupedSections = rawAtomization.sections.filter((s) => {
    if (sectionSeen.has(s.entityId)) return false;
    sectionSeen.add(s.entityId);
    return true;
  });
  const xrefSeen = new Set<string>();
  const dedupedXrefs = rawAtomization.crossReferences.filter((x) => {
    if (xrefSeen.has(x.entityId)) return false;
    xrefSeen.add(x.entityId);
    return true;
  });
  const editionSeen = new Set<string>();
  const dedupedEditions = (() => {
    const out: typeof rawAtomization.edition[] = [];
    if (!editionSeen.has(rawAtomization.edition.entityId)) {
      editionSeen.add(rawAtomization.edition.entityId);
      out.push(rawAtomization.edition);
    }
    return out;
  })();
  // Rebuild edition.sectionIds to match the deduped list so composition
  // edges stay coherent.
  const dedupedEdition = {
    ...rawAtomization.edition,
    sectionIds: dedupedSections.map((s) => s.entityId),
  };
  // Dedupe links by (from, to, linkType) tuple.
  const linkKey = (l: typeof rawAtomization.links[number]) =>
    `${l.fromEntityType}/${l.fromEntityId}->${l.toEntityType}/${l.toEntityId}@${l.linkType}`;
  const linkSeen = new Set<string>();
  const dedupedLinks = rawAtomization.links.filter((l) => {
    const k = linkKey(l);
    if (linkSeen.has(k)) return false;
    linkSeen.add(k);
    return true;
  });
  const atomization = {
    ...rawAtomization,
    edition: dedupedEdition,
    sections: dedupedSections,
    crossReferences: dedupedXrefs,
    links: dedupedLinks,
  };

  await options.storage.writeAtoms([
    atomization.jurisdictionCorpus,
    ...dedupedEditions,
    ...dedupedSections,
    ...atomization.definitions,
    ...dedupedXrefs,
    ...atomization.amendments,
  ]);
  await options.storage.writeAtomLinks(dedupedLinks);
  await options.storage.upsertJurisdictionStatus({
    jurisdictionTenant: atomization.jurisdictionCorpus.jurisdictionTenant,
    jurisdictionName: atomization.jurisdictionCorpus.jurisdictionName,
    currentEditionDid: `did:hauska:code-edition:${atomization.edition.entityId}`,
    qualityBar: "not-evaluated",
    top3Score: null,
    sectionNumScore: null,
    crossRefScore: null,
    atomCount: atomization.sections.length,
    lastRefreshedAt: atomization.edition.fetchedAt,
    driftStatus: "clean",
  });

  const resolvedXrefs = atomization.crossReferences.filter(
    (x) => x.toSectionId !== "",
  );

  const sectionSample = atomization.sections.slice(0, 25).map((s) => ({
    entityId: s.entityId,
    sectionNumber: s.sectionNumber,
    title: s.title,
  }));

  return {
    report: {
      jurisdictionTenant: options.jurisdictionTenant,
      sectionsIngested: atomization.sections.length,
      definitionsIngested: atomization.definitions.length,
      crossReferencesIngested: atomization.crossReferences.length,
      crossReferencesResolved: resolvedXrefs.length,
      amendmentsIngested: atomization.amendments.length,
      editionEntityId: atomization.edition.entityId,
      jurisdictionCorpusEntityId: atomization.jurisdictionCorpus.entityId,
      atomLinksEmitted: atomization.links.length,
      extractionQuality,
      sectionSample,
    },
    atomization,
  };
}
