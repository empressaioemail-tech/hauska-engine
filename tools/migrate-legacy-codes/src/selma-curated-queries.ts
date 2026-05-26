/**
 * Selma curated query set — Sync 5 TX-metros (San Antonio metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Selma development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 12820). Selma publishes its development surface at the
 * top level as `PART II - LAND DEVELOPMENT REGULATIONS`, with five
 * chapters (66-82) nested inside. The chapter filter targets the
 * PART II wrapper; the walker descends through it. Non-development
 * content lives at PART I Charter and Chapters 1-62 (admin /
 * animals / business / etc.), neither of which matches the filter.
 *
 *   Chapter 66    Buildings and Building Regulations
 *   Chapter 70    Floods
 *   Chapter 74    Signs
 *   Chapter 78    Subdivisions
 *   Chapter 82    Zoning
 *
 * Section-number convention: chapter-hyphenated `<chapter>-<section>`.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SELMA_JURISDICTION = "selma_tx";
export const SELMA_JURISDICTION_NAME = "Selma, TX";
export const SELMA_EDITION_LABEL =
  "Selma Land Development Regulations (current supplement)";
export const SELMA_CLIENT_ID = 12820;
export const SELMA_LIBRARY_SLUG = "selma";
export const SELMA_CHAPTER_FILTER = "^part ii ";

interface SelmaQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const SELMA_DRAFTS: ReadonlyArray<SelmaQueryDraft> = [
  // Chapter 66 — Buildings
  { sectionNumber: "66-1", queryText: "66-1 building permits plan reviews and other services fees" },
  { sectionNumber: "66-2", queryText: "66-2 building notice of violations penalties" },
  { sectionNumber: "66-3", queryText: "66-3 building responsible party" },
  // Chapter 74 — Signs
  { sectionNumber: "74-1", queryText: "74-1 sign definitions" },
  { sectionNumber: "74-2", queryText: "74-2 signs purpose of chapter" },
  { sectionNumber: "74-3", queryText: "74-3 signs scope of chapter" },
  // Chapter 78 — Subdivisions
  { sectionNumber: "78-1", queryText: "78-1 subdivision definitions" },
  { sectionNumber: "78-2", queryText: "78-2 subdivision authority" },
  { sectionNumber: "78-3", queryText: "78-3 subdivision purpose" },
  // Chapter 82 — Zoning
  { sectionNumber: "82-1", queryText: "82-1 zoning purpose of chapter" },
  { sectionNumber: "82-2", queryText: "82-2 zoning definitions" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SELMA_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SELMA_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSelmaCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SELMA_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `selma-${i + 1}`,
    jurisdictionTenant: SELMA_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
