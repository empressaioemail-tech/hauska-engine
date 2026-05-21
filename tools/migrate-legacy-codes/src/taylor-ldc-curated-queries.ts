/**
 * Taylor LDC curated query set — Sync 5 Tier 1, Path PDF scope.
 *
 * Reviewer-realistic queries against the City of Taylor "Taylor Made"
 * Land Development Code (Revised September 2024, adopted by Ord. No.
 * 2024-41), ingested via Path PDF from the city-hosted born-digital PDF
 * with the `chapter-decimal` heading convention. This is the Layer 3
 * bespoke local code — Taylor's zoning, subdivision, and sign
 * regulations in one consolidated form-based ordinance.
 *
 * NOTE on source: Taylor's Municode "Code of Ordinances" Chapter 21
 * only ADOPTS this LDC by reference (Sec. 21-1: "The Taylor Made Land
 * Development Code ... is hereby adopted"); the substantive code is the
 * external PDF. The dispatch's "clean Municode Path C" route therefore
 * does not apply — Taylor is Path PDF, the Hutto / Bastrop B3 way.
 *
 * Coverage spans the six numbered chapters:
 *
 *   Chapter 1  Intent & general provisions  — title, applicability,
 *              nonconformities, enforcement
 *   Chapter 2  Development process          — applications, plats,
 *              variances, review authority
 *   Chapter 3  Neighborhoods, additions,    — platting, neighborhood
 *              subdivisions                   plans, street design
 *   Chapter 4  Place type zoning districts  — zoning map, districts
 *   Chapter 5  Private lot development      — lots, parking, landscape,
 *              standards                      lighting, fences, signs
 *   Chapter 6  Historic preservation        — HPO, designation, COA
 *
 * (Chapter 7 is the unnumbered Definitions glossary — no `code-section`
 * atoms; queried via the prose body of the chapters that cite terms.)
 *
 * Each query leads with the section-number anchor so the storage
 * scoring layer's section-number boost fires cleanly; topic terms after
 * the anchor disambiguate against neighbour sections.
 *
 * Visibility: Taylor is non-partnered, so the jurisdiction-corpus is
 * tagged `platform-internal` per Path A. Authorship `llm-generated`,
 * status `draft` until reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const TAYLOR_LDC_JURISDICTION = "taylor_tx";
export const TAYLOR_LDC_JURISDICTION_NAME = "Taylor, TX";
export const TAYLOR_LDC_EDITION_LABEL =
  "Taylor Made Land Development Code (Revised September 2024)";
export const TAYLOR_LDC_PDF_URL =
  "https://taylortx.gov/DocumentCenter/View/14244/Taylor-Land-Development-Code---Revised-091224";

/**
 * Normalize-time options for the Taylor LDC Path PDF ingest: the
 * `chapter-decimal` heading convention plus suppression of the
 * publisher running-header boilerplate ("TAYLOR MADE LAND DEVELOPMENT
 * ORDINANCE ..."). Shared by the `path-pdf-ingest-taylor` /
 * `path-pdf-eval-taylor` CLI subcommands and `build-corpus-snapshot` so
 * the live ingest is byte-identical wherever it runs.
 */
export const TAYLOR_LDC_NORMALIZE_OPTIONS = {
  headingConvention: "chapter-decimal" as const,
  ignoreLineRegex: /^TAYLOR MADE LAND DEVELOPMENT ORDINANCE/i,
};

interface TaylorQueryDraft {
  /** Section-number anchor against the atomized Taylor LDC corpus. */
  sectionNumber: string;
  queryText: string;
}

const TAYLOR_DRAFTS: ReadonlyArray<TaylorQueryDraft> = [
  // Chapter 1 — Intent & general provisions
  { sectionNumber: "1.1", queryText: "1.1 title of the Taylor land development code" },
  { sectionNumber: "1.5", queryText: "1.5 applicability of the land development code" },
  {
    sectionNumber: "1.7",
    queryText: "1.7 minimum standards and conflicting provisions",
  },
  { sectionNumber: "1.10.3", queryText: "1.10.3 legal nonconforming status" },
  { sectionNumber: "1.12", queryText: "1.12 development application fees" },
  { sectionNumber: "1.14.3.1", queryText: "1.14.3.1 violations enforcement" },
  // Chapter 2 — Development process
  { sectionNumber: "2.1", queryText: "2.1 development process overview" },
  { sectionNumber: "2.2.10", queryText: "2.2.10 special use permit SUP" },
  { sectionNumber: "2.2.14", queryText: "2.2.14 place type zoning variance" },
  { sectionNumber: "2.2.20", queryText: "2.2.20 preliminary plat application" },
  { sectionNumber: "2.2.22", queryText: "2.2.22 final plat application" },
  { sectionNumber: "2.2.35", queryText: "2.2.35 sign permit application" },
  { sectionNumber: "2.3.5", queryText: "2.3.5 development review committee" },
  // Chapter 3 — Neighborhoods, additions, subdivisions
  { sectionNumber: "3.4", queryText: "3.4 engineer required for subdivision" },
  { sectionNumber: "3.5.1", queryText: "3.5.1 plat required" },
  {
    sectionNumber: "3.6.1.4",
    queryText: "3.6.1.4 traditional neighborhood development TND",
  },
  { sectionNumber: "3.8.1.5", queryText: "3.8.1.5 street widths" },
  { sectionNumber: "3.8.1.10", queryText: "3.8.1.10 cul-de-sac standards" },
  // Chapter 4 — Place type zoning districts
  { sectionNumber: "4.1.2", queryText: "4.1.2 zoning map designations" },
  {
    sectionNumber: "4.2.3",
    queryText: "4.2.3 establishment of place type zoning districts",
  },
  { sectionNumber: "4.2.3.7", queryText: "4.2.3.7 P4 mix place type district" },
  {
    sectionNumber: "4.3",
    queryText: "4.3 place type zoning district development standards",
  },
  // Chapter 5 — Private lot development standards
  { sectionNumber: "5.1.2", queryText: "5.1.2 elements of a lot" },
  {
    sectionNumber: "5.4.7.1",
    queryText: "5.4.7.1 minimum and maximum parking space requirements",
  },
  {
    sectionNumber: "5.6.1.1",
    queryText: "5.6.1.1 landscape design in the private realm",
  },
  { sectionNumber: "5.7", queryText: "5.7 outdoor lighting standards" },
  {
    sectionNumber: "5.9.3.7",
    queryText: "5.9.3.7 home occupations performance standard",
  },
  { sectionNumber: "5.10.6.2", queryText: "5.10.6.2 freestanding signs" },
  // Chapter 6 — Historic preservation
  { sectionNumber: "6.1.2", queryText: "6.1.2 historic preservation officer" },
  {
    sectionNumber: "6.1.3",
    queryText: "6.1.3 criteria for designation of historic properties",
  },
  {
    sectionNumber: "6.1.10.10",
    queryText: "6.1.10.10 certificate of appropriateness for demolition",
  },
  { sectionNumber: "6.1.13", queryText: "6.1.13 historic preservation penalties" },
];

/**
 * Mirrors the path-pdf-ingest atomizer's section entityId construction:
 * `<jurisdiction>/<slug(editionLabel)>/<slug(normalizeSectionLabel(num))>`.
 * Taylor section numbers carry no "Sec." prefix, so stripSectionPrefix
 * is a no-op; it is kept for parity with the Hutto / Bastrop B3 query
 * builders.
 */
function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(TAYLOR_LDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${TAYLOR_LDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildTaylorLdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return TAYLOR_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `taylor-ldc-${i + 1}`,
    jurisdictionTenant: TAYLOR_LDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
