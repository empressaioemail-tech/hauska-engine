/**
 * Keller curated query set — Sync 5 TX-metros (Fort Worth metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Keller Unified
 * Development Code, ingested via Path C from the Municode JSON API
 * (clientId 2809). Keller publishes its UDC at the top level under
 * `PART III - UNIFIED DEVELOPMENT CODE`, with eleven Articles plus
 * appendices nested inside. The chapter filter targets the PART III
 * wrapper; the walker descends through it to all Article children
 * (the wrapper is dev-only — non-UDC content lives at PART I Charter
 * and PART II Code, neither of which match the filter).
 *
 *   Article One     Introduction              (Sec. 1.01–)
 *   Article Two     General Provisions        (Sec. 2.01–)
 *   Article Three   Definitions               (Sec. 3.01–)
 *   Article Four    Development Procedures    (Sec. 4.01–)
 *   Article Five    Subdivision Design and Improvement Requirements  (Sec. 5.01–)
 *   Article Six     General Development Guidelines                   (Sec. 6.01–)
 *   Article Seven   Public Park and Trail Systems Land Dedication    (Sec. 7.01–)
 *   Article Eight   Zoning Districts          (Sec. 8.01–)
 *   Article Nine    Development Standards     (Sec. 9.01–)
 *   Article Ten     Tree Preservation         (Sec. 10.01–)
 *   Article Eleven  Appendices                (Sec. 11.01–)
 *   Appendix B      Franchise Regulations
 *   Appendix C      Fee Schedule
 *
 * Section-number convention: dotted-decimal `<article>.<section>`
 * (`1.01`, `5.03`, `8.04`). The TOC labels them as "Section N.MM" —
 * `normalizeSectionLabel`+`stripSectionPrefix` collapses both
 * "Sec." and "Section" prefixes consistently.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const KELLER_JURISDICTION = "keller_tx";
export const KELLER_JURISDICTION_NAME = "Keller, TX";
export const KELLER_EDITION_LABEL =
  "Keller Unified Development Code (current supplement)";
export const KELLER_CLIENT_ID = 2809;
export const KELLER_LIBRARY_SLUG = "keller";
/**
 * Top-level TOC filter: the PART III UDC wrapper. The walker
 * descends through it and pulls all eleven Articles + Appendices B
 * and C; PART I Charter and PART II Code are excluded by the filter.
 */
export const KELLER_CHAPTER_FILTER = "^part iii ";

interface KellerQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const KELLER_DRAFTS: ReadonlyArray<KellerQueryDraft> = [
  // Article One — Introduction
  { sectionNumber: "1.01", queryText: "1.01 UDC title" },
  { sectionNumber: "1.02", queryText: "1.02 use of the unified development code" },
  { sectionNumber: "1.03", queryText: "1.03 relationship to the master plan for the city of keller" },
  { sectionNumber: "1.04", queryText: "1.04 other documents needed for land development" },
  { sectionNumber: "1.05", queryText: "1.05 departments and boards involved in land development" },
  // Article Five — Subdivision Design and Improvement Requirements
  { sectionNumber: "5.01", queryText: "5.01 adequate public facilities and services" },
  { sectionNumber: "5.02", queryText: "5.02 grading excavating and land clearing permit" },
  { sectionNumber: "5.03", queryText: "5.03 streets and thoroughfares" },
  { sectionNumber: "5.04", queryText: "5.04 private street developments" },
  { sectionNumber: "5.05", queryText: "5.05 alleys" },
  // Article Eight — Zoning Districts
  { sectionNumber: "8.01", queryText: "8.01 zoning regulations" },
  { sectionNumber: "8.02", queryText: "8.02 zoning administration" },
  { sectionNumber: "8.03", queryText: "8.03 zoning districts established" },
  { sectionNumber: "8.04", queryText: "8.04 SF-36 single-family residential 36000 square-foot lots" },
  { sectionNumber: "8.05", queryText: "8.05 SF-30 single-family residential 30000 square-foot lots" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(KELLER_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${KELLER_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildKellerCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return KELLER_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `keller-${i + 1}`,
    jurisdictionTenant: KELLER_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
