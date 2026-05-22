/**
 * Georgetown UDC curated query set — Sync 5 Tier 1, Path C scope.
 *
 * Reviewer-realistic queries against the City of Georgetown "Unified
 * Development Code", ingested via Path C from the Municode JSON API.
 * This is the Layer 3 bespoke local code — Georgetown's zoning,
 * subdivision, and development regulations in one consolidated UDC.
 *
 * NOTE on source: Georgetown publishes TWO code products under one
 * Municode clientId (12078) — its Code of Ordinances and, separately,
 * its Unified Development Code. The prior Tier 1 discovery saw the
 * `Title 17 UDC` node on the Code of Ordinances marked `children=false`
 * and predicted a Path PDF investigation; in fact the UDC is its own
 * fully-structured Municode product (productId 13943, "Unified
 * Development Code"). Georgetown is therefore a clean Path C city — the
 * ingest just has to select the non-default code product, which the
 * `productNameFilter` adapter option (added with this ingest) does.
 *
 * The UDC has 16 numbered chapters:
 *
 *   Chapter 1   General Provisions
 *   Chapter 2   Review Authority
 *   Chapter 3   Applications and Permits
 *   Chapter 4   Zoning Districts
 *   Chapter 5   Zoning Use Regulations
 *   Chapter 6   Residential Development Standards
 *   Chapter 7   Non-Residential Development Standards
 *   Chapter 8   Tree Preservation, Landscaping and Fencing
 *   Chapter 9   Off-Street Parking and Loading
 *   Chapter 10  Sign Standards
 *   Chapter 11  Environmental Protection
 *   Chapter 12  Pedestrian and Vehicle Circulation
 *   Chapter 13  Infrastructure and Public Improvements
 *   Chapter 14  Nonconformities
 *   Chapter 15  Enforcement
 *   Chapter 16  Definitions
 *
 * Georgetown's UDC numbers headings two ways: top-level units as
 * `SECTION N.NN` (e.g. `SECTION 1.02`) and the leaf provisions beneath
 * them as `Sec. N.NN.NNN` (e.g. `Sec. 1.01.010`). Both atomize to
 * independently retrievable `code-section` atoms. Each query leads with
 * the section-number anchor so the storage scoring layer's
 * section-number boost fires cleanly; topic terms after the anchor
 * disambiguate against neighbour sections.
 *
 * Visibility: Georgetown is non-partnered, so the jurisdiction-corpus is
 * tagged `platform-internal` per Path A. Authorship `llm-generated`,
 * status `draft` until reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const GEORGETOWN_UDC_JURISDICTION = "georgetown_tx";
export const GEORGETOWN_UDC_JURISDICTION_NAME = "Georgetown, TX";
export const GEORGETOWN_UDC_EDITION_LABEL =
  "Georgetown Unified Development Code (current supplement)";
export const GEORGETOWN_UDC_CLIENT_ID = 12078;
export const GEORGETOWN_UDC_LIBRARY_SLUG = "georgetown";
/**
 * Top-level TOC filter: the 16 substantive `Chapter N - TITLE` units.
 * Excludes the non-normative front/back matter that sits at the same
 * TOC level (preamble, supplement-history table, federal-standards
 * appendix, code-comparative table).
 */
export const GEORGETOWN_UDC_CHAPTER_FILTER = "^chapter\\s+\\d+";
/**
 * Municode code-product selector. Georgetown's clientId carries both a
 * Code of Ordinances and the UDC; this picks the UDC product.
 */
export const GEORGETOWN_UDC_PRODUCT_FILTER = "unified development code";
/** Municode library code-path segment for the canonical `sourceUrl`. */
export const GEORGETOWN_UDC_LIBRARY_CODE_PATH = "unified_development_code";

interface GeorgetownQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const GEORGETOWN_DRAFTS: ReadonlyArray<GeorgetownQueryDraft> = [
  // Chapter 1 — General Provisions
  { sectionNumber: "1.01.010", queryText: "1.01.010 how to use this development code" },
  { sectionNumber: "1.04.030", queryText: "1.04.030 legal nonconforming uses under the zoning ordinance" },
  { sectionNumber: "1.05.020", queryText: "1.05.020 jurisdiction within the city's extraterritorial jurisdiction" },
  { sectionNumber: "1.11", queryText: "1.11 UDC development manual" },
  // Chapter 2 — Review Authority
  { sectionNumber: "2.02.010", queryText: "2.02.010 director of planning" },
  { sectionNumber: "2.04", queryText: "2.04 zoning board of adjustment ZBA" },
  { sectionNumber: "2.08", queryText: "2.08 unified development code UDC advisory committee" },
  // Chapter 3 — Applications and Permits
  { sectionNumber: "3.06", queryText: "3.06 zoning map amendment rezoning" },
  { sectionNumber: "3.07", queryText: "3.07 special use permit" },
  { sectionNumber: "3.08.070", queryText: "3.08.070 preliminary plats" },
  { sectionNumber: "3.15", queryText: "3.15 zoning variance and special exception" },
  { sectionNumber: "3.23", queryText: "3.23 tree removal permit" },
  // Chapter 4 — Zoning Districts
  { sectionNumber: "4.01", queryText: "4.01 establishment of zoning districts" },
  { sectionNumber: "4.06", queryText: "4.06 planned unit development district" },
  { sectionNumber: "4.08.020", queryText: "4.08.020 historic overlay districts established" },
  { sectionNumber: "4.10", queryText: "4.10 courthouse view protection overlay district" },
  // Chapter 5 — Zoning Use Regulations
  { sectionNumber: "5.01.020", queryText: "5.01.020 zoning use classifications" },
  { sectionNumber: "5.10.030", queryText: "5.10.030 collocation of antennas on existing towers" },
  // Chapter 6 — Residential Development Standards
  { sectionNumber: "6.02.050", queryText: "6.02.050 RS residential single-family district" },
  // Chapter 7 — Non-Residential Development Standards
  { sectionNumber: "7.03.050", queryText: "7.03.050 building articulation and architectural features" },
  // Chapter 8 — Tree Preservation, Landscaping and Fencing
  { sectionNumber: "8.02.030", queryText: "8.02.030 heritage and protected tree removal" },
  { sectionNumber: "8.07.040", queryText: "8.07.040 residential fences standards" },
  // Chapter 9 — Off-Street Parking and Loading
  { sectionNumber: "9.03.020", queryText: "9.03.020 parking space and parking lot design" },
  // Chapter 10 — Sign Standards
  { sectionNumber: "10.04", queryText: "10.04 types of signs prohibited under this code" },
  // Chapter 11 — Environmental Protection
  { sectionNumber: "11.02.010", queryText: "11.02.010 impervious cover limitation" },
  { sectionNumber: "11.07", queryText: "11.07 water quality regulations Edwards aquifer recharge zone" },
  // Chapter 12 — Pedestrian and Vehicle Circulation
  { sectionNumber: "12.09.030", queryText: "12.09.030 traffic impact analysis" },
  // Chapter 13 — Infrastructure and Public Improvements
  { sectionNumber: "13.08.030", queryText: "13.08.030 requirements for parkland dedication" },
  // Chapter 14 — Nonconformities
  { sectionNumber: "14.04.010", queryText: "14.04.010 nonconforming structures generally" },
  // Chapter 15 — Enforcement
  { sectionNumber: "15.03.030", queryText: "15.03.030 enforcement penalties" },
];

/**
 * Mirrors the Path C atomizer's section entityId construction:
 * `<jurisdiction>/<slug(editionLabel)>/<slug(strip(normalize(num)))>`.
 */
function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(GEORGETOWN_UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${GEORGETOWN_UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildGeorgetownUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return GEORGETOWN_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `georgetown-udc-${i + 1}`,
    jurisdictionTenant: GEORGETOWN_UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
