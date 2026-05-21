/**
 * Round Rock curated query set — Sync 5 Tier 1, Path C scope.
 *
 * Reviewer-realistic queries against the City of Round Rock Part III
 * "Zoning and Development Code", ingested via Path C from the
 * Municode-hosted Code of Ordinances (clientId 4150). This is the
 * Layer 3 bespoke local code — zoning and development regulations with
 * no model-code parent. Layer 2 model-code amendment overlays backfill
 * against this jurisdiction once the Layer 1 base lands.
 *
 * Each query leads with the section-number anchor so the storage
 * scoring layer's section-number boost fires cleanly; topic terms
 * after the anchor disambiguate against neighbour sections.
 *
 * Visibility: Round Rock is non-partnered, so the jurisdiction-corpus
 * is tagged `platform-internal` per Path A. Authorship `llm-generated`,
 * status `draft` until reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const ROUND_ROCK_JURISDICTION = "round_rock_tx";
export const ROUND_ROCK_JURISDICTION_NAME = "Round Rock, TX";
export const ROUND_ROCK_EDITION_LABEL =
  "Round Rock Zoning and Development Code (current supplement)";
export const ROUND_ROCK_CLIENT_ID = 4150;
export const ROUND_ROCK_LIBRARY_SLUG = "round_rock";
/** Top-level TOC heading: "PART III - ZONING AND DEVELOPMENT CODE". */
export const ROUND_ROCK_CHAPTER_FILTER = "zoning.*development|development code";

interface RoundRockQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const ROUND_ROCK_DRAFTS: ReadonlyArray<RoundRockQueryDraft> = [
  // Chapter 1 — Introductory provisions
  { sectionNumber: "1-1", queryText: "1-1 short title of the zoning and development code" },
  { sectionNumber: "1-3", queryText: "1-3 scope and purpose of the development code" },
  { sectionNumber: "1-7", queryText: "1-7 round rock comprehensive plan" },
  { sectionNumber: "1-32", queryText: "1-32 violation and penalties" },
  // Chapter 2 — Zoning districts and use regulations
  { sectionNumber: "2-2", queryText: "2-2 establishment of zoning districts" },
  { sectionNumber: "2-4", queryText: "2-4 permitted and prohibited uses" },
  { sectionNumber: "2-13", queryText: "2-13 SF-R single-family rural zoning district" },
  { sectionNumber: "2-22", queryText: "2-22 MF-1 multifamily low density district" },
  { sectionNumber: "2-32", queryText: "2-32 C-1 general commercial district" },
  { sectionNumber: "2-45", queryText: "2-45 LI light industrial district" },
  { sectionNumber: "2-76", queryText: "2-76 PUD planned unit development district" },
  { sectionNumber: "2-86", queryText: "2-86 H historic overlay district" },
  { sectionNumber: "2-93", queryText: "2-93 accessory uses and home occupations" },
  { sectionNumber: "2-96", queryText: "2-96 height and placement requirements" },
  // Chapter 4 — Subdivision design and construction
  { sectionNumber: "4-3", queryText: "4-3 subdivision applicability and jurisdiction" },
  { sectionNumber: "4-14", queryText: "4-14 subdivision fees" },
  { sectionNumber: "4-27", queryText: "4-27 subdivision design and construction standards" },
  { sectionNumber: "4-46", queryText: "4-46 subdivision lots requirements" },
  { sectionNumber: "4-62", queryText: "4-62 parkland dedication requirement" },
  { sectionNumber: "4-68", queryText: "4-68 parkland fee in lieu of conveyance" },
  // Chapter 6 — Streets and thoroughfares
  { sectionNumber: "6-12", queryText: "6-12 street connectivity requirements" },
  { sectionNumber: "6-14", queryText: "6-14 intersections design" },
  { sectionNumber: "6-17", queryText: "6-17 street lighting" },
  // Chapter 8 — Compatibility, landscaping, trees, signs, buildings
  { sectionNumber: "8-2", queryText: "8-2 compatibility buffers" },
  { sectionNumber: "8-10", queryText: "8-10 landscaping standards" },
  { sectionNumber: "8-19", queryText: "8-19 tree removal process" },
  {
    sectionNumber: "8-153",
    queryText: "8-153 international code council performance code for buildings adopted",
  },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(ROUND_ROCK_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${ROUND_ROCK_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildRoundRockCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return ROUND_ROCK_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `round-rock-${i + 1}`,
    jurisdictionTenant: ROUND_ROCK_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
