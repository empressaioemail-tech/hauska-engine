/**
 * Watauga curated query set — Sync 5 lane North (Fort Worth metro),
 * Path C scope.
 *
 * Reviewer-realistic queries against the City of Watauga land
 * development regulations, ingested via Path C from the Municode JSON
 * API (clientId 4818). Watauga publishes its development surface at
 * the top level as `Subpart B - LAND DEVELOPMENT`, with eight
 * chapters (101-115) nested inside. The chapter filter targets the
 * Subpart B wrapper; the walker descends through it. Non-development
 * content lives at PART I Charter + Chapter 1-42 + Telecommunications;
 * none match the filter.
 *
 *   Chapter 101   General and Administrative Provisions
 *   Chapter 103   Buildings and Building Regulations
 *   Chapter 105   Environmental Protection
 *   Chapter 107   Flood Damage Prevention
 *   Chapter 109   Manufactured Housing and Mobile Home Parks
 *   Chapter 111   Signs
 *   Chapter 113   Subdivisions
 *   Chapter 115   Zoning
 *
 * Section-number convention: chapter-hyphenated `<chapter>-<section>`
 * (`101-1`, `107-1`, `115-1`). Each query leads with the
 * section-number anchor.
 *
 * Visibility: tagged `platform-internal` per Path A (non-partnered).
 * Authorship `llm-generated`, status `draft` until reviewer-zero
 * curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const WATAUGA_JURISDICTION = "watauga_tx";
export const WATAUGA_JURISDICTION_NAME = "Watauga, TX";
export const WATAUGA_EDITION_LABEL =
  "Watauga Land Development Regulations (current supplement)";
export const WATAUGA_CLIENT_ID = 4818;
export const WATAUGA_LIBRARY_SLUG = "watauga";
/**
 * Top-level TOC filter: the Subpart B - LAND DEVELOPMENT wrapper.
 * The walker descends through it and pulls all eight chapters
 * (101-115).
 */
export const WATAUGA_CHAPTER_FILTER = "^subpart b ";

interface WataugaQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const WATAUGA_DRAFTS: ReadonlyArray<WataugaQueryDraft> = [
  // Chapter 101 — General and Administrative Provisions
  { sectionNumber: "101-1", queryText: "101-1 applicability of land development chapter" },
  { sectionNumber: "101-2", queryText: "101-2 land development chapter status" },
  // Chapter 107 — Flood Damage Prevention
  { sectionNumber: "107-1", queryText: "107-1 flood damage prevention definitions" },
  { sectionNumber: "107-2", queryText: "107-2 flood damage prevention penalty" },
  { sectionNumber: "107-3", queryText: "107-3 flood damage prevention statutory authorization" },
  // Chapter 111 — Signs
  { sectionNumber: "111-1", queryText: "111-1 sign definitions" },
  { sectionNumber: "111-2", queryText: "111-2 sign purpose and clarification" },
  // Chapter 113 — Subdivisions
  { sectionNumber: "113-1", queryText: "113-1 subdivision authorization" },
  { sectionNumber: "113-2", queryText: "113-2 subdivision procedure and fees" },
  { sectionNumber: "113-3", queryText: "113-3 general requirements for land subdivision" },
  // Chapter 115 — Zoning
  { sectionNumber: "115-1", queryText: "115-1 zoning title of chapter" },
  { sectionNumber: "115-2", queryText: "115-2 zoning definitions" },
  { sectionNumber: "115-3", queryText: "115-3 zoning general definitions" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(WATAUGA_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${WATAUGA_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildWataugaCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return WATAUGA_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `watauga-${i + 1}`,
    jurisdictionTenant: WATAUGA_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
