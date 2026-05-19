/**
 * Bastrop UDC curated query set — Path C scope.
 *
 * Updated 2026-05-19 (post-live-Municode-walk finding): the Bastrop
 * Building Block (B3) Code, Authentic Bastrop Pattern Book, and B3
 * Technical Manual are ALL adopted by reference in Municode's
 * Chapter 14. The actual zoning rules (use districts, setbacks, lot
 * dimensions, subdivision standards) live on Bastrop's city website,
 * NOT on Municode. Municode's Chapter 14 carries only:
 *
 *   - Three adoption "Sec. 14.0X.001 - Adopted." entries
 *   - Editor's note describing the 2019 Ord. 2019-51 repeal of the
 *     prior Chapter 14 (which DID contain the old zoning rules)
 *   - Ordinance history per adoption section
 *
 * These curated queries target the adoption-meta content that Path C
 * via Municode CAN deliver: questions about which codes Bastrop
 * adopts, when they were adopted, and under which ordinance. Queries
 * about actual zoning rules (setback distance, height limits,
 * permitted uses) require a separate adapter pointing at Bastrop's
 * city-website B3 publisher and are explicitly out of scope until
 * that adapter lands.
 *
 * Reviewer-zero curation (Sylvia / Jaime) refines via the
 * curated-queries port. Authorship marked `llm-generated`; status
 * `draft`.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";

import {
  normalizeSectionLabel,
  slugify,
  stripSectionPrefix,
} from "./slug.js";

interface UdcQueryDraft {
  /** Section-number anchor against the actual atomized corpus. */
  sectionNumber?: string;
  queryText: string;
}

const UDC_DRAFTS: ReadonlyArray<UdcQueryDraft> = [
  // Anchored against the three adoption sections present in Municode
  // Chapter 14. Section numbers from live Municode walk 2026-05-19.
  {
    sectionNumber: "Sec. 14.01.001",
    queryText: "Bastrop Building Block B3 Code adopted by reference",
  },
  {
    sectionNumber: "Sec. 14.02.001",
    queryText: "Authentic Bastrop Pattern Book adoption",
  },
  {
    sectionNumber: "Sec. 14.03.001",
    queryText: "Bastrop Building Block B3 Technical Manual adopted",
  },
  // Chapter-level meta queries (anchored against the chapter atom).
  {
    sectionNumber: "Chapter 14",
    queryText: "Bastrop development code chapter adopted by reference",
  },
  // Open queries — these will MISS until a real B3 publisher adapter
  // lands. Kept in the set as a Sync-4 boundary marker: substantive
  // zoning queries do NOT pass against the Municode-adoption-only
  // corpus, and that's the honest signal.
  { queryText: "Bastrop UDC permitted uses by district" },
  { queryText: "Bastrop UDC residential zone setback" },
];

const UDC_JURISDICTION = "bastrop_tx";
const UDC_EDITION_LABEL = "Bastrop UDC (current supplement)";
const UDC_CODE_BOOK = "UDC";

function expectedDid(sectionNumber: string): string {
  // Path C atomizer uses just `slugify(editionLabel)` (no codeBook
  // prefix); mirror that so curated query DIDs land on the same
  // atom that path-c-ingest writes. (The Path B legacy-migration
  // path uses `buildEditionSlug(codeBook, edition)` because legacy
  // code_atoms rows carry a codeBook column; Path C atoms don't.)
  const editionSlug = slugify(UDC_EDITION_LABEL);
  const stripped = stripSectionPrefix(normalizeSectionLabel(sectionNumber));
  const localId = `${UDC_JURISDICTION}/${editionSlug}/${slugify(stripped)}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildBastropUdcCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return UDC_DRAFTS.map<CuratedQuery>((draft, i) => ({
    queryId: `udc-bastrop-${i + 1}`,
    jurisdictionTenant: UDC_JURISDICTION,
    queryText: draft.queryText,
    expectedAtomDid: draft.sectionNumber
      ? expectedDid(draft.sectionNumber)
      : "did:hauska:code-section:bastrop_tx/unanchored/" + slugify(draft.queryText),
    queryType: "retrieval",
    authorshipSource: "llm-generated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

export { UDC_CODE_BOOK, UDC_EDITION_LABEL, UDC_JURISDICTION };
