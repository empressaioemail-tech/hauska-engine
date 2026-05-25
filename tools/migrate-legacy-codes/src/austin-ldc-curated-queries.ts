/**
 * Austin LDC curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Reviewer-realistic queries against the City of Austin Land
 * Development Code, ingested via Path C from the Municode JSON API.
 * Austin publishes its LDC as a SEPARATE Municode product (productId
 * 15303, "Land Development Code", distinct from the productId 15302
 * "Code of Ordinances"). The `productNameFilter` adapter option
 * (added with PR #27 for Georgetown) selects it.
 *
 * The scope is the two top-level Titles of the LDC:
 *
 *   Title 25  Land Development         (13 chapters: General Reqs,
 *                                       Zoning, TNDs, Subdivision,
 *                                       Site Plans, Transportation,
 *                                       Drainage, Environment, Water/
 *                                       Wastewater, Sign Regulations,
 *                                       Building/Demo Permits,
 *                                       Technical Codes, Airport Hazard)
 *   Title 30  Austin/Travis County     (5 chapters: General, Subdivision
 *             Subdivision Regulations    Requirements, Transportation,
 *                                       Drainage, Environment)
 *
 * Front matter ("THE CODE OF THE CITY OF AUSTIN, TEXAS"), the supplement
 * history table, and the code comparative table are excluded by the
 * chapter filter.
 *
 * Section-number convention: chapter-hyphenated decimal,
 * `<chapter>-<section>` (e.g. `25-2-491`, `25-4-5`, `30-1-12`). Each
 * query leads with the section-number anchor so the storage scoring
 * layer's section-number boost fires cleanly; topic terms after the
 * anchor disambiguate.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const AUSTIN_LDC_JURISDICTION = "austin_tx";
export const AUSTIN_LDC_JURISDICTION_NAME = "Austin, TX";
export const AUSTIN_LDC_EDITION_LABEL =
  "Austin Land Development Code (current supplement)";
export const AUSTIN_LDC_CLIENT_ID = 1113;
export const AUSTIN_LDC_LIBRARY_SLUG = "austin";
/**
 * Top-level TOC filter: the two substantive Titles. Matches "TITLE 25.
 * - LAND DEVELOPMENT." and "TITLE 30. - AUSTIN/TRAVIS COUNTY SUBDIVISION
 * REGULATIONS.", excludes the preamble title node, supplement history
 * table, and the code comparative table.
 */
export const AUSTIN_LDC_CHAPTER_FILTER = "^title\\s+(25|30)\\b";
/**
 * Municode code-product selector. Austin's clientId carries multiple
 * products (Code of Ordinances + LDC + ten criteria manuals); this
 * picks the LDC.
 */
export const AUSTIN_LDC_PRODUCT_FILTER = "land development code";
/** Municode library code-path segment for the canonical `sourceUrl`. */
export const AUSTIN_LDC_LIBRARY_CODE_PATH = "land_development_code";

interface AustinLdcQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const AUSTIN_LDC_DRAFTS: ReadonlyArray<AustinLdcQueryDraft> = [
  // Title 25 — Land Development (13 chapters)
  // Ch 25-1 General Requirements and Procedures
  { sectionNumber: "25-1-1", queryText: "25-1-1 implementation of comprehensive plan" },
  { sectionNumber: "25-1-43", queryText: "25-1-43 watershed protection and development review department" },
  { sectionNumber: "25-1-46", queryText: "25-1-46 city land use commission" },
  // Ch 25-2 Zoning (the largest chapter, 496 sections)
  { sectionNumber: "25-2-1", queryText: "25-2-1 zoning use classifications" },
  { sectionNumber: "25-2-3", queryText: "25-2-3 residential uses described" },
  { sectionNumber: "25-2-32", queryText: "25-2-32 zoning districts and map codes" },
  { sectionNumber: "25-2-51", queryText: "25-2-51 purposes of residential districts" },
  // Ch 25-4 Subdivision
  { sectionNumber: "25-4-1", queryText: "25-4-1 subdivision platting compliance" },
  { sectionNumber: "25-4-33", queryText: "25-4-33 appeal of disapproval of preliminary plan and plat" },
  { sectionNumber: "25-4-38", queryText: "25-4-38 infrastructure construction fiscal security plat approval" },
  // Ch 25-6 Transportation
  { sectionNumber: "25-6-22", queryText: "25-6-22 establishing building lines" },
  { sectionNumber: "25-6-51", queryText: "25-6-51 reservation of right-of-way" },
  // Ch 25-7 Drainage
  { sectionNumber: "25-7-3", queryText: "25-7-3 obstruction of waterways prohibited" },
  { sectionNumber: "25-7-8", queryText: "25-7-8 computation of stormwater runoff" },
  // Ch 25-8 Environment
  { sectionNumber: "25-8-25", queryText: "25-8-25 redevelopment exception urban and suburban watersheds" },
  { sectionNumber: "25-8-41", queryText: "25-8-41 environmental land use commission variances" },
  // Ch 25-9 Water and Wastewater
  { sectionNumber: "25-9-2", queryText: "25-9-2 service area of Austin Water Utility" },
  { sectionNumber: "25-9-33", queryText: "25-9-33 service extension application" },
  // Ch 25-10 Sign Regulations
  { sectionNumber: "25-10-23", queryText: "25-10-23 hazardous signs described and prohibited" },
  { sectionNumber: "25-10-41", queryText: "25-10-41 sign board of adjustment powers" },
  // Ch 25-11 Building, Demolition, Relocation Permits
  { sectionNumber: "25-11-37", queryText: "25-11-37 demolition permit requirement" },
  { sectionNumber: "25-11-39", queryText: "25-11-39 construction and demolition materials diversion" },
  // Ch 25-12 Technical Codes
  { sectionNumber: "25-12-1", queryText: "25-12-1 international building code adopted" },
  { sectionNumber: "25-12-53", queryText: "25-12-53 flood loads" },
  // Ch 25-13 Airport Hazard
  { sectionNumber: "25-13-21", queryText: "25-13-21 imaginary surfaces and airport hazard zones" },
  { sectionNumber: "25-13-41", queryText: "25-13-41 airport overlay zones" },
  // Title 30 — Austin/Travis County Subdivision Regulations (5 chapters)
  { sectionNumber: "30-1-43", queryText: "30-1-43 county land use commission" },
  { sectionNumber: "30-2-1", queryText: "30-2-1 county subdivision compliance" },
  { sectionNumber: "30-2-36", queryText: "30-2-36 county variance filing and consideration" },
  { sectionNumber: "30-5-62", queryText: "30-5-62 net site area" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(AUSTIN_LDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${AUSTIN_LDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildAustinLdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return AUSTIN_LDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `austin-ldc-${i + 1}`,
    jurisdictionTenant: AUSTIN_LDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
