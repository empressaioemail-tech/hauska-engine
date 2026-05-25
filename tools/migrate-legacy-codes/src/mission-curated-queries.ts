/**
 * Mission curated query set — Sync 5 TX-metros (Rio Grande Valley),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Mission development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 3334). Mission publishes a single Code of Ordinances
 * product whose development surface is a set of top-level chapters
 * plus Appendix A (Zoning), scoped by chapter filter to:
 *
 *   Chapter 18    Buildings and Building Regulations
 *   Chapter 38    Flood Damage Prevention
 *   Chapter 54    Manufactured Homes, Mobile Homes, RVs and Parks
 *   Chapter 70    Parks and Recreation
 *   Chapter 74    Planning and Zoning
 *   Chapter 86    Signs
 *   Chapter 90    Solid Waste
 *   Chapter 94    Streets and Sidewalks
 *   Chapter 98    Subdivisions
 *   Chapter 114   Utilities
 *   Appendix A    Zoning   (decimal-numbered Sec. N.M)
 *
 * Section-number conventions: chapter-hyphenated for the CoO chapters
 * (e.g. `98-1`, `38-1`), and dot-decimal for Appendix A Zoning
 * (e.g. `1.1`, `1.2`). Each query leads with the section-number
 * anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const MISSION_JURISDICTION = "mission_tx";
export const MISSION_JURISDICTION_NAME = "Mission, TX";
export const MISSION_EDITION_LABEL =
  "Mission Development Regulations (current supplement)";
export const MISSION_CLIENT_ID = 3334;
export const MISSION_LIBRARY_SLUG = "mission";
export const MISSION_CHAPTER_FILTER =
  "^chapter (18|38|54|70|74|86|90|94|98|114) |^appendix a ";

interface MissionQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const MISSION_DRAFTS: ReadonlyArray<MissionQueryDraft> = [
  // Chapter 18 — Buildings
  { sectionNumber: "18-1", queryText: "18-1 building fire limits" },
  { sectionNumber: "18-2", queryText: "18-2 asbestos survey required prior to issuance of permit for renovation or demolition" },
  // Chapter 38 — Flood Damage Prevention
  { sectionNumber: "38-1", queryText: "38-1 flood damage prevention statutory authorization" },
  { sectionNumber: "38-2", queryText: "38-2 flood damage prevention findings of fact" },
  { sectionNumber: "38-3", queryText: "38-3 flood damage prevention statement of purpose" },
  { sectionNumber: "38-4", queryText: "38-4 flood damage methods of reducing flood losses" },
  // Chapter 54 — Manufactured Homes
  { sectionNumber: "54-1", queryText: "54-1 manufactured homes authority" },
  { sectionNumber: "54-2", queryText: "54-2 manufactured homes purpose of chapter" },
  { sectionNumber: "54-3", queryText: "54-3 manufactured homes definitions" },
  { sectionNumber: "54-4", queryText: "54-4 manufactured homes permitted placement outside of park" },
  // Chapter 70 — Parks and Recreation
  { sectionNumber: "70-1", queryText: "70-1 parks policy plan for development" },
  // Chapter 74 — Planning and Zoning (procedures)
  { sectionNumber: "74-1", queryText: "74-1 fees for zoning requests and conditional use permits" },
  // Chapter 86 — Signs
  { sectionNumber: "86-1", queryText: "86-1 sign definition" },
  { sectionNumber: "86-2", queryText: "86-2 sign general definitions" },
  { sectionNumber: "86-3", queryText: "86-3 signs purpose of chapter" },
  { sectionNumber: "86-4", queryText: "86-4 signs objectives of chapter" },
  // Chapter 94 — Streets and Sidewalks
  { sectionNumber: "94-1", queryText: "94-1 obstruction of sidewalks" },
  { sectionNumber: "94-3", queryText: "94-3 obstruction closing up or filling of drainageway" },
  // Chapter 98 — Subdivisions
  { sectionNumber: "98-1", queryText: "98-1 subdivision definitions" },
  { sectionNumber: "98-2", queryText: "98-2 subdivision general authority" },
  { sectionNumber: "98-3", queryText: "98-3 subdivision extraterritorial jurisdiction" },
  { sectionNumber: "98-4", queryText: "98-4 subdivision purpose of chapter" },
  // Chapter 114 — Utilities
  { sectionNumber: "114-1", queryText: "114-1 utilities definitions" },
  { sectionNumber: "114-2", queryText: "114-2 utilities scope of chapter provisions" },
  { sectionNumber: "114-3", queryText: "114-3 utilities service to comply with technical provisions" },
  // Appendix A — Zoning
  { sectionNumber: "1.1", queryText: "1.1 zoning short title" },
  { sectionNumber: "1.2", queryText: "1.2 zoning definitions" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(MISSION_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${MISSION_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildMissionCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return MISSION_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `mission-${i + 1}`,
    jurisdictionTenant: MISSION_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
