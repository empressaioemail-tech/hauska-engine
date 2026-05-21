/**
 * Path PDF: live re-ingestion of a publisher-hosted, born-digital PDF
 * via the Stream 1A RawPdfAdapter.
 *
 * First raw-PDF jurisdiction onboarded under this orchestrator: Bastrop
 * Building Block (B3) Code (April 2025) at
 * `cityofbastrop.org/upload/page/0107/docs/B3/B3 Code - April 2025.pdf`,
 * per the 2026-05-19 Sync 4.5 dispatch. The Bastrop UDC zoning rules
 * live outside Municode (Chapter 14 on Municode contains only adoption-
 * pointer sections; the actual B3 rules are on the city's own site as
 * a PDF). Path C against Municode covered Chapter 14 in PR #2; Path PDF
 * covers the B3 rule text itself.
 *
 * Implementation mirrors `runPathCIngest` (Municode JSON walker) — same
 * post-fetch atomization pipeline, same dedupe-by-entityId discipline.
 */

import type { AccessPolicy } from "@hauska-engine/atoms";
import {
  RawPdfAdapter,
  pdfjsTextExtractor,
  type CodeReference,
  type PdfNormalizeOptions,
  type PdfTextExtractor,
} from "@hauska-engine/corpus/adapters";
import { atomize, type AtomizationResult } from "@hauska-engine/corpus/atomization";
import {
  buildCodeTree,
  reportExtractionQuality,
} from "@hauska-engine/corpus/extraction";
import type { StoragePort } from "@hauska-engine/storage";

import {
  buildSectionsByEdition,
  sniffCrossReferences,
} from "./synthesize-xrefs.js";

export interface PathPdfIngestOptions {
  storage: StoragePort;
  jurisdictionTenant: string;
  jurisdictionName: string;
  editionLabel: string;
  /** PDF source URL (the publisher's canonical link for citation). */
  pdfUrl: string;
  /**
   * Adapter capabilities name override. Defaults to a publisher-specific
   * tag (`bastrop-b3-pdf`) for atom-provenance clarity when multiple
   * raw-PDF jurisdictions share the registry. Optional.
   */
  capabilitiesName?: string;
  /** Adapter capabilities display-name override. Optional. */
  capabilitiesDisplayName?: string;
  /**
   * Normalize-time options forwarded to the RawPdfAdapter. Carries the
   * per-source heading convention (`headingConvention`) and any custom
   * header/footer suppression regex. Optional; the adapter defaults to
   * the caps-prefixed B3 convention.
   */
  normalizeOptions?: PdfNormalizeOptions;
  /** Optional pre-configured adapter (lets tests stub the extractor). */
  adapter?: RawPdfAdapter;
  /**
   * Optional text-extractor override. Defaults to the pdfjs-dist
   * born-digital extractor. Tests inject canned page text.
   */
  textExtractor?: PdfTextExtractor;
  /**
   * ADR-017 access tier tagged onto the emitted `jurisdiction-corpus`
   * atom + `jurisdictionStatus` row. Partnership-pending jurisdictions
   * pass `"platform-internal"`; partnership-confirmed pass
   * `"public-free"` (also the default when omitted).
   */
  accessPolicy?: AccessPolicy;
}

export interface PathPdfIngestReport {
  jurisdictionTenant: string;
  sectionsIngested: number;
  definitionsIngested: number;
  crossReferencesIngested: number;
  crossReferencesResolved: number;
  crossReferencesUnresolvedSkipped: number;
  amendmentsIngested: number;
  editionEntityId: string;
  jurisdictionCorpusEntityId: string;
  atomLinksEmitted: number;
  extractionQuality: ReturnType<typeof reportExtractionQuality>;
  sectionSample: ReadonlyArray<{
    entityId: string;
    sectionNumber: string;
    title: string;
  }>;
  accessPolicy: AccessPolicy;
}

export interface PathPdfIngestResult {
  report: PathPdfIngestReport;
  atomization: AtomizationResult;
}

export async function runPathPdfIngest(
  options: PathPdfIngestOptions,
): Promise<PathPdfIngestResult> {
  const adapter =
    options.adapter ??
    new RawPdfAdapter({
      textExtractor: options.textExtractor ?? pdfjsTextExtractor,
      capabilitiesNameOverride: options.capabilitiesName ?? "bastrop-b3-pdf",
      capabilitiesDisplayNameOverride:
        options.capabilitiesDisplayName ?? "Bastrop B3 Code (PDF)",
      ...(options.normalizeOptions
        ? { normalizeOptions: options.normalizeOptions }
        : {}),
    });

  const reference: CodeReference = {
    sourceId: `${options.jurisdictionTenant}-${slugFromUrl(options.pdfUrl)}`,
    jurisdictionTenant: options.jurisdictionTenant,
    editionLabel: options.editionLabel,
    sourceUrl: options.pdfUrl,
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
  const accessPolicy: AccessPolicy = options.accessPolicy ?? "public-free";
  const rawAtomization = atomize(tree, { accessPolicy });

  // Dedupe sections by entityId. Born-digital PDF walks don't typically
  // emit the same section twice, but the dedupe matches Path C
  // discipline so a future PDF source that does fan out (e.g., a multi-
  // volume code with overlapping appendix sections) doesn't surprise
  // the storage layer. When the same section number IS emitted twice
  // (e.g. a per-chapter mini-table-of-contents entry that survived the
  // normalizer plus the real body heading), keep the instance with the
  // most body text so the atom carries the rule prose, not a bare TOC
  // line.
  const richestByEntityId = new Map<
    string,
    typeof rawAtomization.sections[number]
  >();
  for (const s of rawAtomization.sections) {
    const existing = richestByEntityId.get(s.entityId);
    if (
      !existing ||
      (s.bodyText?.length ?? 0) > (existing.bodyText?.length ?? 0)
    ) {
      richestByEntityId.set(s.entityId, s);
    }
  }
  const dedupedSections = rawAtomization.sections.filter(
    (s) => richestByEntityId.get(s.entityId) === s,
  );
  const dedupedEdition = {
    ...rawAtomization.edition,
    sectionIds: dedupedSections.map((s) => s.entityId),
  };

  // Drop atomize()-emitted cross-references; the body-level sniff
  // pass below is the canonical source. atomize() builds toSectionId
  // by string-construction without checking that the target exists in
  // the corpus; this resolves to dangling pointers when xrefs name
  // articles ("1.4") or chapters ("2") that don't have section atoms.
  // Per ADR-010 §Link taxonomy, code-cross-reference is an in-corpus
  // pointer; the sniffer drops non-resolving labels (external citations
  // stay in section bodyText as prose).
  const sectionsByEdition = buildSectionsByEdition(dedupedSections);
  const xrefResult = sniffCrossReferences({
    sections: dedupedSections,
    sectionsByEdition,
  });
  const resolvedXrefs = xrefResult.crossReferences;
  // Drop atomize()-emitted cross-reference links (linkType matches the
  // referenceType mapping in atomize.ts); keep composition + amendment
  // links. We re-emit cross-reference links from the sniffer's output.
  const XREF_LINK_TYPES = new Set([
    "see-also",
    "subject-to",
    "as-defined-in",
    "cites",
  ]);
  const compositionAndAmendmentLinks = rawAtomization.links.filter((l) => {
    if (
      l.fromEntityType === "code-section" &&
      l.toEntityType === "code-section" &&
      XREF_LINK_TYPES.has(l.linkType)
    ) {
      return false;
    }
    return true;
  });
  const linkKey = (l: typeof rawAtomization.links[number]) =>
    `${l.fromEntityType}/${l.fromEntityId}->${l.toEntityType}/${l.toEntityId}@${l.linkType}`;
  const linkSeen = new Set<string>();
  const dedupedLinks = [
    ...compositionAndAmendmentLinks,
    ...xrefResult.links,
  ].filter((l) => {
    const k = linkKey(l);
    if (linkSeen.has(k)) return false;
    linkSeen.add(k);
    return true;
  });

  await options.storage.writeAtoms([
    rawAtomization.jurisdictionCorpus,
    dedupedEdition,
    ...dedupedSections,
    ...rawAtomization.definitions,
    ...resolvedXrefs,
    ...rawAtomization.amendments,
  ]);
  await options.storage.writeAtomLinks(dedupedLinks);
  await options.storage.upsertJurisdictionStatus({
    jurisdictionTenant: rawAtomization.jurisdictionCorpus.jurisdictionTenant,
    jurisdictionName: rawAtomization.jurisdictionCorpus.jurisdictionName,
    currentEditionDid: `did:hauska:code-edition:${rawAtomization.edition.entityId}`,
    qualityBar: "not-evaluated",
    top3Score: null,
    sectionNumScore: null,
    crossRefScore: null,
    atomCount: dedupedSections.length,
    lastRefreshedAt: rawAtomization.edition.fetchedAt,
    driftStatus: "clean",
    accessPolicy,
  });

  const sectionSample = dedupedSections.slice(0, 25).map((s) => ({
    entityId: s.entityId,
    sectionNumber: s.sectionNumber,
    title: s.title,
  }));

  return {
    report: {
      jurisdictionTenant: options.jurisdictionTenant,
      sectionsIngested: dedupedSections.length,
      definitionsIngested: rawAtomization.definitions.length,
      // Per ADR-010 clean reading, only in-corpus-resolving xrefs are
      // emitted; unresolved labels are tallied separately for
      // diagnostics but not surfaced as atoms.
      crossReferencesIngested: resolvedXrefs.length,
      crossReferencesResolved: resolvedXrefs.length,
      crossReferencesUnresolvedSkipped: xrefResult.unresolvedCount,
      amendmentsIngested: rawAtomization.amendments.length,
      editionEntityId: rawAtomization.edition.entityId,
      jurisdictionCorpusEntityId: rawAtomization.jurisdictionCorpus.entityId,
      atomLinksEmitted: dedupedLinks.length,
      extractionQuality,
      sectionSample,
      accessPolicy,
    },
    atomization: {
      ...rawAtomization,
      edition: dedupedEdition,
      sections: dedupedSections,
      crossReferences: resolvedXrefs,
      links: dedupedLinks,
    },
  };
}

function slugFromUrl(url: string): string {
  // Strip protocol, host, and non-alphanumerics. Keeps the document
  // basename (e.g., "b3-code-april-2025") for human-readable provenance.
  return url
    .replace(/^https?:\/\/[^/]+\//i, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
