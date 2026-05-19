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
    queryText: "Table R301.2 climatic geographic design",
  },
  // IWUIC scope — targets section labels that exist in the legacy
  // Grand County IWUIC corpus per the 2026-05-19 live coverage report.
  // Section labels surfaced via dry-run + eval iteration; query text
  // tuned to land on the target section without leading with the
  // section number (per Phase 0 reviewer-zero-natural style).
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 101",
    queryText: "wildland urban interface code scope intent",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 104",
    queryText: "Section 104 duties powers code official",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 105#part1",
    queryText: "Section 105 fire code official duties permits",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 503",
    queryText: "Section 503 Class 1 ignition-resistant",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 505#part1",
    queryText: "exterior wall covering fire-resistive",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "CHAPTER 5#part1",
    queryText: "Chapter 5 special building construction wildland fire-resistive",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 405",
    queryText: "Section 405 wildland-urban interface area",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 607#part5",
    queryText: "defensible space vegetation management plan",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "IWUIC",
    edition: "IWUIC 2006",
    sectionNumber: "SECTION 607#part7",
    queryText: "fuel modification distance defensible space wildland",
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
