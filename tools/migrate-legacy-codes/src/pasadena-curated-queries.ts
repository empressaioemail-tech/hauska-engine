/**
 * Pasadena curated query set — Sync 5 Houston lane (cc-agent-E-H), Path C.
 *
 * City of Pasadena development regulations from Municode JSON API
 * (clientId 11910). Single Code of Ordinances product; dev surface is
 * flood (Ch 13½), planning (Ch 28), signs (Ch 31), buildings (Ch 9),
 * mobile homes (Ch 21), parks (Ch 24), and subdivision appendices A–C.
 *
 * Reserved-range trap: Ch 28 carries `Secs. 28-2—28-16. - Reserved.`;
 * Ch 13½ carries `Secs. 13½-1—13½-20. - Reserved.` — queries anchor on
 * substantive sections (28-1, 28-17, 13½-21), not reserved placeholders.
 *
 * Visibility: `platform-internal` per Path A (non-partnered).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const PASADENA_JURISDICTION = "pasadena_tx";
export const PASADENA_JURISDICTION_NAME = "Pasadena, TX";
export const PASADENA_EDITION_LABEL =
  "Pasadena Development Regulations (current supplement)";
export const PASADENA_CLIENT_ID = 11910;
export const PASADENA_LIBRARY_SLUG = "pasadena";
export const PASADENA_CHAPTER_FILTER =
  "^chapter (9|13½|21|24|28|31) |^appendix [abc] ";

interface PasadenaQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const PASADENA_DRAFTS: ReadonlyArray<PasadenaQueryDraft> = [
  // Chapter 28 — Planning (skip 28-2—28-16 reserved)
  { sectionNumber: "28-1", queryText: "28-1 planning department created" },
  { sectionNumber: "28-17", queryText: "28-17 director of planning appointment and term" },
  { sectionNumber: "28-30", queryText: "28-30 planning and zoning commission definitions" },
  { sectionNumber: "28-31", queryText: "28-31 planning and zoning commission created composition" },
  { sectionNumber: "28-45", queryText: "28-45 planning development fees general" },
  // Chapter 31 — Standard Sign Code
  { sectionNumber: "31-1", queryText: "31-1 standard sign code purpose" },
  { sectionNumber: "31-3", queryText: "31-3 standard sign code definitions" },
  { sectionNumber: "31-4", queryText: "31-4 sign classifications" },
  { sectionNumber: "31-5", queryText: "31-5 sign administration and enforcement" },
  // Chapter 9 — Buildings (Art. IX flood damage prevention; 13½ atomizes broken on Municode)
  { sectionNumber: "9-176", queryText: "9-176 flood damage prevention definitions" },
  { sectionNumber: "9-184", queryText: "9-184 designation of the floodplain administrator" },
  { sectionNumber: "9-185", queryText: "9-185 duties and responsibilities of the floodplain administrator" },
  // Chapter 24 — Parks
  { sectionNumber: "24-1", queryText: "24-1 parks and recreation title" },
  { sectionNumber: "24-2", queryText: "24-2 parks and recreation policy" },
  // Chapter 9 — Buildings (general)
  { sectionNumber: "9-1", queryText: "9-1 enforcement of land use restrictions" },
  { sectionNumber: "9-7", queryText: "9-7 minimum standards for off-street parking" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(PASADENA_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${PASADENA_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildPasadenaCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return PASADENA_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `pasadena-${i + 1}`,
    jurisdictionTenant: PASADENA_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
