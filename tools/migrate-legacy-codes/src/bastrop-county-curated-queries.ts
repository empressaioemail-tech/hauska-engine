/**
 * Bastrop County Subdivision Regulations curated query set —
 * Path PDF scope, partnership-pending internal-tier.
 *
 * 12 draft queries targeting the 17 Roman-numeral sections in the
 * Bastrop County Subdivision Regulations (Revised April 24, 2017),
 * hosted as a born-digital PDF at:
 *
 *   https://www.bastropcounty.gov/upload/page/0145/docs/SDRegsBookmarkedAdopted042417.pdf
 *
 * The dispatch sized Bastrop County as Municode Path A. Live recon
 * 2026-05-19 surfaced that Bastrop County's regulations live on
 * bastropcounty.gov as a PDF, not on Municode — so Path PDF (the
 * RawPdfAdapter completed for the B3 Code in PR #5) is the right
 * ingest path. Operator confirmed proceed-with-PDF.
 *
 * Each query leads with the Roman-numeral section label to ride the
 * `+0.25` section-number anchor boost (tightened to token-equality
 * matching in this PR — was substring; substring mis-fired on short
 * labels like "I" appearing inside English words). Topic terms after
 * the label disambiguate against neighbor sections.
 *
 * Reviewer-zero curation by operator or Bastrop County contact lands
 * later; authorship `llm-generated`, status `draft`.
 *
 * Visibility: jurisdiction-corpus tag is `platform-internal`; queries
 * resolve correctly but the public catalog `list_jurisdictions` does
 * not surface this jurisdiction until partnership outreach closes.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

interface BCQueryDraft {
  /** Roman-numeral section label as atomized. */
  sectionNumber: string;
  queryText: string;
}

const BC_DRAFTS: ReadonlyArray<BCQueryDraft> = [
  {
    sectionNumber: "I",
    queryText: "I general authority enforcement penalties coordination",
  },
  {
    sectionNumber: "II",
    queryText: "II definitions and acronyms applicant subdivision",
  },
  {
    sectionNumber: "III",
    queryText: "III subdivision procedures preliminary plat compliance",
  },
  {
    sectionNumber: "IV",
    queryText: "IV short form procedures for final plats",
  },
  {
    sectionNumber: "V",
    queryText: "V subdivision layout requirements lots blocks streets",
  },
  {
    sectionNumber: "VI",
    queryText: "VI infrastructure planning transportation utilities",
  },
  {
    sectionNumber: "VII",
    queryText: "VII exemptions and special subdivisions",
  },
  {
    sectionNumber: "VIII",
    queryText: "VIII drainage requirements engineering drainage report",
  },
  {
    sectionNumber: "IX",
    queryText: "IX street design standards intersections",
  },
  {
    sectionNumber: "X",
    queryText: "X street names and street signs nine one one address",
  },
  {
    sectionNumber: "XI",
    queryText: "XI construction drawings submission erosion control plan",
  },
  {
    sectionNumber: "XV",
    queryText: "XV fees",
  },
];

const BC_JURISDICTION = "bastrop_county_tx";
const BC_EDITION_LABEL = "Bastrop County Subdivision Regulations (Revised April 24, 2017)";

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(BC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${BC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildBastropCountyCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return BC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `bc-bastrop-county-${i + 1}`,
    jurisdictionTenant: BC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export const BASTROP_COUNTY_SUBDIVISION_REGS_URL =
  "https://www.bastropcounty.gov/upload/page/0145/docs/SDRegsBookmarkedAdopted042417.pdf";

export { BC_EDITION_LABEL, BC_JURISDICTION };
