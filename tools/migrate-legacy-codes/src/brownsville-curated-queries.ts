/**
 * Brownsville curated query set — Sync 5 TX-metros (Rio Grande
 * Valley), Path C scope.
 *
 * Reviewer-realistic queries against the City of Brownsville
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 1440). Brownsville carries a mixed-shape development
 * surface — both chapter-style Code of Ordinances chapters AND a
 * separate Unified Development Ordinance shaped as top-level ARTICLE
 * 1-5 nodes:
 *
 *   Chapter 18    Buildings and Building Regulations
 *   Chapter 46    Environment                  (incl. junked vehicles)
 *   Chapter 86    Streets, Sidewalks and Certain Other Public Places
 *   Chapter 102   Utilities
 *   Chapter 308   Flood Damage and Prevention
 *   Chapter 314   Impact Fees
 *   Chapter 328   Signs
 *   ARTICLE 1     UDO General Provisions
 *   ARTICLE 2     UDO Administration and Review Procedures
 *   ARTICLE 3     UDO Subdivision Regulations
 *   ARTICLE 4     UDO Zoning Regulations
 *   ARTICLE 5     UDO Supplemental Regulations
 *
 * Section-number conventions: chapter-hyphenated for the CoO chapters
 * (e.g. `18-116`, `308-1`), and dot-decimal for the UDO articles
 * (e.g. `1.1`, `3.4.1`, `4.3.1`). Each query leads with the
 * section-number anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const BROWNSVILLE_JURISDICTION = "brownsville_tx";
export const BROWNSVILLE_JURISDICTION_NAME = "Brownsville, TX";
export const BROWNSVILLE_EDITION_LABEL =
  "Brownsville Development Regulations (current supplement)";
export const BROWNSVILLE_CLIENT_ID = 1440;
export const BROWNSVILLE_LIBRARY_SLUG = "brownsville";
/**
 * Top-level TOC filter: seven CoO development chapters + five UDO
 * articles. Matches both shapes via alternation; case-insensitive.
 */
export const BROWNSVILLE_CHAPTER_FILTER =
  "^chapter (18|46|86|102|308|314|328) |^article [12345]\\b";

interface BrownsvilleQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const BROWNSVILLE_DRAFTS: ReadonlyArray<BrownsvilleQueryDraft> = [
  // Chapter 18 — Buildings and Building Regulations
  { sectionNumber: "18-116", queryText: "18-116 building code adopted" },
  { sectionNumber: "18-117", queryText: "18-117 building code conflicts" },
  { sectionNumber: "18-118", queryText: "18-118 building code enforcement" },
  // Chapter 308 — Flood Damage and Prevention
  { sectionNumber: "308-1", queryText: "308-1 flood damage prevention in general" },
  // Chapter 328 — Signs
  { sectionNumber: "328-1", queryText: "328-1 signs in general" },
  // UDO Article 1 — General Provisions
  { sectionNumber: "1.1", queryText: "1.1 UDO title" },
  { sectionNumber: "1.2", queryText: "1.2 UDO authority" },
  { sectionNumber: "1.3", queryText: "1.3 UDO effective date" },
  { sectionNumber: "1.4", queryText: "1.4 UDO transitional provisions" },
  { sectionNumber: "1.5", queryText: "1.5 UDO applicability" },
  // UDO Article 2 — Administration and Review Procedures
  { sectionNumber: "2.1", queryText: "2.1 UDO review and decision-making bodies" },
  { sectionNumber: "2.2", queryText: "2.2 UDO development review process" },
  { sectionNumber: "2.3", queryText: "2.3 UDO application submittal procedures" },
  { sectionNumber: "2.4", queryText: "2.4 UDO notice and public hearing requirements" },
  // UDO Article 3 — Subdivision Regulations
  { sectionNumber: "3.1", queryText: "3.1 subdivision general provisions" },
  { sectionNumber: "3.2", queryText: "3.2 subdivision plats" },
  { sectionNumber: "3.3", queryText: "3.3 construction of public improvements" },
  { sectionNumber: "3.4.1", queryText: "3.4.1 subdivision design standards lots" },
  { sectionNumber: "3.4.2", queryText: "3.4.2 subdivision design standards blocks" },
  { sectionNumber: "3.4.4", queryText: "3.4.4 subdivision design standards sidewalks" },
  { sectionNumber: "3.4.5", queryText: "3.4.5 subdivision design standards street design standards" },
  { sectionNumber: "3.5", queryText: "3.5 subdivision relief procedures" },
  // UDO Article 4 — Zoning Regulations
  { sectionNumber: "4.1", queryText: "4.1 zoning general provisions" },
  { sectionNumber: "4.2", queryText: "4.2 zoning procedures" },
  { sectionNumber: "4.3.1", queryText: "4.3.1 residential zoning districts" },
  { sectionNumber: "4.3.2", queryText: "4.3.2 nonresidential zoning districts" },
  { sectionNumber: "4.3.3", queryText: "4.3.3 traditional neighborhood and form districts" },
  { sectionNumber: "4.3.4", queryText: "4.3.4 special and overlay districts" },
  { sectionNumber: "4.4.1", queryText: "4.4.1 uses permitted by district" },
  // UDO Article 5 — Supplemental Regulations
  { sectionNumber: "5.1", queryText: "5.1 tree preservation" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(BROWNSVILLE_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${BROWNSVILLE_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildBrownsvilleCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return BROWNSVILLE_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `brownsville-${i + 1}`,
    jurisdictionTenant: BROWNSVILLE_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
