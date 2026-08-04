/**
 * Smithville curated query set — Path eCode360 File scope,
 * partnership-pending internal-tier.
 *
 * 15 DRAFT queries against real section labels pulled directly from
 * `smithville-normalized-2026-08-04.json` (§ format, dot-numbered:
 * "§ 1.07.038"), spread across the code's actual chapters (1 through
 * 13) and picked for substantive body text (each candidate below has
 * 1,000+ characters of section body in the artifact; reserved/empty
 * placeholder sections were excluded).
 *
 * expectedAtomDid construction mirrors `elgin-curated-queries.ts`'s
 * `expectedDid()` exactly: `stripSectionPrefix(normalizeSectionLabel(...))`
 * then `slugify()`, joined under `<tenant>/<editionSlug>/<slug>`. The
 * eCode360 artifact's labels carry a "§" prefix (with a non-breaking
 * space, not a regular space, between "§" and the digits in the raw
 * bytes — `buildCodeTree`'s `splitHeadingLabel()` strips it via a `\s`
 * match, which matches U+00A0 under ECMAScript's `\s` class) — the
 * `sectionNumber` `atomize()` actually stores on each `code-section`
 * atom is the bare dot-numbered form ("1.07.038"), never carrying the
 * "§" glyph. `stripSectionPrefix()` is a no-op safety net here since
 * the drafts below already pass the bare form (matching what the
 * pipeline stores), consistent with slug.ts's own doc comment describing
 * it as tolerant of both forms.
 *
 * Visibility: jurisdiction-corpus tag is `platform-internal` (passed
 * explicitly by the build-corpus-snapshot.ts unit, per the OPS-9 S3
 * ingest planner ruling — Smithville is partnership-pending, same
 * posture as Elgin). Authorship `llm-generated`, status `draft` —
 * planner verification of every expectedAtomDid + source label against
 * the live artifact happens at PR review, not before.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

interface SmithvilleQueryDraft {
  /** Bare dot-numbered section label as atomize() stores it (no "§"). */
  sectionNumber: string;
  queryText: string;
}

const SMITHVILLE_DRAFTS: ReadonlyArray<SmithvilleQueryDraft> = [
  // Chapter 1 — General Provisions / Administration
  { sectionNumber: "1.07.038", queryText: "1.07.038 exemptions and exclusions" },
  { sectionNumber: "1.08.037", queryText: "1.08.037 general regulations" },
  { sectionNumber: "1.10.009", queryText: "1.10.009 interment and disinterments generally" },
  // Chapter 2 — Animal Control
  { sectionNumber: "2.07.001", queryText: "2.07.001 space requirements enclosures sanitation keeping hogs" },
  { sectionNumber: "2.08.003", queryText: "2.08.003 restricted animals" },
  // Chapter 3 — Building Regulations
  { sectionNumber: "3.04.008", queryText: "3.04.008 flood hazard reduction standards" },
  { sectionNumber: "3.09.004", queryText: "3.09.004 industrialized housing and buildings" },
  // Chapter 4 — Business Regulations
  { sectionNumber: "4.08.072", queryText: "4.08.072 operational regulations and technical requirements" },
  // Chapter 5 — Fire Prevention and Protection
  { sectionNumber: "5.05.001", queryText: "5.05.001 general requirements tank trucks and trailers" },
  // Chapter 6 — Health and Sanitation
  { sectionNumber: "6.02.032", queryText: "6.02.032 application fees" },
  // Chapter 7 — Municipal Court
  { sectionNumber: "7.01.002", queryText: "7.01.002 municipal court jurisdiction" },
  // Chapter 8 — Offenses and Nuisances
  { sectionNumber: "8.04.003", queryText: "8.04.003 offensive odors" },
  // Chapter 11 — Taxation
  { sectionNumber: "11.04.002", queryText: "11.04.002 tax levied amount exemptions" },
  // Chapter 12 — Traffic and Vehicles
  { sectionNumber: "12.04.005", queryText: "12.04.005 speed limits on specific streets" },
  // Chapter 13 — Utilities
  { sectionNumber: "13.14.008", queryText: "13.14.008 criteria for initiation and termination of drought response stages" },
];

const SMITHVILLE_JURISDICTION = "smithville_tx";
const SMITHVILLE_EDITION_LABEL = "Smithville Code of Ordinances (eCode360)";

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(SMITHVILLE_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${SMITHVILLE_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildSmithvilleCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return SMITHVILLE_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `smithville-${i + 1}`,
    jurisdictionTenant: SMITHVILLE_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export { SMITHVILLE_EDITION_LABEL, SMITHVILLE_JURISDICTION };
