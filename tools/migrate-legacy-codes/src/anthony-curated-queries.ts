/**
 * Anthony curated query set — Sync 5 TX-metros (El Paso area), Path C
 * scope.
 *
 * Reviewer-realistic queries against the Town of Anthony development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 1045). Anthony publishes a single Municipal Code product
 * whose development surface spans five Titles — the multi-title shape,
 * scoped by chapter filter to:
 *
 *   Title 12   Streets, Sidewalks and Public Places
 *   Title 13   Public Services           (water and sewer system)
 *   Title 15   Buildings and Construction  (IBC adoption + permits)
 *   Title 16   Subdivisions
 *   Title 17   Zoning
 *
 * The decimal-numbered convention is `<title>.<chapter>.<section>`
 * (e.g. `17.04.020`, `15.04.010`, `16.08.040`). Each query leads with
 * the section-number anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const ANTHONY_JURISDICTION = "anthony_tx";
export const ANTHONY_JURISDICTION_NAME = "Anthony, TX";
export const ANTHONY_EDITION_LABEL =
  "Anthony Municipal Code (current supplement)";
export const ANTHONY_CLIENT_ID = 1045;
export const ANTHONY_LIBRARY_SLUG = "anthony";
/**
 * Top-level TOC filter: the five substantive Titles. Matches "Title
 * 12 - …" through "Title 17 - …"; excludes Charter, Title 1-10
 * (admin/finance/business/animals/health/public-peace/vehicles).
 */
export const ANTHONY_CHAPTER_FILTER = "^title (1[2-7]) ";

interface AnthonyQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const ANTHONY_DRAFTS: ReadonlyArray<AnthonyQueryDraft> = [
  // Title 12 — Streets, Sidewalks and Public Places
  { sectionNumber: "12.04.010", queryText: "12.04.010 street address system" },
  { sectionNumber: "12.20.010", queryText: "12.20.010 sidewalk construction and maintenance" },
  // Title 13 — Public Services
  { sectionNumber: "13.04.010", queryText: "13.04.010 water and sewer service system" },
  { sectionNumber: "13.08.010", queryText: "13.08.010 sewage disposal regulations" },
  { sectionNumber: "13.16.010", queryText: "13.16.010 water wells" },
  // Title 15 — Buildings and Construction
  { sectionNumber: "15.04.010", queryText: "15.04.010 international building code adopted" },
  { sectionNumber: "15.05.010", queryText: "15.05.010 plumbing code" },
  { sectionNumber: "15.06.010", queryText: "15.06.010 electric code" },
  { sectionNumber: "15.07.010", queryText: "15.07.010 international property maintenance codes" },
  { sectionNumber: "15.08.010", queryText: "15.08.010 building permits" },
  { sectionNumber: "15.12.010", queryText: "15.12.010 grading permits" },
  // Title 16 — Subdivisions
  { sectionNumber: "16.04.010", queryText: "16.04.010 subdivision general provisions" },
  { sectionNumber: "16.08.010", queryText: "16.08.010 subdivision street plan relation to adjoining street system" },
  { sectionNumber: "16.08.040", queryText: "16.08.040 subdivision street alignment" },
  { sectionNumber: "16.08.050", queryText: "16.08.050 subdivision street rights-of-way and roadway widths" },
  { sectionNumber: "16.10.010", queryText: "16.10.010 subdivision minimum standards" },
  { sectionNumber: "16.12.010", queryText: "16.12.010 subdivision procedure" },
  { sectionNumber: "16.14.010", queryText: "16.14.010 subdivision plat approval" },
  { sectionNumber: "16.16.010", queryText: "16.16.010 subdivision improvements" },
  // Title 17 — Zoning
  { sectionNumber: "17.04.010", queryText: "17.04.010 zoning purpose" },
  { sectionNumber: "17.04.020", queryText: "17.04.020 zoning districts established" },
  { sectionNumber: "17.04.030", queryText: "17.04.030 zoning general provisions" },
  { sectionNumber: "17.04.040", queryText: "17.04.040 zoning map amendments" },
  { sectionNumber: "17.06.010", queryText: "17.06.010 zoning permitted uses" },
  { sectionNumber: "17.07.010", queryText: "17.07.010 agricultural districts" },
  { sectionNumber: "17.08.010", queryText: "17.08.010 residential districts compliance required" },
  { sectionNumber: "17.08.020", queryText: "17.08.020 residential districts permitted uses" },
  { sectionNumber: "17.08.030", queryText: "17.08.030 residential districts construction restrictions" },
  { sectionNumber: "17.10.010", queryText: "17.10.010 open space districts" },
  { sectionNumber: "17.12.010", queryText: "17.12.010 commercial districts" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(ANTHONY_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${ANTHONY_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildAnthonyCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return ANTHONY_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `anthony-${i + 1}`,
    jurisdictionTenant: ANTHONY_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
