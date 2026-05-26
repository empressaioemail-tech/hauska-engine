/**
 * Sugar Land LDC curated query set — Sync 5 Houston lane (cc-agent-E-H).
 *
 * City of Sugar Land Land Development Code via Municode JSON API
 * (clientId 4527, product "Land Development Code"). Separate product from
 * the thin Code of Ordinances on the same clientId.
 *
 * Reserved-range trap: Ch 2 carries `Secs. 2-14—2-18. - Reserved.` and
 * similar ranges — walk children before anchoring queries.
 *
 * Visibility: `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const SUGAR_LAND_LDC_JURISDICTION = "sugar_land_tx";
export const SUGAR_LAND_LDC_JURISDICTION_NAME = "Sugar Land, TX";
export const SUGAR_LAND_LDC_EDITION_LABEL =
  "Sugar Land Land Development Code (current supplement)";
export const SUGAR_LAND_LDC_CLIENT_ID = 4527;
export const SUGAR_LAND_LDC_LIBRARY_SLUG = "sugar_land";
export const SUGAR_LAND_LDC_CHAPTER_FILTER = "^chapter\\s+\\d+";
export const SUGAR_LAND_LDC_PRODUCT_FILTER = "land development code";
export const SUGAR_LAND_LDC_LIBRARY_CODE_PATH = "land_development_code";

interface SugarLandLdcQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const SUGAR_LAND_LDC_DRAFTS: ReadonlyArray<SugarLandLdcQueryDraft> = [
  // Chapter 2 — Zoning (skip 2-14—2-18 reserved)
  { sectionNumber: "2-1", queryText: "2-1 zoning short title" },
  { sectionNumber: "2-2", queryText: "2-2 zoning application and exceptions" },
  { sectionNumber: "2-3", queryText: "2-3 comprehensive plan" },
  { sectionNumber: "2-11", queryText: "2-11 annexation and permanent zoning" },
  { sectionNumber: "2-12", queryText: "2-12 rezoning" },
  { sectionNumber: "2-51", queryText: "2-51 establishment of zoning districts" },
  { sectionNumber: "2-52", queryText: "2-52 official zoning map" },
  { sectionNumber: "2-54", queryText: "2-54 use of land and buildings" },
  // Chapter 4 — Signs
  { sectionNumber: "4-1", queryText: "4-1 sign regulations purpose" },
  { sectionNumber: "4-2", queryText: "4-2 sign regulations definitions" },
  { sectionNumber: "4-3", queryText: "4-3 sign permit required" },
  // Chapter 5 — Subdivision
  { sectionNumber: "5-1", queryText: "5-1 subdivision regulations title" },
  { sectionNumber: "5-2", queryText: "5-2 subdivision regulations purpose" },
  { sectionNumber: "5-3", queryText: "5-3 subdivision plat required" },
  // Chapter 8 — Flood
  { sectionNumber: "8-1", queryText: "8-1 flood damage reduction statutory authorization" },
  { sectionNumber: "8-2", queryText: "8-2 flood damage reduction findings of fact" },
  { sectionNumber: "8-3", queryText: "8-3 flood damage reduction statement of purpose" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SUGAR_LAND_LDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SUGAR_LAND_LDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSugarLandLdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SUGAR_LAND_LDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `sugar-land-ldc-${i + 1}`,
    jurisdictionTenant: SUGAR_LAND_LDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
