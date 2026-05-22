/**
 * Copperas Cove curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Reviewer-realistic queries against the City of Copperas Cove
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 1761). Single Code of Ordinances product; scoped by
 * chapter filter to the three land-development chapters:
 *
 *   Chapter 16.5  Stay Basic Sign Regulations
 *   Chapter 17.5  Subdivisions
 *   Chapter 20    Zoning
 *
 * Each query leads with the section-number anchor so the storage
 * scoring layer's section-number boost fires cleanly.
 *
 * Visibility: `platform-internal` per Path A. Authorship
 * `llm-generated`, status `draft`.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const COPPERAS_COVE_JURISDICTION = "copperas_cove_tx";
export const COPPERAS_COVE_JURISDICTION_NAME = "Copperas Cove, TX";
export const COPPERAS_COVE_EDITION_LABEL =
  "Copperas Cove Development Regulations (current supplement)";
export const COPPERAS_COVE_CLIENT_ID = 1761;
export const COPPERAS_COVE_LIBRARY_SLUG = "copperas_cove";
/** Three land-development chapters in the Code of Ordinances TOC. */
export const COPPERAS_COVE_CHAPTER_FILTER =
  "sign regulations|subdivisions|zoning";

interface CopperasCoveQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const COPPERAS_COVE_DRAFTS: ReadonlyArray<CopperasCoveQueryDraft> = [
  // Chapter 16.5 — Stay Basic Sign Regulations
  { sectionNumber: "16.5-2", queryText: "16.5-2 sign regulations administration" },
  { sectionNumber: "16.5-3", queryText: "16.5-3 sign permit procedures and fees" },
  { sectionNumber: "16.5-6", queryText: "16.5-6 billboards and other off-premises signs" },
  { sectionNumber: "16.5-9", queryText: "16.5-9 prohibited signs" },
  { sectionNumber: "16.5-11", queryText: "16.5-11 sign variance" },
  // Chapter 17.5 — Subdivisions
  { sectionNumber: "17.5-22", queryText: "17.5-22 authority of the city to adopt a subdivision ordinance" },
  { sectionNumber: "17.5-25", queryText: "17.5-25 subdivision compliance with this chapter" },
  { sectionNumber: "17.5-41", queryText: "17.5-41 requirements and approval process for subdivision plats and plans" },
  { sectionNumber: "17.5-45", queryText: "17.5-45 subdivision filing fees and procedures" },
  { sectionNumber: "17.5-47", queryText: "17.5-47 final plat review approval and recording" },
  { sectionNumber: "17.5-52", queryText: "17.5-52 vacated subdivision plat" },
  { sectionNumber: "17.5-54", queryText: "17.5-54 resubdivision plat replat" },
  { sectionNumber: "17.5-60", queryText: "17.5-60 other development land disturbance and construction requirements" },
  { sectionNumber: "17.5-71", queryText: "17.5-71 development within the 100-year floodplain" },
  { sectionNumber: "17.5-91", queryText: "17.5-91 subdivision improvements required" },
  { sectionNumber: "17.5-94", queryText: "17.5-94 waiver or deferral of required improvements" },
  { sectionNumber: "17.5-137", queryText: "17.5-137 subdivision penalties for violation" },
  // Chapter 20 — Zoning
  { sectionNumber: "20-1-9", queryText: "20-1-9 zoning transitional provisions and vesting" },
  { sectionNumber: "20-2-1", queryText: "20-2-1 zoning districts established" },
  { sectionNumber: "20-2-2", queryText: "20-2-2 official zoning map" },
  { sectionNumber: "20-3-1", queryText: "20-3-1 zoning use table" },
  { sectionNumber: "20-3-4", queryText: "20-3-4 conditional use standards" },
  { sectionNumber: "20-3-5", queryText: "20-3-5 accessory uses and structures" },
  { sectionNumber: "20-3-7", queryText: "20-3-7 wireless telecommunications facilities" },
  { sectionNumber: "20-4-2", queryText: "20-4-2 parking loading and stacking" },
  { sectionNumber: "20-4-3", queryText: "20-4-3 landscaping buffering and screening" },
  { sectionNumber: "20-5-2", queryText: "20-5-2 planning and zoning commission" },
  { sectionNumber: "20-5-3", queryText: "20-5-3 zoning board of adjustment" },
  { sectionNumber: "20-7-2", queryText: "20-7-2 types of nonconformities" },
  { sectionNumber: "20-8-3", queryText: "20-8-3 zoning penalties" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(COPPERAS_COVE_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${COPPERAS_COVE_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildCopperasCoveCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return COPPERAS_COVE_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `copperas-cove-${i + 1}`,
    jurisdictionTenant: COPPERAS_COVE_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
