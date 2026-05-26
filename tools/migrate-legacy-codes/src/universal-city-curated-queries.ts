/**
 * Universal City curated query set — Sync 5 TX-metros (San Antonio
 * metro), Path C scope.
 *
 * Reviewer-realistic queries against the City of Universal City
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 4708). Universal City's Code of Ordinances is
 * Part-structured (PARTs I-IV); the development surface lives at
 * `PART IV - PROPERTY AND STRUCTURES`. The chapter filter targets
 * the PART IV wrapper; the walker descends through it to seven
 * chapters (4-1 through 4-7). Non-development content lives at
 * PART I City Charter / PART II Municipal Services / PART III
 * Activities Regulated, none of which match the filter.
 *
 *   Chapter 4-1   General and Miscellaneous
 *   Chapter 4-2   Planning
 *   Chapter 4-3   Mobile Home Parks
 *   Chapter 4-4   Signs
 *   Chapter 4-5   Zoning
 *   Chapter 4-6   Codes                  (IBC/IRC/IMC/IECC/IFGC adoption)
 *   Chapter 4-7   Flood Control
 *
 * Section-number convention: triple-hyphenated `<part>-<chapter>-<section>`
 * (`4-1-7`, `4-5-1`, `4-7-1`).
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const UNIVERSAL_CITY_JURISDICTION = "universal_city_tx";
export const UNIVERSAL_CITY_JURISDICTION_NAME = "Universal City, TX";
export const UNIVERSAL_CITY_EDITION_LABEL =
  "Universal City Development Regulations (current supplement)";
export const UNIVERSAL_CITY_CLIENT_ID = 4708;
export const UNIVERSAL_CITY_LIBRARY_SLUG = "universal_city";
export const UNIVERSAL_CITY_CHAPTER_FILTER = "^part iv ";

interface UniversalCityQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const UNIVERSAL_CITY_DRAFTS: ReadonlyArray<UniversalCityQueryDraft> = [
  // Chapter 4-1 — General and Miscellaneous
  { sectionNumber: "4-1-7", queryText: "4-1-7 use of utility easements or public rights-of-way definitions" },
  { sectionNumber: "4-1-8", queryText: "4-1-8 use of utility easements by owners of lots" },
  // Chapter 4-2 — Planning
  { sectionNumber: "4-2-1", queryText: "4-2-1 addressing authority within incorporated city limits" },
  // Chapter 4-3 — Mobile Home Parks
  { sectionNumber: "4-3-1", queryText: "4-3-1 mobile home park definitions" },
  { sectionNumber: "4-3-2", queryText: "4-3-2 location of mobile homes" },
  { sectionNumber: "4-3-3", queryText: "4-3-3 location of trailers recreational vehicles" },
  // Chapter 4-4 — Signs
  { sectionNumber: "4-4-1", queryText: "4-4-1 sign short title" },
  { sectionNumber: "4-4-2", queryText: "4-4-2 sign legislative findings intent" },
  { sectionNumber: "4-4-3", queryText: "4-4-3 sign purpose" },
  // Chapter 4-5 — Zoning
  { sectionNumber: "4-5-1", queryText: "4-5-1 zoning purposes and intent" },
  { sectionNumber: "4-5-2", queryText: "4-5-2 zoning consistency with comprehensive plan" },
  { sectionNumber: "4-5-3", queryText: "4-5-3 zoning minimum requirements" },
  // Chapter 4-6 — Codes
  { sectionNumber: "4-6-1", queryText: "4-6-1 adoption of various international codes and appendices relating to construction" },
  { sectionNumber: "4-6-2", queryText: "4-6-2 exceptions and amendments to international building code" },
  { sectionNumber: "4-6-3", queryText: "4-6-3 exceptions and amendments to national electrical code" },
  // Chapter 4-7 — Flood Control
  { sectionNumber: "4-7-1", queryText: "4-7-1 flood control statutory authorization" },
  { sectionNumber: "4-7-2", queryText: "4-7-2 flood control findings of fact" },
  { sectionNumber: "4-7-3", queryText: "4-7-3 flood control statement of purpose" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(UNIVERSAL_CITY_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${UNIVERSAL_CITY_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildUniversalCityCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return UNIVERSAL_CITY_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `universal-city-${i + 1}`,
    jurisdictionTenant: UNIVERSAL_CITY_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
