/**
 * San Antonio UDC curated query set — Sync 5 TX-metros (San Antonio
 * core), Path C scope.
 *
 * Reviewer-realistic queries against the City of San Antonio Unified
 * Development Code, ingested via Path C from the Municode JSON API.
 * San Antonio publishes its UDC as a SEPARATE Municode product
 * (productId 14228, "Unified Development Code", distinct from the
 * Code of Ordinances at productId 11508 carried under the same
 * clientId 11525). The `productNameFilter` adapter option (added with
 * PR #27 for Georgetown, exercised by PR #30 for Austin LDC) selects
 * it.
 *
 * Scope: the nine substantive Articles plus the substantive Appendices
 * of the UDC:
 *
 *   Article I    Purpose and Scope                  (Sec. 35-101–)
 *   Article II   Use Patterns                       (Sec. 35-201–)
 *   Article III  Zoning                             (Sec. 35-301–,
 *                                                    incl. 35-310.NN
 *                                                    base district set)
 *   Article IV   Procedures                         (Sec. 35-401–)
 *   Article V    Development Standards              (Sec. 35-501–)
 *   Article VI   Historic Preservation and          (Sec. 35-601–)
 *                Urban Design
 *   Article VII  Vested Rights and Nonconforming    (Sec. 35-701–)
 *                Uses
 *   Article VIII Administrative Agencies            (Sec. 35-801–)
 *   Article IX   Extraterritorial Jurisdiction      (Sec. 35-901–)
 *                Military Protection Areas
 *   Appendix A   Definitions and Rules of Interpretation
 *   Appendix B   Application Submittal
 *   Appendix C   Fee Schedule
 *   Appendix D   Zoning District Conversion Matrix
 *   Appendix F   Floodplains
 *   Appendix G   Design Standards
 *   Appendix H   Storm Water Design Criteria Manual
 *
 * Front matter ("CODE OF ORDINANCES..." and "JANUARY 1, 2006 UNIFIED
 * DEVELOPMENT CODE..." landing nodes), the supplement history table,
 * disposition / derivation / table-of-sections-affected / code
 * comparative tables are excluded by the chapter filter. Appendix E
 * (the recommended plant list — a leaf-only reference table) is
 * included by the filter but the walker emits no per-section atoms
 * for it.
 *
 * Section-number convention: chapter-hyphenated decimal, with the
 * stable `35-` prefix carried from Chapter 35 of the Code of
 * Ordinances. Each query leads with the section-number anchor so the
 * storage scoring layer's section-number boost fires cleanly; topic
 * terms after the anchor disambiguate.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SAN_ANTONIO_UDC_JURISDICTION = "san_antonio_tx";
export const SAN_ANTONIO_UDC_JURISDICTION_NAME = "San Antonio, TX";
export const SAN_ANTONIO_UDC_EDITION_LABEL =
  "San Antonio Unified Development Code (current supplement)";
export const SAN_ANTONIO_UDC_CLIENT_ID = 11525;
export const SAN_ANTONIO_UDC_LIBRARY_SLUG = "san_antonio";
/**
 * Top-level TOC filter: nine substantive Articles + substantive
 * Appendices. Matches "ARTICLE I - PURPOSE AND SCOPE" … "ARTICLE IX -
 * EXTRATERRITORIAL …" and "APPENDIX A - DEFINITIONS …" … "APPENDIX H -
 * STORM WATER …". Excludes the leading "CODE OF ORDINANCES …" and
 * "JANUARY 1, 2006 UNIFIED DEVELOPMENT CODE …" landing nodes, the
 * supplement history table, the disposition / derivation / sections-
 * affected / code-comparative tables. APPENDIX E (a leaf-only plant
 * list) is included by the filter but emits no section atoms.
 */
export const SAN_ANTONIO_UDC_CHAPTER_FILTER = "^article |^appendix ";
/**
 * Municode code-product selector. San Antonio's clientId 11525 carries
 * two products (Code of Ordinances + UDC); this picks the UDC.
 */
export const SAN_ANTONIO_UDC_PRODUCT_FILTER = "unified development code";
/**
 * Municode library code-path segment for the canonical `sourceUrl`.
 * San Antonio's UDC is hosted at
 * `library.municode.com/tx/san_antonio/codes/unified_development_code`.
 */
export const SAN_ANTONIO_UDC_LIBRARY_CODE_PATH = "unified_development_code";

interface SanAntonioUdcQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const SAN_ANTONIO_UDC_DRAFTS: ReadonlyArray<SanAntonioUdcQueryDraft> = [
  // Article I — Purpose and Scope
  { sectionNumber: "35-101", queryText: "35-101 unified development code title" },
  { sectionNumber: "35-102", queryText: "35-102 general purpose and intent" },
  { sectionNumber: "35-103", queryText: "35-103 authority" },
  // Article II — Use Patterns
  { sectionNumber: "35-201", queryText: "35-201 use patterns generally" },
  { sectionNumber: "35-202", queryText: "35-202 conventional and enclave subdivision" },
  { sectionNumber: "35-203", queryText: "35-203 conservation subdivision" },
  // Article III — Zoning
  { sectionNumber: "35-301", queryText: "35-301 zoning purpose" },
  { sectionNumber: "35-302", queryText: "35-302 zoning general requirements" },
  { sectionNumber: "35-303", queryText: "35-303 establishment of districts" },
  { sectionNumber: "35-304", queryText: "35-304 official zoning map" },
  { sectionNumber: "35-305", queryText: "35-305 zoning district boundaries" },
  { sectionNumber: "35-310", queryText: "35-310 zoning district purpose statements and design regulations" },
  { sectionNumber: "35-330", queryText: "35-330 overlay districts generally" },
  { sectionNumber: "35-332", queryText: "35-332 ERZD Edwards Recharge Zone District" },
  { sectionNumber: "35-370", queryText: "35-370 accessory use and structure regulations" },
  { sectionNumber: "35-371", queryText: "35-371 accessory dwellings" },
  // Article IV — Procedures
  { sectionNumber: "35-420", queryText: "35-420 comprehensive planning program" },
  { sectionNumber: "35-421", queryText: "35-421 zoning amendments" },
  { sectionNumber: "35-422", queryText: "35-422 conditional zoning" },
  { sectionNumber: "35-423", queryText: "35-423 specific use authorization" },
  // Article V — Development Standards
  { sectionNumber: "35-502", queryText: "35-502 traffic impact analysis and roughly proportionate determination study" },
  { sectionNumber: "35-503", queryText: "35-503 parkland dedication requirement" },
  { sectionNumber: "35-504", queryText: "35-504 solid waste" },
  { sectionNumber: "35-506", queryText: "35-506 transportation and street design" },
  { sectionNumber: "35-507", queryText: "35-507 utilities" },
  // Article VII — Vested Rights and Nonconforming Uses
  { sectionNumber: "35-711", queryText: "35-711 recognition of rights derived from common law" },
  { sectionNumber: "35-712", queryText: "35-712 recognition of rights derived from Texas Local Government Code Chapter 245" },
  { sectionNumber: "35-714", queryText: "35-714 dormant projects" },
  // Article VIII — Administrative Agencies
  { sectionNumber: "35-801", queryText: "35-801 board of adjustment" },
  { sectionNumber: "35-803", queryText: "35-803 historic and design review commission" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SAN_ANTONIO_UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SAN_ANTONIO_UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSanAntonioUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SAN_ANTONIO_UDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `san-antonio-udc-${i + 1}`,
    jurisdictionTenant: SAN_ANTONIO_UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
