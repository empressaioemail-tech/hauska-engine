/**
 * Hutto UDC curated query set — Path PDF scope.
 *
 * Reviewer-realistic queries against the City of Hutto Unified
 * Development Code (Chapter 16 of the Hutto Code of Ordinances,
 * internally numbered 10.NNN), Revised March 2024, ingested via Path
 * PDF from the city-hosted born-digital PDF. Coverage spans the ten
 * internal chapters surfaced by the live TOC walk 2026-05-21:
 *
 *   Chapter 1  Introduction              — title, purpose, applicability
 *   Chapter 2  Development review        — definitions, PUD, variance
 *   Chapter 3  Zoning                    — districts, uses, performance
 *   Chapter 4  Site development          — bulk, parking, landscaping
 *   Chapter 5  FBC / Old Town            — form-based + OT standards
 *   Chapter 6  Subdivision standards     — platting, parkland, streets
 *   Chapter 7  Historic preservation     — districts, COA
 *   Chapter 8  Stormwater & drainage     — floodplain provisions
 *   Chapter 9  Water & wastewater        — system design
 *   Chapter 10 FBC / OTC district tables — transect standards
 *
 * Each query leads with the section-number anchor to ride the storage
 * scoring layer's section-number boost (the authoring discipline
 * established by the Bastrop B3 / Grand County LAND_USE sessions).
 *
 * Authorship `llm-generated`; status `draft` until production
 * reviewer-zero curation lands. Hutto's partnership is partnership-
 * pending, so the corpus is tagged `platform-internal` per Path A.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

export const HUTTO_UDC_JURISDICTION = "hutto_tx";
export const HUTTO_UDC_JURISDICTION_NAME = "Hutto, TX";
export const HUTTO_UDC_EDITION_LABEL = "Hutto UDC (March 2024)";
export const HUTTO_UDC_PDF_URL =
  "https://www.huttotx.gov/DocumentCenter/View/3779/UDC-Updated-through-March-2024";

interface HuttoQueryDraft {
  /** Section-number anchor against the atomized Hutto UDC corpus. */
  sectionNumber: string;
  queryText: string;
}

const HUTTO_DRAFTS: ReadonlyArray<HuttoQueryDraft> = [
  // Chapter 1 — Introduction
  { sectionNumber: "10.101", queryText: "10.101 title of the unified development code" },
  { sectionNumber: "10.102", queryText: "10.102 purpose of the development code" },
  {
    sectionNumber: "10.104.3",
    queryText: "10.104.3 extraterritorial jurisdiction areas applicability",
  },
  // Chapter 2 — Development review
  { sectionNumber: "10.202.2", queryText: "10.202.2 definitions of terms" },
  {
    sectionNumber: "10.203.13",
    queryText: "10.203.13 planned unit development PUD review process",
  },
  { sectionNumber: "10.203.24", queryText: "10.203.24 variance" },
  { sectionNumber: "10.206.5", queryText: "10.206.5 nonconforming signs" },
  { sectionNumber: "10.207.2", queryText: "10.207.2 enforcement methods" },
  // Chapter 3 — Zoning
  {
    sectionNumber: "10.303.2",
    queryText: "10.303.2 SF-R residential single household rural estate district",
  },
  {
    sectionNumber: "10.303.7",
    queryText: "10.303.7 B-1 commercial local neighborhood district",
  },
  { sectionNumber: "10.307.21", queryText: "10.307.21 kennel commercial use standards" },
  { sectionNumber: "10.309.9", queryText: "10.309.9 park institutional civic use" },
  { sectionNumber: "10.311.6", queryText: "10.311.6 home occupation accessory use" },
  {
    sectionNumber: "10.312.3",
    queryText: "10.312.3 electrical and radio frequency disturbance performance standard",
  },
  // Chapter 4 — Site development
  {
    sectionNumber: "10.403.3",
    queryText: "10.403.3 lot dimensions and area bulk standards",
  },
  { sectionNumber: "10.403.6", queryText: "10.403.6 bufferyard" },
  {
    sectionNumber: "10.405.9",
    queryText: "10.405.9 parking and loading space number standards",
  },
  {
    sectionNumber: "10.407.8",
    queryText: "10.407.8 tree preservation and removal landscaping",
  },
  {
    sectionNumber: "10.409.3",
    queryText: "10.409.3 outdoor lighting general standards",
  },
  { sectionNumber: "10.410.6", queryText: "10.410.6 prohibited signs" },
  // Chapter 5 — FBC / Old Town
  {
    sectionNumber: "10.503.7",
    queryText: "10.503.7 Old Town parking calculations and location standards",
  },
  // Chapter 6 — Subdivision standards
  {
    sectionNumber: "10.609",
    queryText: "10.609 parkland and open space dedication",
  },
  { sectionNumber: "10.611.9", queryText: "10.611.9 minor arterial street classification" },
  // Chapter 7 — Historic preservation
  {
    sectionNumber: "10.703.3",
    queryText: "10.703.3 designation of initial historic district",
  },
  // Chapter 8 — Stormwater & drainage
  { sectionNumber: "10.804.5", queryText: "10.804.5 floodways flood hazard standards" },
  // Chapter 9 — Water & wastewater
  { sectionNumber: "10.903", queryText: "10.903 water system design and construction" },
  // Chapter 10 — FBC / OTC district tables
  {
    sectionNumber: "10.1002.9",
    queryText: "10.1002.9 building height",
  },
];

/**
 * Mirrors the path-pdf-ingest atomizer's section entityId construction:
 * `<jurisdiction>/<slug(editionLabel)>/<slug(normalizeSectionLabel(num))>`.
 * Hutto section numbers carry no "Sec." prefix, so stripSectionPrefix is
 * a no-op; it is kept for parity with the Bastrop B3 query builder.
 */
function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(HUTTO_UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${HUTTO_UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildHuttoUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return HUTTO_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `hutto-udc-${i + 1}`,
    jurisdictionTenant: HUTTO_UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
