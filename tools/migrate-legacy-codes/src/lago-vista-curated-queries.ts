/**
 * Lago Vista curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest from Municode (clientId 2904): Chapter 3.5 (Site
 * Development), Chapter 5 (Signs), Chapter 10 (Subdivision Regulation
 * — exhibit-ordinance pattern), Chapter 14 (Zoning — exhibit-ordinance
 * pattern), Chapter 15 (Growth Management and Infrastructure
 * Coordination). PR #22 bare-numbered-section disambiguation handles
 * any collisions across the Ch 10 / Ch 14 exhibits.
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const LAGO_VISTA_JURISDICTION = "lago_vista_tx";
export const LAGO_VISTA_JURISDICTION_NAME = "Lago Vista, TX";
export const LAGO_VISTA_EDITION_LABEL =
  "Lago Vista Development Regulations (current supplement)";
export const LAGO_VISTA_CLIENT_ID = 2904;
export const LAGO_VISTA_LIBRARY_SLUG = "lago_vista";
export const LAGO_VISTA_CHAPTER_FILTER =
  "site development|signs|subdivision|zoning|growth management";

interface LagoVistaQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const LAGO_VISTA_DRAFTS: ReadonlyArray<LagoVistaQueryDraft> = [
  // Chapter 3.5 — Site Development
  { sectionNumber: "3.5.101", queryText: "3.5.101 site development definitions" },
  { sectionNumber: "3.5.102", queryText: "3.5.102 site development plan required" },
  { sectionNumber: "3.5.104", queryText: "3.5.104 site development format and content" },
  { sectionNumber: "3.5.107", queryText: "3.5.107 site development enforcement provisions" },
  // Chapter 5 — Signs
  { sectionNumber: "5.100", queryText: "5.100 sign regulations purpose" },
  { sectionNumber: "5.102", queryText: "5.102 wayfinding signs" },
  { sectionNumber: "5.105", queryText: "5.105 sign prohibitions" },
  { sectionNumber: "5.107", queryText: "5.107 on-premises and off-premises signs" },
  { sectionNumber: "5.108", queryText: "5.108 sign design requirements" },
  { sectionNumber: "5.110", queryText: "5.110 master sign program" },
  { sectionNumber: "5.114", queryText: "5.114 sign enforcement" },
  { sectionNumber: "5.116", queryText: "5.116 sign violations and penalties" },
  // Chapter 10 — Subdivision Regulation (exhibit ordinances)
  { sectionNumber: "10.100", queryText: "10.100 subdivision ordinance adopted" },
  { sectionNumber: "10-20", queryText: "10-20 subdivision procedural requirements" },
  { sectionNumber: "10-50", queryText: "10-50 consideration of the detail plan" },
  { sectionNumber: "10-70", queryText: "10-70 detail plan expiration" },
  { sectionNumber: "10-80", queryText: "10-80 approval of districts" },
  // Chapter 14 — Zoning (exhibit ordinances)
  { sectionNumber: "14.100", queryText: "14.100 zoning general provisions" },
  { sectionNumber: "14.200", queryText: "14.200 zoning ordinance" },
  { sectionNumber: "14-10", queryText: "14-10 zoning rollback" },
  // Chapter 15 — Growth Management and Infrastructure Coordination
  { sectionNumber: "15.1", queryText: "15.1 growth management purpose and applicability" },
  { sectionNumber: "15.2", queryText: "15.2 dormant zoning entitlements" },
  { sectionNumber: "15.3", queryText: "15.3 growth management required submittals" },
  { sectionNumber: "15.4", queryText: "15.4 infrastructure capacity evaluation" },
  { sectionNumber: "15.5", queryText: "15.5 traffic impact evaluation" },
  { sectionNumber: "15.6", queryText: "15.6 growth management waivers" },
  { sectionNumber: "15.8", queryText: "15.8 growth management severability" },
  { sectionNumber: "15-10", queryText: "15-10 denial of similar applications and withdrawals" },
  { sectionNumber: "15-20", queryText: "15-20 growth management fees" },
  { sectionNumber: "15-30", queryText: "15-30 conflict with other ordinances" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(LAGO_VISTA_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${LAGO_VISTA_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildLagoVistaCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return LAGO_VISTA_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `lago-vista-${i + 1}`,
    jurisdictionTenant: LAGO_VISTA_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
