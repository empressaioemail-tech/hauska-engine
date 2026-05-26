/**
 * Pharr curated query set — Sync 5 TX-metros (Rio Grande Valley),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Pharr development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 3842). Pharr publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters
 * plus Appendix A (Zoning), scoped by chapter filter to:
 *
 *   Chapter 22    Buildings and Building Regulations
 *   Chapter 38    Community Development
 *   Chapter 58    Floods
 *   Chapter 98    Planning
 *   Chapter 106   Signs
 *   Chapter 114   Streets, Sidewalks and Other Public Places
 *   Chapter 118   Subdivisions
 *   Chapter 130   Utilities
 *   Chapter 134   Vegetation
 *   Appendix A    Zoning   (decimal-numbered Sec. N.M)
 *
 * Section-number conventions: chapter-hyphenated for the CoO chapters
 * (e.g. `118-41`, `58-26`), and dot-decimal for Appendix A Zoning
 * (e.g. `1.10`, `1.11.1`). Several chapters carry reserved-range
 * placeholders (`Secs. <chapter>-1—<chapter>-N. - Reserved.`) in
 * Article I; queries target the substantive section run only.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const PHARR_JURISDICTION = "pharr_tx";
export const PHARR_JURISDICTION_NAME = "Pharr, TX";
export const PHARR_EDITION_LABEL =
  "Pharr Development Regulations (current supplement)";
export const PHARR_CLIENT_ID = 3842;
export const PHARR_LIBRARY_SLUG = "pharr";
export const PHARR_CHAPTER_FILTER =
  "^chapter (22|38|58|98|106|114|118|130|134) |^appendix a ";

interface PharrQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const PHARR_DRAFTS: ReadonlyArray<PharrQueryDraft> = [
  // Chapter 118 — Subdivisions
  { sectionNumber: "118-41", queryText: "118-41 subdivision design generally" },
  { sectionNumber: "118-42", queryText: "118-42 subdivision blocks" },
  { sectionNumber: "118-43", queryText: "118-43 subdivision lots" },
  { sectionNumber: "118-44", queryText: "118-44 subdivision streets" },
  { sectionNumber: "118-45", queryText: "118-45 subdivision responsibility for installation" },
  // Chapter 58 — Floods (Article I reserved 58-1—58-25)
  { sectionNumber: "58-26", queryText: "58-26 flood definitions" },
  // Chapter 98 — Planning (Article I reserved 98-1—98-30)
  { sectionNumber: "98-31", queryText: "98-31 planning and zoning commission created composition" },
  // Chapter 106 — Signs (Article I reserved 106-1—106-30)
  { sectionNumber: "106-33", queryText: "106-33 signs purpose" },
  // Chapter 114 — Streets
  { sectionNumber: "114-1", queryText: "114-1 adoption of state law relative to street improvements" },
  // Chapter 130 — Utilities
  { sectionNumber: "130-1", queryText: "130-1 utilities definitions" },
  // Chapter 134 — Vegetation (Article I reserved 134-1—134-30)
  { sectionNumber: "134-31", queryText: "134-31 landscaping definitions" },
  // Appendix A — Zoning (decimal-numbered)
  { sectionNumber: "1.1", queryText: "1.1 zoning short title" },
  { sectionNumber: "1.2", queryText: "1.2 division of city into use districts" },
  { sectionNumber: "1.3", queryText: "1.3 official zoning map" },
  { sectionNumber: "1.4", queryText: "1.4 land and structures to be used as required by district regulations" },
  { sectionNumber: "1.5", queryText: "1.5 newly annexed territory" },
  { sectionNumber: "1.10", queryText: "1.10 A-O agricultural and open space district" },
  { sectionNumber: "1.11", queryText: "1.11 R-1 single-family residential district" },
  { sectionNumber: "1.12", queryText: "1.12 R1-E single-family residential estate district" },
  { sectionNumber: "1.13", queryText: "1.13 R-TH townhouse residential district" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(PHARR_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${PHARR_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildPharrCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return PHARR_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `pharr-${i + 1}`,
    jurisdictionTenant: PHARR_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
