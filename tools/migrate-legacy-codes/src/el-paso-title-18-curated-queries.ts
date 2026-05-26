/**
 * El Paso Title 18 curated query set — Sync 5 lane West, per-Title slice 1/8.
 *
 * Path C ingest of Title 18 — Building and Construction from the City of
 * El Paso Code of Ordinances (Municode clientId 2066). Decimal section
 * numbers (`18.08.010`, `18.10.010`, …). Tagged platform-internal per
 * Path A.
 *
 * Slice policy (cc-agent-E-W 2026-05-26): one PR per Title; do not run
 * full CoO or multi-Title jobs in a single ingest.
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
  "El Paso CoO — Title 18 Building and Construction (current supplement)";
export const EL_PASO_CLIENT_ID = 2066;
export const EL_PASO_LIBRARY_SLUG = "el_paso";
/** Title 18 only — Building and Construction (IBC/IRC/IMC/IECC/IFGC adoption). */
export const EL_PASO_TITLE_18_CHAPTER_FILTER = "^title 18 ";

interface ElPasoQueryDraft {
  sectionNumber: string;
  queryText: string;
}

const EL_PASO_TITLE_18_DRAFTS: ReadonlyArray<ElPasoQueryDraft> = [
  { sectionNumber: "18.08.010", queryText: "18.08.010 building code short title" },
  { sectionNumber: "18.08.020", queryText: "18.08.020 building code adoption" },
  { sectionNumber: "18.10.010", queryText: "18.10.010 residential code" },
  { sectionNumber: "18.12.010", queryText: "18.12.010 mechanical code" },
  { sectionNumber: "18.16.010", queryText: "18.16.010 electrical code" },
  { sectionNumber: "18.18.010", queryText: "18.18.010 outdoor lighting code" },
  { sectionNumber: "18.20.010", queryText: "18.20.010 plumbing code" },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(EL_PASO_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${EL_PASO_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildElPasoTitle18CuratedQueries(): ReadonlyArray<CuratedQuery> {
  return EL_PASO_TITLE_18_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `el-paso-title-18-${i + 1}`,
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

/** Municode adapter at 0.5 req/sec per lane orchestration rules. */
export function buildElPasoTitle18MunicodeAdapter(opts: {
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
