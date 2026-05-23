/**
 * Saginaw curated query set — Sync 5 TX-metros (Fort Worth metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Saginaw development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 4174). Saginaw publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters
 * + Appendices A (Zoning) and B (Subdivisions):
 *
 *   Chapter 10    Buildings and Building Regulations
 *   Chapter 38    Flood Damage Prevention
 *   Chapter 43    Water and Sanitary Sewer Impact Fees
 *   Chapter 62    Planning and Development
 *   Chapter 98    Utilities
 *   Appendix A    Zoning           (Article N / Sec. N-M)
 *   Appendix B    Subdivisions     (Article N / Sec. N.M decimal)
 *
 * Section-number conventions: chapter-hyphenated for the CoO chapters
 * (`38-1`, `43-1`), Article+hyphen for Appendix A (`1-1`, `1-2`), and
 * dotted-decimal for Appendix B (`1.01`, `1.02`).
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SAGINAW_JURISDICTION = "saginaw_tx";
export const SAGINAW_JURISDICTION_NAME = "Saginaw, TX";
export const SAGINAW_EDITION_LABEL =
  "Saginaw Development Regulations (current supplement)";
export const SAGINAW_CLIENT_ID = 4174;
export const SAGINAW_LIBRARY_SLUG = "saginaw";
export const SAGINAW_CHAPTER_FILTER =
  "^chapter (10|38|43|62|98) |^appendix [ab] ";

interface SaginawQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const SAGINAW_DRAFTS: ReadonlyArray<SaginawQueryDraft> = [
  // Chapter 38 — Flood Damage Prevention
  { sectionNumber: "38-1", queryText: "38-1 flood damage prevention statutory authorization" },
  { sectionNumber: "38-2", queryText: "38-2 flood damage prevention findings of fact" },
  { sectionNumber: "38-3", queryText: "38-3 flood damage prevention statement of purpose" },
  { sectionNumber: "38-4", queryText: "38-4 methods of reducing flood losses" },
  { sectionNumber: "38-5", queryText: "38-5 flood damage definitions" },
  // Chapter 43 — Water and Sanitary Sewer Impact Fees
  { sectionNumber: "43-1", queryText: "43-1 water and sanitary sewer impact fees purpose" },
  { sectionNumber: "43-2", queryText: "43-2 impact fees authority" },
  { sectionNumber: "43-3", queryText: "43-3 impact fees definitions" },
  { sectionNumber: "43-4", queryText: "43-4 applicability of impact fees" },
  { sectionNumber: "43-5", queryText: "43-5 impact fees as conditions of development approval" },
  // Appendix A — Zoning (Article-keyed Sec. N-M)
  { sectionNumber: "1-1", queryText: "1-1 zoning establishment of controls" },
  { sectionNumber: "1-2", queryText: "1-2 zoning administration and enforcement" },
  { sectionNumber: "1-3", queryText: "1-3 zoning changes and amendments" },
  { sectionNumber: "1-4", queryText: "1-4 zoning districts and district boundaries" },
  { sectionNumber: "1-5", queryText: "1-5 zoning use districts" },
  // Appendix B — Subdivisions (Article-keyed Sec. N.M)
  { sectionNumber: "1.01", queryText: "1.01 subdivision short title" },
  { sectionNumber: "1.02", queryText: "1.02 subdivision authority" },
  { sectionNumber: "1.03", queryText: "1.03 subdivision purpose" },
  { sectionNumber: "1.04", queryText: "1.04 subdivision interpretation" },
  { sectionNumber: "1.05", queryText: "1.05 subdivision definitions" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SAGINAW_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SAGINAW_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSaginawCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SAGINAW_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `saginaw-${i + 1}`,
    jurisdictionTenant: SAGINAW_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
