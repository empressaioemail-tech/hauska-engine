/**
 * Leon Valley curated query set — Sync 5 TX-metros (San Antonio
 * metro), Path C scope.
 *
 * Reviewer-realistic queries against the City of Leon Valley
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 3008). Single Code of Ordinances product; top-level
 * chapters:
 *
 *   Chapter 3    Building Regulations
 *   Chapter 10   Subdivision Regulation
 *   Chapter 13   Tree Preservation
 *   Chapter 14   Utilities
 *   Chapter 15   Zoning
 *   Appendix A   Fee Schedule
 *
 * Section-number convention: three-segment dotted `chapter.article.
 * section` (e.g. `15.02.001`, `3.01.001`, `A1.001` for the Appendix
 * A fee schedule). Each query leads with the section-number anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const LEON_VALLEY_JURISDICTION = "leon_valley_tx";
export const LEON_VALLEY_JURISDICTION_NAME = "Leon Valley, TX";
export const LEON_VALLEY_EDITION_LABEL =
  "Leon Valley Development Regulations (current supplement)";
export const LEON_VALLEY_CLIENT_ID = 3008;
export const LEON_VALLEY_LIBRARY_SLUG = "leon_valley";
export const LEON_VALLEY_CHAPTER_FILTER =
  "^chapter (3|10|13|14|15) |^appendix a ";

interface LeonValleyQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const LEON_VALLEY_DRAFTS: ReadonlyArray<LeonValleyQueryDraft> = [
  // Chapter 3 — Building Regulations
  { sectionNumber: "3.01.001", queryText: "3.01.001 chemical toilets at construction sites" },
  { sectionNumber: "3.01.002", queryText: "3.01.002 trench safety" },
  { sectionNumber: "3.01.003", queryText: "3.01.003 payment of prevailing wage rates on public works projects" },
  // Chapter 15 — Zoning (Division 1 — Generally)
  { sectionNumber: "15.02.001", queryText: "15.02.001 zoning title" },
  { sectionNumber: "15.02.002", queryText: "15.02.002 zoning purpose and effect" },
  { sectionNumber: "15.02.003", queryText: "15.02.003 zoning scope" },
  { sectionNumber: "15.02.051", queryText: "15.02.051 zoning words and phrases rules of construction" },
  { sectionNumber: "15.02.052", queryText: "15.02.052 zoning definitions" },
  // Appendix A — Fee Schedule
  { sectionNumber: "A1.001", queryText: "A1.001 fee schedule purpose" },
  { sectionNumber: "A1.002", queryText: "A1.002 fee schedule scope" },
  { sectionNumber: "A1.003", queryText: "A1.003 fee schedule compliance" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(LEON_VALLEY_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${LEON_VALLEY_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildLeonValleyCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return LEON_VALLEY_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `leon-valley-${i + 1}`,
    jurisdictionTenant: LEON_VALLEY_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
