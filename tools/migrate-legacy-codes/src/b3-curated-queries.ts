/**
 * Bastrop B3 Code curated query set — Path PDF scope.
 *
 * 20 draft queries targeting the substantive Bastrop Building Block
 * (B3) Code (April 2025) corpus ingested via Path PDF. Coverage spans
 * the six published chapters per the live TOC walk 2026-05-19:
 *
 *   Chapter 1  Subdivisions             — platting procedures + TXDOT
 *   Chapter 2  Zoning Procedures        — fees, enacting provisions
 *   Chapter 3  Place Type Zoning        — P1-P6 / T-class place types
 *   Chapter 4  Character Districts      — intent, descriptions, patterns
 *   Chapter 5  (continued)              — residential dimensional std
 *   Chapter 6  Private Realm            — parking, lighting, signs
 *
 * Each query leads with the section-number anchor to ride the storage
 * scoring layer's +0.25 section-number boost (per the Grand County
 * LAND_USE session's authoring discipline). Subsection numbers drawn
 * from the visible TOC pages 3-5 of the live PDF; sections not in the
 * visible TOC may need refresh after Phase B.1 ingest surfaces the
 * actual section labels via path-pdf-ingest --show-sections.
 *
 * Reviewer-zero curation (Sylvia or operator) refines via the curated-
 * queries port. Authorship `llm-generated`; status `draft` until
 * production reviewer-zero curation lands.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

interface B3QueryDraft {
  /** Section-number anchor against the atomized B3 corpus. */
  sectionNumber: string;
  queryText: string;
}

const B3_DRAFTS: ReadonlyArray<B3QueryDraft> = [
  // Chapter 1 — Subdivisions
  {
    sectionNumber: "Sec. 1.1.001",
    queryText: "1.1.001 general platting procedures",
  },
  {
    sectionNumber: "Sec. 1.1.002",
    queryText: "1.1.002 dormant final subdivision plats",
  },
  {
    sectionNumber: "Sec. 1.4.011",
    queryText: "1.4.011 Texas department of transportation TXDOT permit required",
  },
  // Chapter 2 — Zoning Procedures
  {
    sectionNumber: "Sec. 2.1.001",
    queryText: "2.1.001 fees for review of zoning change applications",
  },
  {
    sectionNumber: "Sec. 2.1.002",
    queryText: "2.1.002 fees for review of variance request or appeal of site plan",
  },
  {
    sectionNumber: "Sec. 2.3.001",
    queryText: "2.3.001 zoning ordinance enacting provisions purpose",
  },
  {
    sectionNumber: "Sec. 2.3.002",
    queryText: "2.3.002 compliance required for zoning",
  },
  {
    sectionNumber: "Sec. 2.3.003",
    queryText: "2.3.003 zoning upon annexation",
  },
  {
    sectionNumber: "Sec. 2.3.004",
    queryText: "2.3.004 annual adoption of schedule of uniform submittal dates",
  },
  // Chapter 3 — Place Type Zoning Districts
  {
    sectionNumber: "Sec. 3.1.005",
    queryText: "3.1.005 place type zoning districts table P1 nature",
  },
  {
    sectionNumber: "Sec. 3.4.005",
    queryText: "3.4.005 minimum standards place type",
  },
  {
    sectionNumber: "Sec. 3.4.006",
    queryText: "3.4.006 master plan submission",
  },
  {
    sectionNumber: "Sec. 3.4.007",
    queryText: "3.4.007 submission and review process",
  },
  // Chapter 4 — Character Districts
  {
    sectionNumber: "Sec. 4.1.001",
    queryText: "4.1.001 intent of character districts",
  },
  {
    sectionNumber: "Sec. 4.1.002",
    queryText: "4.1.002 character districts established",
  },
  {
    sectionNumber: "Sec. 4.2.001",
    queryText: "4.2.001 character districts descriptions and additional standards",
  },
  {
    sectionNumber: "Sec. 4.2.002",
    queryText: "4.2.002 character district development patterns",
  },
  {
    sectionNumber: "Sec. 4.2.003",
    queryText: "4.2.003 neighborhood regulating plan by character district",
  },
  // Chapter 6 — Private Realm Development Standards
  {
    sectionNumber: "Sec. 6.6.009",
    queryText: "6.6.009 lighting curfews outdoor light output",
  },
  // Cross-cutting (without strict section anchor; substantive boundary
  // query — should land on whatever section in the corpus defines
  // outdoor lighting standards).
  {
    sectionNumber: "Sec. 6.6.009",
    queryText: "Bastrop outdoor lighting nonresidential motion sensor activation",
  },
];

const B3_JURISDICTION = "bastrop_tx";
const B3_EDITION_LABEL = "Bastrop B3 Code (April 2025)";

function expectedDid(sectionNumber: string): string {
  // Mirrors path-pdf-ingest atomizer output. The atomizer uses just
  // `slugify(editionLabel)` (no codeBook prefix); buildAtomDid emits
  // `did:hauska:code-section:<localId>`. Stripping "Sec." prefix +
  // slugifying "1.1.001" -> "1-1-001" matches the section atom's
  // entityId.
  const editionSlug = slugify(B3_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${B3_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildBastropB3CuratedQueries(): ReadonlyArray<CuratedQuery> {
  return B3_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `b3-bastrop-${i + 1}`,
    jurisdictionTenant: B3_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: expectedDid(draft.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export { B3_EDITION_LABEL, B3_JURISDICTION };
