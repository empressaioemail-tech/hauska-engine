/**
 * Seed curated query sets per the 2026-05-19 dispatch:
 *
 *   - Bastrop UDC queries: full Bastrop Code of Ordinances scope.
 *   - Grand County queries: IWUIC + R301 scope only (no full-IRC).
 *
 * These are placeholder reviewer-zero-shape queries. The
 * authorshipSource is `llm-generated` and `status` is `draft` —
 * production curated-query authoring per Phase 0 runs Sylvia/Jaime
 * (Bastrop) and a Grand County reviewer-zero through the
 * curated-queries port (packages/corpus/src/curated-queries/).
 *
 * The queries target deterministic atom DIDs computable from the
 * `(jurisdiction, editionSlug, sectionNumber)` tuple — they will
 * resolve against the migrated corpus if the corresponding section
 * exists, and fail otherwise (which is the desired signal).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import { buildEditionSlug, normalizeSectionLabel, slugify } from "./slug.js";

function sectionEntityId(
  jurisdictionKey: string,
  codeBook: string,
  edition: string,
  sectionNumber: string,
): string {
  const editionSlug = buildEditionSlug(codeBook, edition);
  return `${jurisdictionKey}/${editionSlug}/${slugify(normalizeSectionLabel(sectionNumber))}`;
}

function expectedDid(
  jurisdictionKey: string,
  codeBook: string,
  edition: string,
  sectionNumber: string,
): string {
  const localId = sectionEntityId(
    jurisdictionKey,
    codeBook,
    edition,
    sectionNumber,
  );
  return buildAtomDid("code-section", localId).raw;
}

interface SeedQueryDraft {
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sectionNumber: string;
  queryText: string;
  /** Optional override; queryType defaults to "retrieval". */
  queryType?: "retrieval" | "coverage" | "cross-ref";
}

const BASTROP_DRAFTS: ReadonlyArray<SeedQueryDraft> = [
  // Bastrop Code of Ordinances — broad scope per the dispatch.
  // Section numbers target chapters likely present in the warmed
  // Municode corpus (first 30 TOC nodes per maxTocNodes config).
  // Section IDs are best-effort against Bastrop's typical Code of
  // Ordinances ordering; production curated authoring refines them.
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 1",
    queryText: "general provisions Bastrop",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 2",
    queryText: "administration officers Bastrop",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 14",
    queryText: "zoning Bastrop unified development",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 10",
    queryText: "subdivision regulations Bastrop",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 6",
    queryText: "building permit requirements Bastrop",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 8",
    queryText: "fire prevention code Bastrop",
  },
  {
    jurisdictionKey: "bastrop_tx",
    codeBook: "MUNI_CODE",
    edition: "Code of Ordinances (current supplement)",
    sectionNumber: "Chapter 12",
    queryText: "signs sign regulations Bastrop",
  },
];

const GRAND_COUNTY_DRAFTS: ReadonlyArray<SeedQueryDraft> = [
  // R301.2(1) climatic table is one atom; one targeted query.
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IRC_R301_2_1",
    edition: "IRC 2021",
    sectionNumber: "R301.2(1)",
    queryText: "climatic geographic design criteria Grand County",
  },
  // IWUIC chapters that the recon doc surfaced (Chapter 5, Section 607).
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "CHAPTER 5",
    queryText: "wildland urban interface special building construction",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 607",
    queryText: "defensible space vegetation management wildland",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 504",
    queryText: "ignition resistant construction class",
  },
];

export function buildSeedCuratedQueries(): ReadonlyArray<CuratedQuery> {
  const now = new Date().toISOString();
  const queries: CuratedQuery[] = [];
  let serial = 0;

  const compile = (drafts: ReadonlyArray<SeedQueryDraft>): void => {
    for (const d of drafts) {
      serial++;
      queries.push({
        queryId: `seed-${d.jurisdictionKey}-${serial}`,
        jurisdictionTenant: d.jurisdictionKey,
        queryText: d.queryText,
        expectedAtomDid: expectedDid(
          d.jurisdictionKey,
          d.codeBook,
          d.edition,
          d.sectionNumber,
        ),
        queryType: d.queryType ?? "retrieval",
        authorshipSource: "llm-generated",
        humanReviewedBy: null,
        humanReviewedAt: null,
        status: "draft",
      });
    }
  };

  compile(BASTROP_DRAFTS);
  compile(GRAND_COUNTY_DRAFTS);

  return queries;
}

export function curatedQueriesForJurisdiction(
  jurisdictionKey: string,
): ReadonlyArray<CuratedQuery> {
  return buildSeedCuratedQueries().filter(
    (q) => q.jurisdictionTenant === jurisdictionKey,
  );
}
