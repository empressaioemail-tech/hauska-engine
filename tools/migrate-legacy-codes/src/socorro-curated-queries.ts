/**
 * Socorro curated query set — Sync 5 TX-metros (El Paso area), Path C
 * scope.
 *
 * Reviewer-realistic queries against the City of Socorro development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 4371). Socorro publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters,
 * scoped by chapter filter to:
 *
 *   Chapter 6    Buildings and Construction
 *   Chapter 14   Environment                 (incl. flood prevention)
 *   Chapter 26   Manufactured and Mobile Homes
 *   Chapter 32   Parks and Recreation
 *   Chapter 36   Streets, Sidewalks and Other Public Places
 *   Chapter 38   Subdivisions
 *   Chapter 44   Utilities                   (water, sewer, storm sewer)
 *   Chapter 46   Zoning
 *
 * Section-number convention: chapter-hyphenated (`<chapter>-<section>`,
 * e.g. `46-1`, `38-47`, `14-19`). Reserved-range section labels
 * (`Secs. X-N—X-M. - Reserved.`) are common and intentionally not
 * targeted as queries.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SOCORRO_JURISDICTION = "socorro_tx";
export const SOCORRO_JURISDICTION_NAME = "Socorro, TX";
export const SOCORRO_EDITION_LABEL =
  "Socorro Development Regulations (current supplement)";
export const SOCORRO_CLIENT_ID = 4371;
export const SOCORRO_LIBRARY_SLUG = "socorro";
/**
 * Top-level TOC filter: the eight development chapters.
 */
export const SOCORRO_CHAPTER_FILTER =
  "buildings and construction|environment|manufactured and mobile|parks and recreation|streets, sidewalks|subdivisions|utilities|zoning";

interface SocorroQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const SOCORRO_DRAFTS: ReadonlyArray<SocorroQueryDraft> = [
  // Chapter 6 — Buildings and Construction
  { sectionNumber: "6-1", queryText: "6-1 buildings definitions" },
  { sectionNumber: "6-2", queryText: "6-2 approval of permits exceptions and related documents or requests" },
  // Chapter 14 — Environment (flood prevention)
  { sectionNumber: "14-19", queryText: "14-19 flood prevention definitions" },
  { sectionNumber: "14-21", queryText: "14-21 flood prevention purpose" },
  { sectionNumber: "14-22", queryText: "14-22 methods of reducing flood losses" },
  { sectionNumber: "14-24", queryText: "14-24 basis for establishing the areas of special flood hazard" },
  { sectionNumber: "14-74", queryText: "14-74 flood hazard reduction general standard" },
  { sectionNumber: "14-76", queryText: "14-76 flood hazard standards for subdivision proposals" },
  // Chapter 26 — Manufactured and Mobile Homes
  { sectionNumber: "26-1", queryText: "26-1 manufactured and mobile homes definitions" },
  // Chapter 32 — Parks and Recreation
  { sectionNumber: "32-1", queryText: "32-1 parks and recreation definitions" },
  // Chapter 36 — Streets
  { sectionNumber: "36-1", queryText: "36-1 city museum" },
  // Chapter 38 — Subdivisions
  { sectionNumber: "38-1", queryText: "38-1 subdivision applicability" },
  { sectionNumber: "38-2", queryText: "38-2 subdivision purpose" },
  { sectionNumber: "38-3", queryText: "38-3 subdivision penalties and enforcement" },
  { sectionNumber: "38-4", queryText: "38-4 subdivision exemptions" },
  { sectionNumber: "38-47", queryText: "38-47 subdivision definitions" },
  { sectionNumber: "38-48", queryText: "38-48 subdivision introduction" },
  { sectionNumber: "38-49", queryText: "38-49 subdivision compliance with requirements" },
  { sectionNumber: "38-50", queryText: "38-50 subdivision provision of easements" },
  { sectionNumber: "38-51", queryText: "38-51 subdivision survey monuments" },
  // Chapter 44 — Utilities
  { sectionNumber: "44-40", queryText: "44-40 state on-site sewage disposal system rules adopted" },
  { sectionNumber: "44-41", queryText: "44-41 portable toilets" },
  { sectionNumber: "44-71", queryText: "44-71 municipal separate storm sewer system intent and purpose" },
  { sectionNumber: "44-73", queryText: "44-73 municipal separate storm sewer system applicability" },
  { sectionNumber: "44-75", queryText: "44-75 prohibition of illicit connections and discharges" },
  // Chapter 46 — Zoning
  { sectionNumber: "46-1", queryText: "46-1 zoning definitions" },
  { sectionNumber: "46-620", queryText: "46-620 zoning supplemental regulations general restrictions" },
  { sectionNumber: "46-621", queryText: "46-621 visibility at intersections" },
  { sectionNumber: "46-622", queryText: "46-622 fences walls and hedges" },
  { sectionNumber: "46-623", queryText: "46-623 accessory building" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SOCORRO_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SOCORRO_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSocorroCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SOCORRO_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `socorro-${i + 1}`,
    jurisdictionTenant: SOCORRO_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
