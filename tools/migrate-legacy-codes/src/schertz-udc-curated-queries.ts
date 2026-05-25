/**
 * Schertz UDC curated query set — Sync 5 TX-metros (San Antonio
 * metro), Path C scope.
 *
 * Reviewer-realistic queries against the City of Schertz Unified
 * Development Code, ingested via Path C from the Municode JSON API.
 * Schertz publishes its UDC as a SEPARATE Municode product (clientId
 * 4260, productId 14745, "Unified Development Code") whose top-level
 * TOC carries a single wrapper node "SCHERTZ UNIFIED DEVELOPMENT
 * CODE" containing 16 Articles. The chapter filter targets the
 * wrapper; the walker descends through it.
 *
 *   Article 1    General Provisions               (Sec. 21.1.N)
 *   Article 2    Official Maps                    (Sec. 21.2.N)
 *   Article 3    Boards, Commissions and Committees
 *   Article 4    Procedures and Applications
 *   Article 5    Zoning Districts                 (Sec. 21.5.N)
 *   Article 6    Manufactured Homes and RV Parks
 *   Article 7    Nonconforming Uses, Lots and Structures
 *   Article 8    Special Uses and General Regulations
 *   Article 9    Site Design Standards
 *   Article 10   Parking Standards
 *   Article 11   Signs and Advertising Devices
 *   Article 12   Subdivisions                     (Sec. 21.12.N)
 *   Article 13   Land Disturbing Activities and Drainage
 *   Article 14   Transportation
 *   Article 15   Easements and Utilities
 *   Article 16   Definitions
 *
 * Section-number convention: three-segment dotted `21.<article>.<section>`
 * — the "21" prefix carries from Chapter 21 of the parent Code of
 * Ordinances (the UDC legally lives as Chapter 21 of the city code).
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SCHERTZ_UDC_JURISDICTION = "schertz_tx";
export const SCHERTZ_UDC_JURISDICTION_NAME = "Schertz, TX";
export const SCHERTZ_UDC_EDITION_LABEL =
  "Schertz Unified Development Code (current supplement)";
export const SCHERTZ_UDC_CLIENT_ID = 4260;
export const SCHERTZ_UDC_LIBRARY_SLUG = "schertz";
/**
 * Top-level TOC filter: the single `SCHERTZ UNIFIED DEVELOPMENT CODE`
 * wrapper. The walker descends through it and pulls all 16 Articles.
 */
export const SCHERTZ_UDC_CHAPTER_FILTER = "^schertz unified development code";
/**
 * Municode code-product selector. Schertz's clientId 4260 carries two
 * products (Code of Ordinances + UDC); this picks the UDC.
 */
export const SCHERTZ_UDC_PRODUCT_FILTER = "unified development code";
/**
 * Municode library code-path segment for the canonical `sourceUrl`.
 */
export const SCHERTZ_UDC_LIBRARY_CODE_PATH = "unified_development_code";

interface SchertzUdcQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const SCHERTZ_UDC_DRAFTS: ReadonlyArray<SchertzUdcQueryDraft> = [
  // Article 1 — General Provisions
  { sectionNumber: "21.1.1", queryText: "21.1.1 short title" },
  { sectionNumber: "21.1.2", queryText: "21.1.2 purpose and intent" },
  { sectionNumber: "21.1.3", queryText: "21.1.3 authority" },
  { sectionNumber: "21.1.4", queryText: "21.1.4 jurisdiction" },
  { sectionNumber: "21.1.5", queryText: "21.1.5 consistency with comprehensive land plan and master thoroughfare plan" },
  // Article 5 — Zoning Districts
  { sectionNumber: "21.5.1", queryText: "21.5.1 zoning purpose and applicability" },
  { sectionNumber: "21.5.2", queryText: "21.5.2 zoning districts established" },
  { sectionNumber: "21.5.3", queryText: "21.5.3 initial zoning upon annexation" },
  { sectionNumber: "21.5.4", queryText: "21.5.4 zoning change" },
  { sectionNumber: "21.5.5", queryText: "21.5.5 statement of purpose and intent for residential districts" },
  // Article 12 — Subdivisions
  { sectionNumber: "21.12.1", queryText: "21.12.1 subdivision purpose and applicability" },
  { sectionNumber: "21.12.2", queryText: "21.12.2 subdivision general provisions" },
  { sectionNumber: "21.12.3", queryText: "21.12.3 pre-application conference" },
  { sectionNumber: "21.12.4", queryText: "21.12.4 application required" },
  { sectionNumber: "21.12.5", queryText: "21.12.5 subdivision master plan" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SCHERTZ_UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SCHERTZ_UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSchertzUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SCHERTZ_UDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `schertz-udc-${i + 1}`,
    jurisdictionTenant: SCHERTZ_UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
