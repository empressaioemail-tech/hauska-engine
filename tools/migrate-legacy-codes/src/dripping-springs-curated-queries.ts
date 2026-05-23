/**
 * Dripping Springs curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest from Municode (clientId 15829): Chapter 26 (Signs),
 * Chapter 28 (Subdivisions and Site Development), Chapter 30 (Zoning).
 * Exhibit-ordinance pattern in Ch 28 + Ch 30; PR #22 disambiguation
 * handles any collisions.
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const DRIPPING_SPRINGS_JURISDICTION = "dripping_springs_tx";
export const DRIPPING_SPRINGS_JURISDICTION_NAME = "Dripping Springs, TX";
export const DRIPPING_SPRINGS_EDITION_LABEL =
  "Dripping Springs Development Regulations (current supplement)";
export const DRIPPING_SPRINGS_CLIENT_ID = 15829;
export const DRIPPING_SPRINGS_LIBRARY_SLUG = "dripping_springs";
export const DRIPPING_SPRINGS_CHAPTER_FILTER =
  "signs|subdivision|zoning|site development";

interface DrippingSpringsQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const DRIPPING_SPRINGS_DRAFTS: ReadonlyArray<DrippingSpringsQueryDraft> = [
  // Chapter 26 — Signs
  { sectionNumber: "26.01.002", queryText: "26.01.002 sign purpose and findings" },
  { sectionNumber: "26.01.003", queryText: "26.01.003 sign geographic scope and applicability" },
  { sectionNumber: "26.01.004", queryText: "26.01.004 summary of sign regulations by type" },
  { sectionNumber: "26.01.006", queryText: "26.01.006 sign administration" },
  { sectionNumber: "26.01.007", queryText: "26.01.007 sign violations and penalties" },
  { sectionNumber: "26.01.008", queryText: "26.01.008 authorized signs without a separate permit" },
  { sectionNumber: "26.01.009", queryText: "26.01.009 prohibited signs" },
  { sectionNumber: "26.01.010", queryText: "26.01.010 sign lessors" },
  { sectionNumber: "26.01.011", queryText: "26.01.011 sign permit required" },
  // Chapter 28 — Subdivisions and Site Development
  { sectionNumber: "28.02.001", queryText: "28.02.001 subdivision ordinance adopted" },
  { sectionNumber: "28.03.004", queryText: "28.03.004 parks recreation and open space master plan" },
  { sectionNumber: "28.03.005", queryText: "28.03.005 parkland exemptions for certain projects" },
  { sectionNumber: "28.03.006", queryText: "28.03.006 parkland dedication and development methodology" },
  { sectionNumber: "28.03.007", queryText: "28.03.007 dedication of public parkland required" },
  { sectionNumber: "28.03.010", queryText: "28.03.010 park development fee" },
  { sectionNumber: "28.03.011", queryText: "28.03.011 fee-in-lieu of dedication" },
  { sectionNumber: "28.03.012", queryText: "28.03.012 credit for private parks" },
  { sectionNumber: "28.03.014", queryText: "28.03.014 park funds" },
  { sectionNumber: "28.03.015", queryText: "28.03.015 land dedication for park trails" },
  { sectionNumber: "28.03.016", queryText: "28.03.016 agricultural facility fee" },
  // Chapter 30 — Zoning
  { sectionNumber: "30.02.001", queryText: "30.02.001 zoning ordinance adopted" },
  { sectionNumber: "30.03.002", queryText: "30.03.002 planned development districts scope" },
  // Acceptance of improvements (Ch 30 prefix sections at top of zoning chapter)
  { sectionNumber: "30.1", queryText: "30.1 withholding city services and improvements" },
  { sectionNumber: "30.2", queryText: "30.2 guarantee of public improvements" },
  { sectionNumber: "30.3", queryText: "30.3 temporary improvements" },
  { sectionNumber: "30.6", queryText: "30.6 acceptance of dedication offers" },
  { sectionNumber: "30.7", queryText: "30.7 maintenance and guarantee" },
  { sectionNumber: "30.9", queryText: "30.9 nonpoint source pollution controls and tree protection" },
  { sectionNumber: "30.10", queryText: "30.10 review and acceptance of public improvements" },
  { sectionNumber: "30.12", queryText: "30.12 deferral of required improvements" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(DRIPPING_SPRINGS_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${DRIPPING_SPRINGS_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildDrippingSpringsCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return DRIPPING_SPRINGS_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `dripping-springs-${i + 1}`,
    jurisdictionTenant: DRIPPING_SPRINGS_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
