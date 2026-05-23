/**
 * Lockhart curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest from Municode (clientId 3055): Chapter 46 (Signs),
 * Chapter 52 (Subdivision Regulations), Chapter 64 (Zoning).
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const LOCKHART_JURISDICTION = "lockhart_tx";
export const LOCKHART_JURISDICTION_NAME = "Lockhart, TX";
export const LOCKHART_EDITION_LABEL =
  "Lockhart Development Regulations (current supplement)";
export const LOCKHART_CLIENT_ID = 3055;
export const LOCKHART_LIBRARY_SLUG = "lockhart";
export const LOCKHART_CHAPTER_FILTER = "signs|subdivision|zoning";

interface LockhartQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const LOCKHART_DRAFTS: ReadonlyArray<LockhartQueryDraft> = [
  // Chapter 46 — Signs
  { sectionNumber: "46-3", queryText: "46-3 nonconforming signs" },
  { sectionNumber: "46-6", queryText: "46-6 prohibited signs and locations" },
  { sectionNumber: "46-8", queryText: "46-8 required signs" },
  { sectionNumber: "46-10", queryText: "46-10 sign-type standards" },
  { sectionNumber: "46-12", queryText: "46-12 sign construction standards" },
  // Chapter 52 — Subdivision Regulations
  { sectionNumber: "52-31", queryText: "52-31 subdivision plat required" },
  { sectionNumber: "52-32", queryText: "52-32 subdivision concept plan" },
  { sectionNumber: "52-33", queryText: "52-33 preliminary plat procedure" },
  { sectionNumber: "52-35", queryText: "52-35 final plat procedure" },
  { sectionNumber: "52-36", queryText: "52-36 minor plat or minor replat procedure" },
  { sectionNumber: "52-37", queryText: "52-37 vacating plat" },
  { sectionNumber: "52-38", queryText: "52-38 replatting without vacating preceding plat" },
  { sectionNumber: "52-50", queryText: "52-50 subdivision variances" },
  { sectionNumber: "52-60", queryText: "52-60 subdivision proportionality" },
  { sectionNumber: "52-62", queryText: "52-62 subdivision land dedication" },
  { sectionNumber: "52-72", queryText: "52-72 subdivision streets" },
  { sectionNumber: "52-80", queryText: "52-80 subdivision flood hazard" },
  // Chapter 64 — Zoning
  { sectionNumber: "64-33", queryText: "64-33 zoning upon annexation" },
  { sectionNumber: "64-61", queryText: "64-61 nonconforming uses" },
  { sectionNumber: "64-62", queryText: "64-62 nonconforming buildings" },
  { sectionNumber: "64-95", queryText: "64-95 zoning board of adjustment" },
  { sectionNumber: "64-127", queryText: "64-127 specific use permits" },
  { sectionNumber: "64-128", queryText: "64-128 zoning change" },
  { sectionNumber: "64-129", queryText: "64-129 zoning variances" },
  { sectionNumber: "64-130", queryText: "64-130 zoning special exceptions" },
  { sectionNumber: "64-166", queryText: "64-166 planned development district PDD" },
  { sectionNumber: "64-196", queryText: "64-196 establishment of zoning districts" },
  { sectionNumber: "64-201", queryText: "64-201 sexually-oriented businesses" },
  { sectionNumber: "64-202", queryText: "64-202 wireless telecommunication facilities" },
  { sectionNumber: "64-204", queryText: "64-204 transport containers" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(LOCKHART_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${LOCKHART_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildLockhartCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return LOCKHART_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `lockhart-${i + 1}`,
    jurisdictionTenant: LOCKHART_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
