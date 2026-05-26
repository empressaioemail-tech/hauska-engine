/**
 * El Paso Title 19 curated query set — Sync 5 lane West, per-Title slice 2/8.
 *
 * Path C ingest of Title 19 — Subdivision and Development Plats (Municode
 * clientId 2066). platform-internal per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import {
  MunicodeHtmlAdapter,
  MunicodeJsonClient,
  RespectfulFetch,
} from "@hauska-engine/corpus/adapters";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { normalizeSectionLabel, slugify, stripSectionPrefix } from "./slug.js";

export const EL_PASO_JURISDICTION = "el_paso_tx";
export const EL_PASO_JURISDICTION_NAME = "El Paso, TX";
export const EL_PASO_EDITION_LABEL =
  "El Paso CoO — Title 19 Subdivision and Development Plats (current supplement)";
export const EL_PASO_CLIENT_ID = 2066;
export const EL_PASO_LIBRARY_SLUG = "el_paso";
export const EL_PASO_TITLE_19_CHAPTER_FILTER = "^title 19 ";

interface ElPasoQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const EL_PASO_TITLE_19_DRAFTS: ReadonlyArray<ElPasoQueryDraft> = [
  { sectionNumber: "19.09.010", queryText: "19.09.010 subdivision general requirements" },
  {
    sectionNumber: "19.10.010",
    queryText:
      "19.10.010 subdivision dedication construction requirements and city participation",
  },
  {
    sectionNumber: "19.11.010",
    queryText: "19.11.010 subdivision extraterritorial jurisdiction ETJ standards",
  },
  { sectionNumber: "19.12.010", queryText: "19.12.010 subdivision water" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(EL_PASO_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${EL_PASO_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildElPasoTitle19CuratedQueries(): ReadonlyArray<CuratedQuery> {
  return EL_PASO_TITLE_19_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `el-paso-title-19-${i + 1}`,
    jurisdictionTenant: EL_PASO_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export function buildElPasoTitle19MunicodeAdapter(opts: {
  chapterFilter: RegExp;
  maxLeafFetches: number;
}): MunicodeHtmlAdapter {
  const http = new RespectfulFetch({ maxRequestsPerSecondPerHost: 0.5 });
  return new MunicodeHtmlAdapter({
    clientId: EL_PASO_CLIENT_ID,
    librarySlug: EL_PASO_LIBRARY_SLUG,
    stateAbbr: "TX",
    chapterFilter: opts.chapterFilter,
    maxLeafFetches: opts.maxLeafFetches,
    http,
    jsonClient: new MunicodeJsonClient({ http }),
  });
}
