/**
 * Manor curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest of the City of Manor land-development chapters from
 * the Municode JSON API (clientId 15968). Single Code of Ordinances
 * product; scoped by chapter filter to:
 *
 *   Chapter 10  Subdivision Regulation   (exhibit-ordinance pattern)
 *   Chapter 14  Zoning                   (exhibit-ordinance pattern)
 *   Chapter 15  Site Development
 *
 * Manor adopts its zoning and subdivision substantive content as
 * Exhibit A ordinances on chapter shells (the Leander pattern); the
 * PR #22 bare-numbered-section entityId disambiguation handles any
 * collisions across exhibits.
 *
 * Visibility: `platform-internal` per Path A. Authorship
 * `llm-generated`, status `draft`.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const MANOR_JURISDICTION = "manor_tx";
export const MANOR_JURISDICTION_NAME = "Manor, TX";
export const MANOR_EDITION_LABEL =
  "Manor Development Regulations (current supplement)";
export const MANOR_CLIENT_ID = 15968;
export const MANOR_LIBRARY_SLUG = "manor";
/** Three land-development chapters in the Code of Ordinances TOC. */
export const MANOR_CHAPTER_FILTER = "subdivision|zoning|site development";

interface ManorQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const MANOR_DRAFTS: ReadonlyArray<ManorQueryDraft> = [
  // Chapter 10 — Subdivision Regulation (impact-fee articles + Exhibit A
  // bare-numbered sections that survived PR #22 disambiguation without
  // re-keying, i.e. ones that appear only once across sourceAnchors)
  { sectionNumber: "10.03.001", queryText: "10.03.001 impact fees title" },
  { sectionNumber: "10.03.005", queryText: "10.03.005 capital improvements plan adopted" },
  { sectionNumber: "10.03.031", queryText: "10.03.031 impact fees establishment" },
  { sectionNumber: "10.03.033", queryText: "10.03.033 impact fees amount" },
  { sectionNumber: "10.03.077", queryText: "10.03.077 impact fees credits" },
  { sectionNumber: "10.03.081", queryText: "10.03.081 impact fees school districts" },
  { sectionNumber: "22", queryText: "22 subdivision preliminary plat" },
  { sectionNumber: "24", queryText: "24 subdivision final plat" },
  { sectionNumber: "41", queryText: "41 subdivision drainage improvements" },
  { sectionNumber: "48", queryText: "48 subdivision park land dedication" },
  // Chapter 14 — Zoning
  { sectionNumber: "14.01.001", queryText: "14.01.001 zoning authority" },
  { sectionNumber: "14.01.003", queryText: "14.01.003 zoning general purpose and intent" },
  { sectionNumber: "14.01.008", queryText: "14.01.008 zoning definitions" },
  { sectionNumber: "14.02.003", queryText: "14.02.003 establishment of zoning districts" },
  { sectionNumber: "14.02.005", queryText: "14.02.005 residential land use table" },
  { sectionNumber: "14.02.007", queryText: "14.02.007 residential development standards" },
  { sectionNumber: "14.02.017", queryText: "14.02.017 non-residential and mixed-use land use table" },
  { sectionNumber: "14.02.031", queryText: "14.02.031 historic district" },
  { sectionNumber: "14.02.032", queryText: "14.02.032 municipal parks district" },
  { sectionNumber: "14.02.033", queryText: "14.02.033 Manor residential revitalization area" },
  { sectionNumber: "14.02.034", queryText: "14.02.034 Austin Executive Joint Airport Zoning Board Hazard" },
  { sectionNumber: "14.02.046", queryText: "14.02.046 accessory structures" },
  { sectionNumber: "14.02.047", queryText: "14.02.047 accessory uses" },
  { sectionNumber: "14.02.048", queryText: "14.02.048 temporary uses and structures" },
  { sectionNumber: "14.02.049", queryText: "14.02.049 outdoor storage and display" },
  // Chapter 15 — Site Development
  { sectionNumber: "15.01.001", queryText: "15.01.001 site development plans general" },
  { sectionNumber: "15.01.003", queryText: "15.01.003 site development plans procedure" },
  { sectionNumber: "15.02.001", queryText: "15.02.001 parking standards general" },
  { sectionNumber: "15.02.004a", queryText: "15.02.004a off-street parking requirements" },
  { sectionNumber: "15.03.001", queryText: "15.03.001 landscaping and screening purpose" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(MANOR_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${MANOR_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildManorCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return MANOR_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `manor-${i + 1}`,
    jurisdictionTenant: MANOR_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
