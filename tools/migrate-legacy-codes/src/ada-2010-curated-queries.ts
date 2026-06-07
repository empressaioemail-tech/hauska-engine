/**
 * 2010 ADA Standards curated query set — Path PDF / federal-accessibility.
 *
 * Seed queries hand-authored against the DOJ 2010 ADA Standards for
 * Accessible Design. Each query leads with the section-number anchor
 * (per the Grand County / B3 authoring discipline) so the storage
 * scoring layer's section-number boost applies.
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";
import { LAYER_1_QUALITY_BAR } from "@hauska-engine/corpus/model-code";

import {
  ADA_2010_EDITION_LABEL,
  FEDERAL_ACCESSIBILITY_TENANT,
} from "./accessibility-standards.js";
import { normalizeSectionLabel, slugify } from "./slug.js";

export { LAYER_1_QUALITY_BAR as ADA_2010_QUALITY_BAR };

interface AdaQuerySpec {
  sectionNumber: string;
  queryText: string;
}

const ADA_2010_SPECS: ReadonlyArray<AdaQuerySpec> = [
  {
    sectionNumber: "101.1",
    queryText:
      "101.1 ADA general scoping and technical requirements for accessible sites and buildings",
  },
  {
    sectionNumber: "203.1",
    queryText: "203.1 ADA general exceptions to accessibility requirements",
  },
  {
    sectionNumber: "404.2.3",
    queryText: "404.2.3 ADA maneuvering clearances at manual doors and doorways",
  },
  {
    sectionNumber: "609.1",
    queryText: "609.1 ADA grab bar installation in toilet and bathing facilities",
  },
  {
    sectionNumber: "206.2.1",
    queryText:
      "206.2.1 ADA accessible route to site arrival points",
  },
  {
    sectionNumber: "106.5",
    queryText: "106.5 ADA defined terms application and administration",
  },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(ADA_2010_EDITION_LABEL);
  const localId = `${FEDERAL_ACCESSIBILITY_TENANT}/${editionSlug}/${slugify(
    normalizeSectionLabel(sectionNumber),
  )}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildAda2010CuratedQueries(): ReadonlyArray<CuratedQuery> {
  return ADA_2010_SPECS.map<CuratedQuery>((spec, i) => ({
    queryId: `ada-2010-${String(i + 1).padStart(3, "0")}`,
    jurisdictionTenant: FEDERAL_ACCESSIBILITY_TENANT,
    queryText: spec.queryText,
    expectedAtomDid: expectedDid(spec.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "human-curated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}
