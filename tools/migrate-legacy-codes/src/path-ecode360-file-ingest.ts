import { readFileSync } from "node:fs";

/**
 * Path eCode360 File: offline re-ingestion of a pre-fetched, already-
 * normalized eCode360 JSON artifact (a `NormalizedCode` document
 * produced by `ECode360Adapter.normalize()` in an earlier run and
 * saved to disk), skipping the live `adapter.fetch()`/`adapter.normalize()`
 * network path entirely.
 *
 * First target: Smithville, TX (eCode360 `custId` SM6484), per the
 * OPS-9 S3 ingest dispatch (2026-08-04). The live crawl (0.5 rps civil
 * UA, robots-gated, per `packages/corpus/src/adapters/ecode360/index.ts`)
 * was already run and its normalized output saved to
 * `smithville-normalized-2026-08-04.json` (4,366 blocks; 836 depth-5
 * section headings; metadata.jurisdictionTenant recorded in the file
 * as "smithville-tx" — the hyphenated form the live crawl used).
 *
 * This orchestrator reads that JSON directly (`readFileSync` +
 * `JSON.parse`), overriding `metadata.jurisdictionTenant` at read time
 * to the underscore convention (`smithville_tx`) this repo's other
 * tenants use (Bastrop `bastrop_tx`, Elgin `elgin_tx`) — the artifact
 * file itself is never edited; the override happens in this shim only.
 * From there the pipeline is identical to `runPathPdfIngest`:
 * `buildCodeTree()` -> `atomize()` -> the dedupe-by-entityId pass ->
 * the xref-resniff pass -> storage writes -> report.
 *
 * DEPTH-SCHEMA EVIDENCE (verified against the artifact directly, not
 * assumed from the working hypothesis in the dispatch): the artifact's
 * heading depth distribution is `{1: 1, 3: 6, 4: 2, 5: 836}` — there is
 * NO depth-2 in this document at all. The 8 non-depth-5, non-depth-1
 * headings, verbatim from the artifact:
 *
 *   depth 3, label "Division 1": "Division 1: Generally"
 *   depth 3, label "Division 2": "Division 2: Claims for Damages Against City"
 *   depth 3, label "ARTICLE 7.01": "ARTICLE 7.01: GENERAL PROVISIONS"
 *   depth 3, label "ARTICLE 7.02": "ARTICLE 7.02: FINES, COSTS AND SPECIAL EXPENSES"
 *   depth 3, label "ARTICLE 10.01": "ARTICLE 10.01: GENERAL PROVISIONS (RESERVED)"
 *   depth 3, label "ARTICLE 10.02": "ARTICLE 10.02: SUBDIVISION ORDINANCE"
 *   depth 4, label "Part I": "Part I: In General"
 *   depth 4, label "Part II": "Part II: Citizen Comments"
 *
 * The working hypothesis in the dispatch ({1: chapter, 3: article,
 * 4: division, 5: section}) is CORRECTED by this evidence: depth 3 is
 * not uniformly "article" — it carries both "Division N" and
 * "ARTICLE N.NN" labels (both are the code's own intermediate grouping
 * directly above sections, one level below the implicit chapter
 * numbering baked into the section-number prefix — e.g. "1.02.xxx"
 * sections sit under "Division 1"/"Division 2" at depth 3, and
 * "7.01.xxx"/"7.02.xxx" sections sit under "ARTICLE 7.01"/"ARTICLE
 * 7.02" at the same depth). Depth 4 ("Part I"/"Part II") nests one
 * level deeper than depth 3, scoped inside a single division (both
 * observed Part headings sit inside the depth-3 node containing
 * "1.03.0xx" sections). There is no depth-1 "chapter" heading in the
 * body at all — depth 1 is only the synthetic whole-document "Table of
 * Contents - {jurisdictionName}" heading `ECode360Adapter.normalize()`
 * always emits; chapter identity lives implicitly in the section-number
 * prefix ("1.02.041" = chapter 1), never as its own heading block.
 *
 * This matches the adapter's own verified mapping (`CONTENT_TYPE_DEPTH`
 * in `ecode360/index.ts`, confirmed against 2,204 markers across 155
 * saved pages): `part` -> 3, `article` -> 3, `subarticle` -> 4,
 * `section` -> 5. Both `part`-type and `article`-type DOM markers
 * collapse to depth 3 (matching "Division" and "ARTICLE" both showing
 * up there); `subarticle`-type markers are depth 4 ("Part I"/"Part
 * II" are eCode360 `subarticle`-type nodes despite the "Part" label
 * text — the DOM content-type, not the label word, is what the
 * adapter keyed its depth on).
 *
 * `buildCodeTree`'s `ExtractorOptions.headingDepthSchema` vocabulary
 * (`chapter | article | division | section | subsection`) has no
 * separate "part"/"subarticle" kind, so both depth-3 and depth-4 must
 * map onto the existing container kinds. Structurally this is a no-op
 * choice: `atomize()`'s `visit()` treats `chapter`/`article`/`division`
 * identically (pure pass-through containers that recurse into their
 * children without emitting an atom themselves — see
 * `packages/corpus/src/atomization/index.ts` `visit()`'s
 * `case "chapter": case "article": case "division":` fallthrough) — no
 * atom, link, or entityId anywhere in the pipeline is sensitive to
 * which of the three container kinds a given depth maps to. This
 * schema picks the label that reads most naturally against the
 * evidence: depth 3 -> "division" (the intermediate grouping directly
 * containing sections within an implicit chapter), depth 4 -> "article"
 * (the finer subdivision nested inside a division). Depth 1 keeps the
 * extractor's own default ("chapter") since it only ever fires on the
 * synthetic whole-document ToC heading, which has no sections nested
 * under it and produces no observable atom either way.
 */

import type { AccessPolicy } from "@hauska-engine/atoms";
import type { NormalizedCode } from "@hauska-engine/corpus/adapters";
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

/**
 * Mirrors `ExtractorOptions["headingDepthSchema"]`'s shape
 * (`packages/corpus/src/extraction/extractor.ts`) locally — that type
 * is not re-exported from the package's `./extraction` entry point
 * (only `buildCodeTree`/`reportExtractionQuality` and the `types.ts`
 * structural-node types are), so this tool defines its own alias
 * rather than reaching past the package's public surface.
 */
export type HeadingDepthSchema = Record<
  number,
  "chapter" | "article" | "division" | "section" | "subsection"
>;

/**
 * Depth -> structural-kind schema for eCode360 file artifacts, finalized
 * from the evidence in this file's header comment (verified against the
 * Smithville artifact's 8 non-section, non-synthetic headings). See
 * that comment for the full verbatim evidence and reasoning.
 */
export const ECODE360_DEPTH_SCHEMA: HeadingDepthSchema = {
  1: "chapter",
  3: "division",
  4: "article",
  5: "section",
};

export interface PathEcode360FileIngestOptions {
  storage: StoragePort;
  /**
   * Tenant slug override applied to the artifact's `metadata` at read
   * time. The artifact on disk carries whatever slug the live crawl
   * happened to use (e.g. "smithville-tx", hyphenated); this repo's
   * tenant convention is underscore ("smithville_tx"). The artifact
   * file itself is never rewritten — the override is applied to the
   * in-memory `NormalizedCode.metadata` only, before `buildCodeTree()`.
   */
  jurisdictionTenant: string;
  jurisdictionName: string;
  editionLabel: string;
  /** Local filesystem path to the pre-fetched, normalized JSON artifact. */
  normalizedFilePath: string;
  /**
   * Optional pre-loaded artifact (lets tests inject a small fixture
   * slice instead of reading a file). When provided, `normalizedFilePath`
   * is not read.
   */
  normalized?: NormalizedCode;
  /** Depth->kind schema override. Defaults to `ECODE360_DEPTH_SCHEMA`. */
  headingDepthSchema?: HeadingDepthSchema;
  /**
   * ADR-017 access tier tagged onto the emitted `jurisdiction-corpus`
   * atom + `jurisdictionStatus` row. Passed explicitly by every caller
   * of this orchestrator per the 2026-08-04 build ruling (no default
   * fallthrough to `"public-free"` for this path — Smithville is
   * partnership-pending, `"platform-internal"`).
   */
  accessPolicy: AccessPolicy;
}

export interface PathEcode360FileIngestReport {
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

export interface PathEcode360FileIngestResult {
  report: PathEcode360FileIngestReport;
  atomization: AtomizationResult;
}

export async function runPathEcode360FileIngest(
  options: PathEcode360FileIngestOptions,
): Promise<PathEcode360FileIngestResult> {
  const rawNormalized: NormalizedCode =
    options.normalized ??
    (JSON.parse(
      readFileSync(options.normalizedFilePath, "utf8"),
    ) as NormalizedCode);

  // Override tenant/name/edition at read time only — never mutate the
  // artifact on disk. sourceAdapter is preserved from the artifact
  // (ECode360Adapter's own capabilities.name, "ecode360-html") since
  // that's genuinely how this content was sourced, even though this
  // particular run skips the live fetch/normalize call.
  const normalized: NormalizedCode = {
    ...rawNormalized,
    metadata: {
      ...rawNormalized.metadata,
      jurisdictionTenant: options.jurisdictionTenant,
      jurisdictionName: options.jurisdictionName,
      editionLabel: options.editionLabel,
    },
  };

  const tree = buildCodeTree(normalized, {
    headingDepthSchema: options.headingDepthSchema ?? ECODE360_DEPTH_SCHEMA,
  });
  const extractionQuality = reportExtractionQuality(tree);
  const accessPolicy: AccessPolicy = options.accessPolicy;
  if (!accessPolicy) {
    throw new Error("accessPolicy is required for eCode360 file ingest");
  }
  const rawAtomization = atomize(tree, { accessPolicy });

  // Dedupe sections by entityId — verbatim from path-pdf-ingest.ts.
  // eCode360's own adapter already runs a content-hash dedupe pass at
  // normalize() time (see ECode360Adapter.dedupeSectionBlocks()), but
  // this orchestrator-level pass matches Path PDF discipline so a
  // section that survives the adapter's dedupe under two different
  // labels (e.g. a per-division mini-summary vs. the real body heading)
  // still collapses to its richest instance here.
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

  // Drop atomize()-emitted cross-references; the body-level sniff pass
  // below is the canonical source — verbatim from path-pdf-ingest.ts.
  // Per ADR-010 §Link taxonomy, code-cross-reference is an in-corpus
  // pointer; the sniffer drops non-resolving labels (external citations
  // stay in section bodyText as prose).
  const sectionsByEdition = buildSectionsByEdition(dedupedSections);
  const xrefResult = sniffCrossReferences({
    sections: dedupedSections,
    sectionsByEdition,
  });
  const resolvedXrefs = xrefResult.crossReferences;
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

/**
 * Mirrors `ECode360Adapter.capabilities.name` (`packages/corpus/src/
 * adapters/ecode360/index.ts`) as a literal so callers don't need to
 * instantiate the adapter just to read this string — the artifact's own
 * `metadata.sourceAdapter` already carries this value from the original
 * live crawl and is preserved as-is through the read-time override
 * above (only tenant/name/edition are overridden).
 */
export const ECODE360_SOURCE_ADAPTER_NAME = "ecode360-html";
