/**
 * New Braunfels curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Reviewer-realistic queries against the City of New Braunfels
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 3504). New Braunfels publishes a single Code of
 * Ordinances product; its land-development surface is a set of
 * top-level chapters within it — the Bastrop / Elgin / Round Rock Path
 * C shape, scoped by chapter filter to:
 *
 *   Chapter 38   Community Development
 *   Chapter 98   Planning
 *   Chapter 106  Signs
 *   Chapter 118  Subdivision Platting
 *   Chapter 144  Zoning
 *
 * This is the Layer 3 bespoke local code. Each query leads with the
 * section-number anchor so the storage scoring layer's section-number
 * boost fires cleanly; topic terms after the anchor disambiguate
 * against neighbour sections.
 *
 * Visibility: New Braunfels is non-partnered, so the
 * jurisdiction-corpus is tagged `platform-internal` per Path A.
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const NEW_BRAUNFELS_JURISDICTION = "new_braunfels_tx";
export const NEW_BRAUNFELS_JURISDICTION_NAME = "New Braunfels, TX";
export const NEW_BRAUNFELS_EDITION_LABEL =
  "New Braunfels Development Regulations (current supplement)";
export const NEW_BRAUNFELS_CLIENT_ID = 3504;
export const NEW_BRAUNFELS_LIBRARY_SLUG = "new_braunfels";
/**
 * Top-level TOC filter: the five land-development chapters. Each term
 * matches exactly one top-level `Chapter N - TITLE` heading and nothing
 * else in the 49-node Code of Ordinances TOC.
 */
export const NEW_BRAUNFELS_CHAPTER_FILTER =
  "community development|planning|signs|subdivision|zoning";

interface NewBraunfelsQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const NEW_BRAUNFELS_DRAFTS: ReadonlyArray<NewBraunfelsQueryDraft> = [
  // Chapter 38 — Community Development
  { sectionNumber: "38-26", queryText: "38-26 community development advisory committee created" },
  { sectionNumber: "38-51", queryText: "38-51 downtown board creation composition" },
  // Chapter 98 — Planning
  { sectionNumber: "98-26", queryText: "98-26 planning and zoning commission changed to planning commission" },
  { sectionNumber: "98-56", queryText: "98-56 zoning board of adjustment created organization" },
  // Chapter 106 — Signs
  { sectionNumber: "106-1", queryText: "106-1 sign regulations authority" },
  { sectionNumber: "106-11", queryText: "106-11 prohibited signs" },
  { sectionNumber: "106-12", queryText: "106-12 sign lighting standards" },
  { sectionNumber: "106-13", queryText: "106-13 off-premises sign regulations" },
  { sectionNumber: "106-15", queryText: "106-15 principles of sign area computation" },
  // Chapter 118 — Subdivision Platting
  { sectionNumber: "118-3", queryText: "118-3 authority of the city extension to extraterritorial jurisdiction" },
  { sectionNumber: "118-7", queryText: "118-7 Edwards recharge zone subdivision" },
  { sectionNumber: "118-22", queryText: "118-22 subdivision master plan" },
  { sectionNumber: "118-23", queryText: "118-23 preliminary plat optional" },
  { sectionNumber: "118-27", queryText: "118-27 final plat" },
  { sectionNumber: "118-37", queryText: "118-37 development plats" },
  { sectionNumber: "118-42", queryText: "118-42 planned developments PD" },
  { sectionNumber: "118-46", queryText: "118-46 subdivision streets design standards" },
  { sectionNumber: "118-49", queryText: "118-49 subdivision sidewalks" },
  { sectionNumber: "118-63", queryText: "118-63 fee in lieu of park land" },
  // Chapter 144 — Zoning
  { sectionNumber: "144-1.1", queryText: "144-1.1 zoning purpose" },
  { sectionNumber: "144-1.4", queryText: "144-1.4 zoning definitions" },
  { sectionNumber: "144-2.2", queryText: "144-2.2 zoning board of adjustment BOA" },
  { sectionNumber: "144-2.3", queryText: "144-2.3 nonconforming uses and structures" },
  { sectionNumber: "144-3.5", queryText: "144-3.5 planned development districts" },
  { sectionNumber: "144-3.6", queryText: "144-3.6 special use permits" },
  { sectionNumber: "144-3.7", queryText: "144-3.7 overlay zoning districts" },
  { sectionNumber: "144-4.2", queryText: "144-4.2 zoning land use matrix" },
  { sectionNumber: "144-5.1", queryText: "144-5.1 parking loading stacking vehicular circulation" },
  { sectionNumber: "144-5.3", queryText: "144-5.3 landscaping tree preservation screening fences" },
  { sectionNumber: "144-5.5", queryText: "144-5.5 home occupation regulations" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(NEW_BRAUNFELS_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${NEW_BRAUNFELS_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildNewBraunfelsCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return NEW_BRAUNFELS_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `new-braunfels-${i + 1}`,
    jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
