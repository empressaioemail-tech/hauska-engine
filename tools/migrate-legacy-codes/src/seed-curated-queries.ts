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

/**
 * Grand County LAND_USE (Land Use Code rev. 3/21) — Session A.5 scope.
 *
 * 215 atoms across 10 articles per the 2026-05-19 live coverage.
 * Article 2 = zoning districts; Article 5 = lot design (setbacks);
 * Article 7 = subdivision; Article 10 = definitions. Section labels
 * carry no "Section" / "Article" prefix in the legacy ingest; they're
 * raw X.Y numerics with `#partN` suffixes for over-cap chunks.
 *
 * Reviewer-zero curation lands separately (Nick or Grand County
 * contact); ratification status `draft` per Phase 0.
 */
const GRAND_COUNTY_LANDUSE_DRAFTS: ReadonlyArray<SeedQueryDraft> = [
  // Targets surfaced via dry-run --show-sections against the live
  // 2026-05-19 corpus. Distinctive district / topic terminology +
  // section-number anchor (the storage scorer applies a +0.25 bonus
  // when the query contains the atom's section number, stripped of
  // any #partN suffix the legacy ingest added for over-cap chunks).
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "2.3",
    queryText: "2.3 Small Lot Residential SLR district",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "2.10",
    queryText: "2.10 Highway Commercial HC district",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "2.12",
    queryText: "2.12 Resort Special RS district",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "4.4#part1",
    queryText: "4.4 Planned Unit Development PUD",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "4.8#part1",
    queryText: "4.8 Scenic Resource Protection District",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "5.4#part1",
    queryText: "5.4 residential districts dimensional setback",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "6.1#part1",
    queryText: "6.1 off-street parking spaces required",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "6.4#part1",
    queryText: "6.4 landscaping screening buffer",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "6.5#part1",
    queryText: "6.5 sign regulations permitted",
  },
  {
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "Land Use Code (rev. 3/21)",
    sectionNumber: "6.14",
    queryText: "6.14 affordable housing assured",
  },
];

const ALL_DRAFTS: ReadonlyArray<SeedQueryDraft> = [
  ...BASTROP_DRAFTS,
  ...GRAND_COUNTY_DRAFTS,
  ...GRAND_COUNTY_LANDUSE_DRAFTS,
];

function compileDrafts(
  drafts: ReadonlyArray<SeedQueryDraft>,
): ReadonlyArray<CuratedQuery> {
  return drafts.map<CuratedQuery>((d, i) => ({
    queryId: `seed-${d.jurisdictionKey}-${d.codeBook}-${i + 1}`,
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
  }));
}

export function buildSeedCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return compileDrafts(ALL_DRAFTS);
}

export function curatedQueriesForJurisdiction(
  jurisdictionKey: string,
): ReadonlyArray<CuratedQuery> {
  return compileDrafts(
    ALL_DRAFTS.filter((d) => d.jurisdictionKey === jurisdictionKey),
  );
}

/**
 * Filter the seed query set to a jurisdiction + an explicit allow-list
 * of code books. Used by the `eval --code-books=...` CLI path so a
 * jurisdiction-and-book-scoped migration eval against the matching
 * scoped query subset.
 */
export function curatedQueriesForJurisdictionAndBooks(
  jurisdictionKey: string,
  codeBooks: ReadonlyArray<string>,
): ReadonlyArray<CuratedQuery> {
  const booksAllowed = new Set(codeBooks);
  return compileDrafts(
    ALL_DRAFTS.filter(
      (d) => d.jurisdictionKey === jurisdictionKey && booksAllowed.has(d.codeBook),
    ),
  );
}
