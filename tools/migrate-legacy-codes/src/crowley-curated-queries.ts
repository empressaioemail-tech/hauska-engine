/**
 * Crowley curated query set — Sync 5 TX-metros (Fort Worth metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Crowley development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 1823). Crowley publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters,
 * scoped by chapter filter to:
 *
 *   Chapter 14    Buildings and Building Regulations
 *   Chapter 34    Environment
 *   Chapter 42    Gas Drilling and Production
 *   Chapter 58    Parks and Recreation
 *   Chapter 70    Solid Waste
 *   Chapter 74    Stormwater
 *   Chapter 86    Utilities
 *   Chapter 94    Floods
 *   Chapter 98    Subdivision
 *   Chapter 102   Signs
 *   Chapter 106   Zoning   (decimal-numbered `106.N`)
 *   Appendix A    Schedule of Rates, Fees and Charges
 *
 * Section-number conventions: mostly chapter-hyphenated (`74-1`,
 * `98-1`, `42-1`), but Chapter 106 Zoning uses a decimal `106.N`
 * format. Each query leads with the section-number anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const CROWLEY_JURISDICTION = "crowley_tx";
export const CROWLEY_JURISDICTION_NAME = "Crowley, TX";
export const CROWLEY_EDITION_LABEL =
  "Crowley Development Regulations (current supplement)";
export const CROWLEY_CLIENT_ID = 1823;
export const CROWLEY_LIBRARY_SLUG = "crowley";
export const CROWLEY_CHAPTER_FILTER =
  "^chapter (14|34|42|58|70|74|86|94|98|102|106) |^appendix a ";

interface CrowleyQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const CROWLEY_DRAFTS: ReadonlyArray<CrowleyQueryDraft> = [
  // Chapter 42 — Gas Drilling and Production
  { sectionNumber: "42-1", queryText: "42-1 gas drilling definitions" },
  { sectionNumber: "42-2", queryText: "42-2 gas drilling penalty" },
  { sectionNumber: "42-3", queryText: "42-3 gas drilling purpose" },
  // Chapter 70 — Solid Waste
  { sectionNumber: "70-1", queryText: "70-1 depositing garbage trash rubble or stagnant water on streets vacant lots" },
  { sectionNumber: "70-2", queryText: "70-2 solid waste application for services" },
  // Chapter 74 — Stormwater
  { sectionNumber: "74-1", queryText: "74-1 stormwater definitions" },
  { sectionNumber: "74-2", queryText: "74-2 stormwater abbreviations" },
  { sectionNumber: "74-3", queryText: "74-3 stormwater purposes objectives" },
  // Chapter 86 — Utilities
  { sectionNumber: "86-1", queryText: "86-1 utilities application for services" },
  { sectionNumber: "86-2", queryText: "86-2 incorporation of utilities chapter into consumer contract" },
  { sectionNumber: "86-3", queryText: "86-3 liability of city for utilities damage" },
  // Chapter 98 — Subdivision
  { sectionNumber: "98-1", queryText: "98-1 subdivision title" },
  { sectionNumber: "98-2", queryText: "98-2 subdivision effective date" },
  { sectionNumber: "98-3", queryText: "98-3 subdivision authority" },
  // Chapter 102 — Signs
  { sectionNumber: "102-31", queryText: "102-31 sign permit required" },
  { sectionNumber: "102-32", queryText: "102-32 sign permit application" },
  { sectionNumber: "102-33", queryText: "102-33 sign permit termination" },
  // Chapter 106 — Zoning (decimal-numbered)
  { sectionNumber: "106.1", queryText: "106.1 zoning title" },
  { sectionNumber: "106.2", queryText: "106.2 zoning effective date" },
  { sectionNumber: "106.3", queryText: "106.3 zoning authority" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(CROWLEY_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${CROWLEY_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildCrowleyCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return CROWLEY_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `crowley-${i + 1}`,
    jurisdictionTenant: CROWLEY_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
