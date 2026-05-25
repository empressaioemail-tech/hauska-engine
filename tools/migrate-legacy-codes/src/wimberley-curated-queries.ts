/**
 * Wimberley curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest from Municode (clientId 16024): Chapter 9 (Planning
 * and Development Regulations) — Wimberley consolidates its land-
 * development surface under one top-level chapter, with Articles 9.02
 * (Subdivision Control), 9.03 (Zoning), 9.05 (Development Fees), etc.
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const WIMBERLEY_JURISDICTION = "wimberley_tx";
export const WIMBERLEY_JURISDICTION_NAME = "Wimberley, TX";
export const WIMBERLEY_EDITION_LABEL =
  "Wimberley Development Regulations (current supplement)";
export const WIMBERLEY_CLIENT_ID = 16024;
export const WIMBERLEY_LIBRARY_SLUG = "wimberley";
export const WIMBERLEY_CHAPTER_FILTER = "planning and development";

interface WimberleyQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const WIMBERLEY_DRAFTS: ReadonlyArray<WimberleyQueryDraft> = [
  // Article 9.01 — General Provisions
  { sectionNumber: "9.01.001", queryText: "9.01.001 comprehensive plan adopted" },
  // Article 9.02 — Subdivision Control
  { sectionNumber: "9.02.043", queryText: "9.02.043 pre-application conference" },
  { sectionNumber: "9.02.045", queryText: "9.02.045 subdivision master plan" },
  { sectionNumber: "9.02.046", queryText: "9.02.046 preliminary plat" },
  { sectionNumber: "9.02.047", queryText: "9.02.047 final plat" },
  { sectionNumber: "9.02.048", queryText: "9.02.048 minor plat" },
  { sectionNumber: "9.02.050", queryText: "9.02.050 replat" },
  { sectionNumber: "9.02.054", queryText: "9.02.054 infrastructure construction plans and completion of improvements" },
  { sectionNumber: "9.02.114", queryText: "9.02.114 thoroughfare system" },
  { sectionNumber: "9.02.115", queryText: "9.02.115 streets and alleys" },
  { sectionNumber: "9.02.121", queryText: "9.02.121 water system" },
  { sectionNumber: "9.02.122", queryText: "9.02.122 sanitary sewer system" },
  { sectionNumber: "9.02.123", queryText: "9.02.123 landscaping and buffering screening" },
  // Article 9.03 — Zoning
  { sectionNumber: "9.03.006", queryText: "9.03.006 zoning prohibited uses" },
  { sectionNumber: "9.03.041", queryText: "9.03.041 zoning district map adopted" },
  { sectionNumber: "9.03.043", queryText: "9.03.043 zoning upon annexation" },
  { sectionNumber: "9.03.070", queryText: "9.03.070 residential use prohibitions" },
  { sectionNumber: "9.03.071", queryText: "9.03.071 RA residential acreage" },
  { sectionNumber: "9.03.075", queryText: "9.03.075 R-4 single-family residential" },
  { sectionNumber: "9.03.077", queryText: "9.03.077 MF-1 multi-family residential triplex apartments" },
  { sectionNumber: "9.03.080", queryText: "9.03.080 special requirements for mobile home parks" },
  { sectionNumber: "9.03.085", queryText: "9.03.085 C-3 commercial high impact" },
  { sectionNumber: "9.03.086", queryText: "9.03.086 HC highway commercial" },
  { sectionNumber: "9.03.092", queryText: "9.03.092 IP industrial park" },
  { sectionNumber: "9.03.094", queryText: "9.03.094 PR-1 participant recreation low impact" },
  { sectionNumber: "9.03.098", queryText: "9.03.098 WPDD planned development district" },
  { sectionNumber: "9.03.101", queryText: "9.03.101 SC scenic corridor" },
  { sectionNumber: "9.03.141", queryText: "9.03.141 short-term rentals" },
  { sectionNumber: "9.03.181", queryText: "9.03.181 off-street parking and loading requirements" },
  { sectionNumber: "9.03.183", queryText: "9.03.183 development plan review" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(WIMBERLEY_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${WIMBERLEY_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildWimberleyCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return WIMBERLEY_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `wimberley-${i + 1}`,
    jurisdictionTenant: WIMBERLEY_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
