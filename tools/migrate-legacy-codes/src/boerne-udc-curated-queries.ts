/**
 * Boerne UDC curated query set — Sync 5 TX-metros (San Antonio metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Boerne Unified
 * Development Code, ingested via Path C from the Municode JSON API.
 * Boerne publishes its UDC as a SEPARATE Municode product (productId
 * 15819, "Unified Development Code", distinct from the productId
 * 1332-default Code of Ordinances under the same clientId). The
 * `productNameFilter` adapter option (added with PR #27 for
 * Georgetown, exercised by PR #30 for Austin LDC and PR <this> for
 * San Antonio UDC) selects it.
 *
 * Scope: all nine Chapters of the UDC — 1 General Provisions,
 * 2 Procedures, 3 Zoning, 4 Residential Sites, 5 Nonresidential Sites,
 * 6 Subdivision Design, 7 Infrastructure Design, 8 Environmental
 * Design, 9 Signage. The UDC is small and self-contained (97 sections
 * across the nine chapters); every top-level node is in scope.
 *
 * Section-number convention: chapter-hyphenated decimal,
 * `<chapter>-<section>` (e.g. `1-1`, `3-9`, `8-1`). Each query leads
 * with the section-number anchor so the storage scoring layer's
 * section-number boost fires cleanly; topic terms after the anchor
 * disambiguate.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const BOERNE_UDC_JURISDICTION = "boerne_tx";
export const BOERNE_UDC_JURISDICTION_NAME = "Boerne, TX";
export const BOERNE_UDC_EDITION_LABEL =
  "Boerne Unified Development Code (current supplement)";
export const BOERNE_UDC_CLIENT_ID = 1332;
export const BOERNE_UDC_LIBRARY_SLUG = "boerne";
/**
 * Top-level TOC filter: all nine UDC chapters. Matches "Chapter 1. -
 * General Provisions" … "Chapter 9. - Signage" exactly.
 */
export const BOERNE_UDC_CHAPTER_FILTER = "^chapter ";
/**
 * Municode code-product selector. Boerne's clientId 1332 carries two
 * products (Code of Ordinances + UDC); this picks the UDC.
 */
export const BOERNE_UDC_PRODUCT_FILTER = "unified development code";
/**
 * Municode library code-path segment for the canonical `sourceUrl`.
 */
export const BOERNE_UDC_LIBRARY_CODE_PATH = "unified_development_code";

interface BoerneUdcQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const BOERNE_UDC_DRAFTS: ReadonlyArray<BoerneUdcQueryDraft> = [
  // Chapter 1 — General Provisions
  { sectionNumber: "1-1", queryText: "1-1 unified development code title" },
  { sectionNumber: "1-3", queryText: "1-3 purpose of the unified development code" },
  { sectionNumber: "1-6", queryText: "1-6 applicability" },
  { sectionNumber: "1-10", queryText: "1-10 authority" },
  { sectionNumber: "1-12", queryText: "1-12 decision agents and rules governing decision-making" },
  // Chapter 2 — Procedures
  { sectionNumber: "2-1", queryText: "2-1 general application procedures" },
  { sectionNumber: "2-2", queryText: "2-2 amendments to the unified development code" },
  { sectionNumber: "2-4", queryText: "2-4 vested rights and rights of continued use" },
  { sectionNumber: "2-5", queryText: "2-5 zoning procedures" },
  { sectionNumber: "2-6", queryText: "2-6 platting procedure" },
  { sectionNumber: "2-13", queryText: "2-13 extraterritorial jurisdiction" },
  // Chapter 3 — Zoning
  { sectionNumber: "3-1", queryText: "3-1 zoning provisions" },
  { sectionNumber: "3-2", queryText: "3-2 zoning map" },
  { sectionNumber: "3-3", queryText: "3-3 nonconformities" },
  { sectionNumber: "3-4", queryText: "3-4 base zoning categories" },
  { sectionNumber: "3-7", queryText: "3-7 permitted use tables" },
  { sectionNumber: "3-11", queryText: "3-11 historic district" },
  // Chapter 4 — Residential Sites
  { sectionNumber: "4-2", queryText: "4-2 residential buildings" },
  { sectionNumber: "4-5", queryText: "4-5 residential garages and accessory structures" },
  // Chapter 5 — Nonresidential Sites
  { sectionNumber: "5-3", queryText: "5-3 nonresidential buildings" },
  { sectionNumber: "5-6", queryText: "5-6 on-site parking for nonresidential properties" },
  // Chapter 6 — Subdivision Design
  { sectionNumber: "6-2", queryText: "6-2 subdivision lots" },
  { sectionNumber: "6-8", queryText: "6-8 conservation subdivisions" },
  // Chapter 7 — Infrastructure Design
  { sectionNumber: "7-3", queryText: "7-3 street and sidewalk specifications and construction standards" },
  { sectionNumber: "7-6", queryText: "7-6 water and sewer" },
  { sectionNumber: "7-7", queryText: "7-7 drainage" },
  // Chapter 8 — Environmental Design
  { sectionNumber: "8-1", queryText: "8-1 floodplain management" },
  { sectionNumber: "8-3", queryText: "8-3 tree preservation" },
  // Chapter 9 — Signage
  { sectionNumber: "9-1", queryText: "9-1 general sign provisions" },
  { sectionNumber: "9-7", queryText: "9-7 general sign standards" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(BOERNE_UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${BOERNE_UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildBoerneUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return BOERNE_UDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `boerne-udc-${i + 1}`,
    jurisdictionTenant: BOERNE_UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
