/**
 * Rollingwood curated query set — Sync 5 Tier 2, Path C scope.
 *
 * Path C ingest from Municode (clientId 12936): Part II - Land
 * Development Code. Rollingwood publishes its LDC as a dedicated
 * top-level Part (the Round Rock pattern), making the chapter filter
 * clean: just the Part II heading.
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const ROLLINGWOOD_JURISDICTION = "rollingwood_tx";
export const ROLLINGWOOD_JURISDICTION_NAME = "Rollingwood, TX";
export const ROLLINGWOOD_EDITION_LABEL =
  "Rollingwood Land Development Code (current supplement)";
export const ROLLINGWOOD_CLIENT_ID = 12936;
export const ROLLINGWOOD_LIBRARY_SLUG = "rollingwood";
export const ROLLINGWOOD_CHAPTER_FILTER = "land development code";

interface RollingwoodQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const ROLLINGWOOD_DRAFTS: ReadonlyArray<RollingwoodQueryDraft> = [
  // Chapter 100 — General Administration
  { sectionNumber: "100-1", queryText: "100-1 permits projects and vested rights" },
  // Chapter 101 — Buildings and Construction
  { sectionNumber: "101-2", queryText: "101-2 adoption of building codes" },
  { sectionNumber: "101-28", queryText: "101-28 building permit fees" },
  { sectionNumber: "101-57", queryText: "101-57 demolition permit" },
  { sectionNumber: "101-131", queryText: "101-131 certificate of occupancy required" },
  // Chapter 105 — Subdivisions
  { sectionNumber: "105-25", queryText: "105-25 administrative approval of certain plats" },
  { sectionNumber: "105-26", queryText: "105-26 form and content of preliminary plat for multi-lot subdivisions" },
  { sectionNumber: "105-27", queryText: "105-27 preliminary plat for single-family residential lot building permit" },
  { sectionNumber: "105-28", queryText: "105-28 processing of preliminary plat" },
  { sectionNumber: "105-29", queryText: "105-29 final plat" },
  { sectionNumber: "105-30", queryText: "105-30 refusal of dedication" },
  { sectionNumber: "105-31", queryText: "105-31 subdivision variances" },
  { sectionNumber: "105-34", queryText: "105-34 exception from subdivision platting requirements" },
  { sectionNumber: "105-57", queryText: "105-57 access to lots" },
  { sectionNumber: "105-58", queryText: "105-58 street widths" },
  { sectionNumber: "105-60", queryText: "105-60 dead-end streets" },
  { sectionNumber: "105-63", queryText: "105-63 subdivision easements" },
  // Chapter 107 — Zoning
  { sectionNumber: "107-1", queryText: "107-1 zoning purpose" },
  { sectionNumber: "107-25", queryText: "107-25 zoning districts designated" },
  { sectionNumber: "107-26", queryText: "107-26 official zoning map" },
  { sectionNumber: "107-31", queryText: "107-31 building or structures per lot one main building" },
  { sectionNumber: "107-34", queryText: "107-34 zoning fences" },
  { sectionNumber: "107-35", queryText: "107-35 swimming pools and sport courts" },
  { sectionNumber: "107-36", queryText: "107-36 zoning driveways" },
  { sectionNumber: "107-37", queryText: "107-37 buildings or structures of special historical or architectural significance" },
  { sectionNumber: "107-38", queryText: "107-38 multilevel parking structures" },
  { sectionNumber: "107-39", queryText: "107-39 zoning lighting requirements" },
  { sectionNumber: "107-67", queryText: "107-67 zoning applicability" },
  { sectionNumber: "107-68", queryText: "107-68 zoning permitted uses restrictions on dwellings" },
  { sectionNumber: "107-69", queryText: "107-69 zoning prohibited uses" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(ROLLINGWOOD_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${ROLLINGWOOD_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildRollingwoodCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return ROLLINGWOOD_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `rollingwood-${i + 1}`,
    jurisdictionTenant: ROLLINGWOOD_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
