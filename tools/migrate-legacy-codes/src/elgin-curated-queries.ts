/**
 * Elgin curated query set — Path C scope, partnership-pending
 * internal-tier.
 *
 * 12 draft queries targeting Elgin's Municode-hosted Subdivisions
 * (Chapter 36) and Zoning (Chapter 46) — the substantive development
 * regulations operators encounter when running site / plat workflows
 * against the Elgin jurisdiction.
 *
 * Each query leads with the chapter-prefixed section label (e.g.
 * "36-30 preliminary plat") so the storage's `+0.25` section-number
 * anchor boost — tightened to token-equality in this PR — fires
 * cleanly. Topic terms after the label disambiguate against neighbor
 * sections sharing the same chapter root.
 *
 * Site Developments (Chapter 48) is not in this seed set: with
 * maxLeafFetches=200 the leaf budget is exhausted by Chapters 36 + 46
 * before reaching 48. Either raise the budget for production runs or
 * write a follow-on seed targeting Chapter 48 once budget is enlarged.
 *
 * Visibility: jurisdiction-corpus tag is `platform-internal`;
 * partnership-pending Sylvia outreach gates the flip to `public-free`.
 * Reviewer-zero curation by operator or Elgin contact lands later;
 * authorship `llm-generated`, status `draft`.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

interface ElginQueryDraft {
  /** Section-number label as atomized (e.g. "36-30."). The atomizer
   *  strips the trailing dot when slugifying for entityId. */
  sectionNumber: string;
  queryText: string;
}

const ELGIN_DRAFTS: ReadonlyArray<ElginQueryDraft> = [
  // Chapter 36 — Subdivisions
  { sectionNumber: "36-1", queryText: "36-1 authority subdivision regulations" },
  { sectionNumber: "36-7", queryText: "36-7 fees subdivision" },
  { sectionNumber: "36-25", queryText: "36-25 pre-application meeting concept plan" },
  { sectionNumber: "36-30", queryText: "36-30 preliminary plat" },
  { sectionNumber: "36-31", queryText: "36-31 final plat approval" },
  { sectionNumber: "36-37", queryText: "36-37 subdivision variance request" },
  // Chapter 46 — Zoning
  { sectionNumber: "46-1", queryText: "46-1 zoning definitions" },
  { sectionNumber: "46-2", queryText: "46-2 zoning purpose intent" },
  { sectionNumber: "46-3", queryText: "46-3 zoning district map" },
  { sectionNumber: "46-4", queryText: "46-4 zoning district boundaries" },
  { sectionNumber: "46-8", queryText: "46-8 zoning enforcement" },
  { sectionNumber: "46-9", queryText: "46-9 penalty for zoning violation" },
];

const ELGIN_JURISDICTION = "elgin_tx";
const ELGIN_EDITION_LABEL = "Elgin Code of Ordinances (current supplement)";

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(ELGIN_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${ELGIN_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildElginCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return ELGIN_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `elgin-${i + 1}`,
    jurisdictionTenant: ELGIN_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export { ELGIN_EDITION_LABEL, ELGIN_JURISDICTION };
