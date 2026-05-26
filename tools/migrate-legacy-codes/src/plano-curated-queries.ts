/**
 * Plano curated query set — Sync 5 lane North (DFW metro), Path C scope.
 *
 * Municode clientId 3886. Development surface scoped to Chapter 6
 * (Buildings and Building Regulations), Chapter 16 (Planning and
 * Development), and Appendix A (Zoning) via chapter filter.
 *
 * Section-number convention: chapter-hyphenated (`6-1`, `16-41`).
 * Avoid reserved-range traps (e.g. `6-2` Reserved).
 *
 * Visibility: platform-internal per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const PLANO_JURISDICTION = "plano_tx";
export const PLANO_JURISDICTION_NAME = "Plano, TX";
export const PLANO_EDITION_LABEL =
  "Plano Development Regulations (current supplement)";
export const PLANO_CLIENT_ID = 3886;
export const PLANO_LIBRARY_SLUG = "plano";
export const PLANO_CHAPTER_FILTER = "^chapter (6|16) |^appendix a ";

interface PlanoQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const PLANO_DRAFTS: ReadonlyArray<PlanoQueryDraft> = [
  { sectionNumber: "6-1", queryText: "6-1 buildings purpose of article" },
  { sectionNumber: "6-3", queryText: "6-3 building standards commission organization and authority" },
  { sectionNumber: "6-16", queryText: "6-16 buildings penalty" },
  { sectionNumber: "6-17", queryText: "6-17 international building code adopted" },
  { sectionNumber: "6-61", queryText: "6-61 multi-family dwelling complex definitions" },
  { sectionNumber: "16-1", queryText: "16-1 planning payments to developers" },
  { sectionNumber: "16-3", queryText: "16-3 planning development amenities policies" },
  { sectionNumber: "16-19", queryText: "16-19 zoning rezoning fees" },
  { sectionNumber: "16-41", queryText: "16-41 board of adjustment members number appointment" },
  { sectionNumber: "16-45", queryText: "16-45 board of adjustment duties and powers" },
  { sectionNumber: "16-46", queryText: "16-46 zoning appeals notification adjacent property owners" },
  { sectionNumber: "16-61", queryText: "16-61 planning findings" },
  { sectionNumber: "16-65", queryText: "16-65 redevelopment authority instrumentality of city" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(PLANO_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${PLANO_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildPlanoCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return PLANO_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `plano-${i + 1}`,
    jurisdictionTenant: PLANO_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
