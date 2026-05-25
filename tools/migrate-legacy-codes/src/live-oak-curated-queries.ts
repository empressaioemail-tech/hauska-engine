/**
 * Live Oak curated query set — Sync 5 TX-metros (San Antonio metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Live Oak development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 11903). Live Oak publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters,
 * scoped by chapter filter to:
 *
 *   Chapter 5    Buildings and Building Regulations
 *   Chapter 9    Flood Damage Prevention and Protection
 *   Chapter 18   Property Maintenance
 *   Chapter 20   Streets, Sidewalks and Public Places
 *   Chapter 21   Subdivision Regulations
 *   Chapter 23   Utilities
 *   Chapter 24   Zoning
 *
 * Section-number convention: chapter-hyphenated `<chapter>-<section>`
 * (`5-1`, `9-1`, `21-1`, `24-1`).
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const LIVE_OAK_JURISDICTION = "live_oak_tx";
export const LIVE_OAK_JURISDICTION_NAME = "Live Oak, TX";
export const LIVE_OAK_EDITION_LABEL =
  "Live Oak Development Regulations (current supplement)";
export const LIVE_OAK_CLIENT_ID = 11903;
export const LIVE_OAK_LIBRARY_SLUG = "live_oak";
export const LIVE_OAK_CHAPTER_FILTER = "^chapter (5|9|18|20|21|23|24) ";

interface LiveOakQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const LIVE_OAK_DRAFTS: ReadonlyArray<LiveOakQueryDraft> = [
  // Chapter 5 — Buildings
  { sectionNumber: "5-1", queryText: "5-1 outdoor lighting" },
  { sectionNumber: "5-2", queryText: "5-2 building codes adopted" },
  { sectionNumber: "5-3", queryText: "5-3 effect upon existing permits agreements and rights" },
  // Chapter 9 — Flood Damage Prevention
  { sectionNumber: "9-1", queryText: "9-1 flood damage prevention statutory authorization" },
  { sectionNumber: "9-2", queryText: "9-2 flood damage prevention findings of fact" },
  { sectionNumber: "9-3", queryText: "9-3 flood damage prevention statement of purpose" },
  // Chapter 18 — Property Maintenance
  { sectionNumber: "18-1", queryText: "18-1 2021 international property maintenance code adopted" },
  { sectionNumber: "18-2", queryText: "18-2 property maintenance amendments" },
  // Chapter 20 — Streets
  { sectionNumber: "20-1", queryText: "20-1 trenching and street subsurface restoration specifications" },
  { sectionNumber: "20-3", queryText: "20-3 overhanging of trees interfering with public use or rights-of-way" },
  // Chapter 21 — Subdivision Regulations
  { sectionNumber: "21-1", queryText: "21-1 subdivision short title" },
  { sectionNumber: "21-2", queryText: "21-2 subdivision jurisdiction" },
  { sectionNumber: "21-3", queryText: "21-3 subdivision purpose" },
  // Chapter 23 — Utilities
  { sectionNumber: "23-1", queryText: "23-1 utilities rates" },
  // Chapter 24 — Zoning
  { sectionNumber: "24-1", queryText: "24-1 zoning title" },
  { sectionNumber: "24-2", queryText: "24-2 zoning enacting clause" },
  { sectionNumber: "24-3", queryText: "24-3 zoning purpose" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(LIVE_OAK_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${LIVE_OAK_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildLiveOakCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return LIVE_OAK_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `live-oak-${i + 1}`,
    jurisdictionTenant: LIVE_OAK_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
