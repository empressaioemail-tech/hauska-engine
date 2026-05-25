/**
 * Cedar Hill curated query set — Sprint 40i / QA-60, Path C scope.
 *
 * Reviewer-realistic queries against the City of Cedar Hill development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 1568). Cedar Hill publishes a single Code of Ordinances
 * product; its land-development surface is a set of top-level chapters,
 * scoped by chapter filter to:
 *
 *   Chapter 4    Buildings and Building Regulations
 *   Chapter 7    Flood Damage Prevention
 *   Chapter 13   Natural and Environmental Resources
 *   Chapter 16   Planning
 *   Chapter 20   Subdivision Regulations
 *   Chapter 23   Zoning Ordinance
 *
 * QA-58 (430 Evergreen Trl, Cedar Hill, TX) geocodes to Cedar Hill city
 * limits — this jurisdiction key is the primary substrate for plan-review
 * E2E. City of Dallas and Dallas County are AmLegal / no-Municode and
 * remain partnership-track follow-ons.
 *
 * Chapter 23 uses decimal section labels (`23-3.6.1`, `23-5.1.6`, …).
 * Section labels verified via `path-c-ingest-cedar-hill --show-sections`.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero curation.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const CEDAR_HILL_JURISDICTION = "cedar_hill_tx";
export const CEDAR_HILL_JURISDICTION_NAME = "Cedar Hill, TX";
export const CEDAR_HILL_EDITION_LABEL =
  "Cedar Hill Development Regulations (current supplement)";
export const CEDAR_HILL_CLIENT_ID = 1568;
export const CEDAR_HILL_LIBRARY_SLUG = "cedar_hill";
export const CEDAR_HILL_CHAPTER_FILTER =
  "buildings and building|flood|natural and environmental|planning|subdivision|zoning ordinance";

interface CedarHillQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const CEDAR_HILL_DRAFTS: ReadonlyArray<CedarHillQueryDraft> = [
  // Chapter 20 — Subdivision Regulations
  { sectionNumber: "20-1", queryText: "20-1 subdivision definitions" },
  { sectionNumber: "20-2", queryText: "20-2 compliance with subdivision chapter" },
  { sectionNumber: "20-5", queryText: "20-5 filing fees preliminary and final plat" },
  { sectionNumber: "20-6", queryText: "20-6 application review procedures subdivision" },
  { sectionNumber: "20-10", queryText: "20-10 preliminary plat and plans" },
  { sectionNumber: "20-11", queryText: "20-11 final plat and plans" },
  // Chapter 23 — Zoning Ordinance (decimal labels)
  { sectionNumber: "1.3", queryText: "1.3 zoning district map" },
  { sectionNumber: "1.5", queryText: "1.5 compliance with zoning required" },
  { sectionNumber: "23-2.2.6", queryText: "23-2.2.6 zoning variances" },
  { sectionNumber: "23-3.6.1", queryText: "23-3.6.1 SF-10 single-family residential district purpose" },
  { sectionNumber: "23-3.6.3", queryText: "23-3.6.3 SF-10 district development standards" },
  { sectionNumber: "23-3.10.1", queryText: "23-3.10.1 MF multiple-family residential district purpose" },
  { sectionNumber: "23-5.1.6", queryText: "23-5.1.6 schedule of parking space requirements" },
  { sectionNumber: "23-5.2.1", queryText: "23-5.2.1 landscape requirements purpose" },
  { sectionNumber: "23-5.3.8", queryText: "23-5.3.8 fencing when screening not required" },
  { sectionNumber: "23-6.3.1", queryText: "23-6.3.1 penalty for zoning violations" },
  // Chapter 7 — Flood Damage Prevention
  { sectionNumber: "7-1", queryText: "7-1 flood damage prevention statutory authorization" },
  { sectionNumber: "7-39", queryText: "7-39 flood damage prevention compliance" },
  { sectionNumber: "7-58", queryText: "7-58 floodplain permit procedures" },
  // Chapter 16 — Planning
  { sectionNumber: "16-3", queryText: "16-3 comprehensive plan adopted" },
  { sectionNumber: "16-43", queryText: "16-43 planning and zoning commission powers and duties" },
  // Chapter 4 — Buildings (permit workflow)
  { sectionNumber: "4-1", queryText: "4-1 building permits" },
  { sectionNumber: "4-61", queryText: "4-61 adoption of 2021 international building code" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(CEDAR_HILL_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${CEDAR_HILL_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildCedarHillCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return CEDAR_HILL_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `cedar-hill-${i + 1}`,
    jurisdictionTenant: CEDAR_HILL_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
