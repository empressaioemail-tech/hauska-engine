/**
 * Leander curated query set — Sync 5 Tier 1, Path C scope.
 *
 * Reviewer-realistic queries against the City of Leander development
 * regulations, ingested via Path C from the Municode-hosted Code of
 * Ordinances (clientId 2988). Leander embeds its substantive
 * subdivision and zoning regulations as ordinance exhibits:
 *
 *   Chapter 10 "Subdivision Regulation" -> Exhibit A "Subdivision
 *     Ordinance" -> Articles I-V, sections bare-numbered 1.-77.
 *   Chapter 14 "Zoning" -> Exhibit A "Zoning Ordinance" -> Articles
 *     I-X, sections bare-numbered and restarting per article.
 *
 * Those bare integers collide on the atomizer's `<tenant>/<edition>/
 * <num>` entityId — `Sec. 1.` exists under many articles. The
 * bare-numbered-section disambiguation (PR #22) re-keys each colliding
 * section by its containing chapter/article path, so the expected atom
 * DIDs below carry that path (`.../ch14zo-exhibit-azoor-artiiiusco/1`).
 * A bare integer that happens to be unique corpus-wide (subdivision
 * `41.`, `61.`) keeps its plain `<tenant>/<edition>/<num>` id.
 *
 * Each query leads with the section-number anchor for the storage
 * scoring layer's section-number boost; because bare numbers repeat,
 * the topic terms after the anchor carry the disambiguation weight.
 *
 * Visibility: Leander is non-partnered, so the jurisdiction-corpus is
 * tagged `platform-internal` per Path A. Authorship `llm-generated`,
 * status `draft` until reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

export const LEANDER_JURISDICTION = "leander_tx";
export const LEANDER_JURISDICTION_NAME = "Leander, TX";
export const LEANDER_EDITION_LABEL =
  "Leander Code of Ordinances (current supplement)";
export const LEANDER_CLIENT_ID = 2988;
export const LEANDER_LIBRARY_SLUG = "leander";
/** Top-level TOC headings: "CHAPTER 10 - SUBDIVISION REGULATION" + "CHAPTER 14 - ZONING". */
export const LEANDER_CHAPTER_FILTER = "subdivision|zoning";

interface LeanderQueryDraft {
  /** The atomized section's entityId (the `buildAtomDid` local id). */
  entityId: string;
  queryText: string;
}

const LEANDER_DRAFTS: ReadonlyArray<LeanderQueryDraft> = [
  // --- Subdivision Ordinance (Chapter 10, Exhibit A) ---
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch10sure-exhibit-asuor-artige/1",
    queryText: "1 subdivision ordinance definitions of terms",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch10sure-exhibit-asuor-artige/2",
    queryText: "2 subdivision ordinance purpose",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch10sure-exhibit-asuor-artige/7",
    queryText: "7 subdivision plat exemptions",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch10sure-exhibit-asuor-artiipr/20",
    queryText: "20 subdivision general procedure plat review",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch10sure-exhibit-asuor-artiipr/21",
    queryText: "21 subdivision concept plan",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/22",
    queryText: "22 subdivision preliminary plat",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/24",
    queryText: "24 subdivision final plat",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/26",
    queryText: "26 short form final plats",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/41",
    queryText: "41 subdivision drainage improvements",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/50",
    queryText: "50 subdivision tree preservation",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/61",
    queryText: "61 parkland dedication and park improvements",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/72",
    queryText: "72 subdivision variances",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/74",
    queryText: "74 subdivision fees",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/77",
    queryText: "77 subdivision enforcement",
  },
  // --- Zoning Ordinance (Chapter 14, Exhibit A) ---
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artige/3",
    queryText: "3 zoning ordinance general purpose",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artige/6",
    queryText: "6 zoning ordinance definitions of terms",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artiieszore/2",
    queryText: "2 establishment of zoning districts",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artiiiusco/11",
    queryText: "11 TH tiny house",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artiiiusco/13",
    queryText: "13 MF multifamily zoning district",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artiiiusco/16",
    queryText: "16 GC general commercial zoning district",
  },
  {
    entityId: "leander_tx/leander-code-of-ordinances-current-supplement/19",
    queryText: "19 PUD planned unit development district",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artivusst/2",
    queryText: "2 special use permit",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artivusst/10",
    queryText: "10 mobile food establishment park",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artivusst/8",
    queryText: "8 home occupations",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artvisist/7",
    queryText: "7 drainage and detention facilities",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artvisist/3",
    queryText: "3 off-street parking requirements",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artvisist/9",
    queryText: "9 special vehicle storage loading",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artixside/3",
    queryText: "3 site development application processing expiration and permitting",
  },
  {
    entityId:
      "leander_tx/leander-code-of-ordinances-current-supplement/ch14zo-exhibit-azoor-artxad/4",
    queryText: "4 board of adjustment",
  },
];

export function buildLeanderCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return LEANDER_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `leander-${i + 1}`,
    jurisdictionTenant: LEANDER_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: buildAtomDid("code-section", draft.entityId).raw,
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
