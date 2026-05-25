/**
 * Converse curated query set — Sync 5 TX-metros (San Antonio metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Converse development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 1749). Single Code of Ordinances product; top-level
 * chapters:
 *
 *   Chapter 8    Buildings and Building Regulations
 *   Chapter 22   Floods
 *   Chapter 26   Mobile Homes, Manufactured Homes and Parks
 *   Chapter 28   Off-Street Parking
 *   Chapter 34   Signs
 *   Chapter 38   Streets, Sidewalks and Other Public Places
 *   Chapter 40   Subdivisions
 *   Chapter 46   Utilities
 *   Chapter 48   Vegetation and Landscaping
 *   Chapter 50   Zoning
 *
 * Section-number convention: chapter-hyphenated `<chapter>-<section>`.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const CONVERSE_JURISDICTION = "converse_tx";
export const CONVERSE_JURISDICTION_NAME = "Converse, TX";
export const CONVERSE_EDITION_LABEL =
  "Converse Development Regulations (current supplement)";
export const CONVERSE_CLIENT_ID = 1749;
export const CONVERSE_LIBRARY_SLUG = "converse";
export const CONVERSE_CHAPTER_FILTER =
  "^chapter (8|22|26|28|34|38|40|46|48|50) ";

interface ConverseQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const CONVERSE_DRAFTS: ReadonlyArray<ConverseQueryDraft> = [
  // Chapter 8 — Buildings
  { sectionNumber: "8-1", queryText: "8-1 building codes adopted by reference" },
  { sectionNumber: "8-2", queryText: "8-2 building definitions" },
  { sectionNumber: "8-3", queryText: "8-3 damage to city infrastructure" },
  { sectionNumber: "8-4", queryText: "8-4 construction appeals board" },
  // Chapter 28 — Off-Street Parking
  { sectionNumber: "28-1", queryText: "28-1 off-street parking purpose" },
  { sectionNumber: "28-2", queryText: "28-2 off-street parking definitions" },
  { sectionNumber: "28-3", queryText: "28-3 off-street parking penalties" },
  { sectionNumber: "28-4", queryText: "28-4 responsibility for off-street parking facilities" },
  // Chapter 34 — Signs
  { sectionNumber: "34-1", queryText: "34-1 sign definitions" },
  { sectionNumber: "34-2", queryText: "34-2 sign purpose objectives" },
  { sectionNumber: "34-3", queryText: "34-3 sign penalties for violation" },
  // Chapter 40 — Subdivisions
  { sectionNumber: "40-1", queryText: "40-1 subdivision statutory authority" },
  { sectionNumber: "40-2", queryText: "40-2 subdivision jurisdiction" },
  { sectionNumber: "40-3", queryText: "40-3 subdivision consistency with comprehensive plan and zoning ordinances" },
  { sectionNumber: "40-4", queryText: "40-4 subdivision conflicts with other ordinances" },
  // Chapter 50 — Zoning
  { sectionNumber: "50-1", queryText: "50-1 zoning purpose" },
  { sectionNumber: "50-2", queryText: "50-2 zoning scope of chapter" },
  { sectionNumber: "50-3", queryText: "50-3 zoning effect" },
  { sectionNumber: "50-4", queryText: "50-4 zoning compliance" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(CONVERSE_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${CONVERSE_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildConverseCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return CONVERSE_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `converse-${i + 1}`,
    jurisdictionTenant: CONVERSE_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
