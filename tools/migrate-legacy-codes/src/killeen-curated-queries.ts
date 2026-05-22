/**
 * Killeen curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Reviewer-realistic queries against the City of Killeen development
 * regulations, ingested via Path C from the Municode JSON API
 * (clientId 2843). Killeen publishes a single Code of Ordinances
 * product; its land-development surface is a set of top-level chapters
 * within it — the Round Rock / New Braunfels Path C shape, scoped by
 * chapter filter to:
 *
 *   Chapter 21   Planning and Development
 *   Chapter 26   Subdivisions and Other Property Developments
 *   Chapter 31   Zoning   (includes Killeen Municipal Airport Zoning)
 *   Chapter 33   Impact Fees
 *
 * This is the Layer 3 bespoke local code. Each query leads with the
 * section-number anchor so the storage scoring layer's section-number
 * boost fires cleanly; topic terms after the anchor disambiguate
 * against neighbour sections.
 *
 * Visibility: Killeen is non-partnered, so the jurisdiction-corpus is
 * tagged `platform-internal` per Path A. Authorship `llm-generated`,
 * status `draft` until reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const KILLEEN_JURISDICTION = "killeen_tx";
export const KILLEEN_JURISDICTION_NAME = "Killeen, TX";
export const KILLEEN_EDITION_LABEL =
  "Killeen Development Regulations (current supplement)";
export const KILLEEN_CLIENT_ID = 2843;
export const KILLEEN_LIBRARY_SLUG = "killeen";
/**
 * Top-level TOC filter: the four land-development chapters. Each term
 * matches exactly one top-level `Chapter N - TITLE` heading in the
 * 39-node Code of Ordinances TOC and nothing else.
 */
export const KILLEEN_CHAPTER_FILTER =
  "planning and development|subdivision|zoning|impact fees";

interface KilleenQueryDraft {
  /** Section-number label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const KILLEEN_DRAFTS: ReadonlyArray<KilleenQueryDraft> = [
  // Chapter 21 — Planning and Development
  { sectionNumber: "21-1", queryText: "21-1 building permit certificate of occupancy issuance" },
  { sectionNumber: "21-26", queryText: "21-26 planning and zoning commission composition" },
  // Chapter 26 — Subdivisions and Other Property Developments
  { sectionNumber: "26-3", queryText: "26-3 subdivision purpose" },
  { sectionNumber: "26-9", queryText: "26-9 development plat required" },
  { sectionNumber: "26-25", queryText: "26-25 subdivision variances" },
  { sectionNumber: "26-41", queryText: "26-41 preliminary plat form contents required documentation" },
  { sectionNumber: "26-51", queryText: "26-51 final plat form contents required documentation" },
  { sectionNumber: "26-71", queryText: "26-71 vacation of plats" },
  { sectionNumber: "26-80", queryText: "26-80 land disturbance permit required" },
  { sectionNumber: "26-86", queryText: "26-86 homeowners association required" },
  { sectionNumber: "26-101", queryText: "26-101 subdivision streets" },
  { sectionNumber: "26-128", queryText: "26-128 parkland purpose intent and authority" },
  // Chapter 31 — Zoning
  { sectionNumber: "31-1", queryText: "31-1 zoning short title" },
  { sectionNumber: "31-7", queryText: "31-7 zoning violation and penalties" },
  { sectionNumber: "31-66", queryText: "31-66 board of adjustment established" },
  { sectionNumber: "31-77", queryText: "31-77 zoning special exceptions" },
  { sectionNumber: "31-78", queryText: "31-78 zoning variances" },
  { sectionNumber: "31-79", queryText: "31-79 administrative approval of minor encroachments" },
  { sectionNumber: "31-82", queryText: "31-82 aviation board of adjustment" },
  { sectionNumber: "31-121", queryText: "31-121 establishment of zoning districts and boundaries" },
  { sectionNumber: "31-122", queryText: "31-122 official zoning map" },
  { sectionNumber: "31-156", queryText: "31-156 district A agricultural use regulations" },
  { sectionNumber: "31-171", queryText: "31-171 A-R1 district purpose" },
  { sectionNumber: "31-186", queryText: "31-186 district R-1 single-family residential use regulations" },
  { sectionNumber: "31-216", queryText: "31-216 RT-1 district purpose" },
  { sectionNumber: "31-246", queryText: "31-246 district R-3 multifamily residential use regulations" },
  // Chapter 33 — Impact Fees
  { sectionNumber: "33-21", queryText: "33-21 water and wastewater impact fees purpose" },
  { sectionNumber: "33-24", queryText: "33-24 impact fees per service unit" },
  { sectionNumber: "33-41", queryText: "33-41 establishment of impact fee accounts" },
  { sectionNumber: "33-51", queryText: "33-51 offsets and credits against impact fees" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(KILLEEN_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${KILLEEN_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildKilleenCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return KILLEEN_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `killeen-${i + 1}`,
    jurisdictionTenant: KILLEEN_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
