/**
 * Fair Housing Act Design Manual curated query set — Path PDF scope.
 *
 * Section numbers verified against the live HUD FHA Design Manual PDF
 * ingest (chapter-scoped decimals such as `1.10`, `4.1`, `6.11`).
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import type { CuratedQuery } from "@hauska-engine/corpus/eval";
import { LAYER_1_QUALITY_BAR } from "@hauska-engine/corpus/model-code";

import {
  FHA_DESIGN_MANUAL_EDITION_LABEL,
  FEDERAL_ACCESSIBILITY_TENANT,
} from "./accessibility-standards.js";
import { normalizeSectionLabel, slugify } from "./slug.js";

export { LAYER_1_QUALITY_BAR as FHA_DESIGN_MANUAL_QUALITY_BAR };

interface FhaQuerySpec {
  sectionNumber: string;
  queryText: string;
}

const FHA_SPECS: ReadonlyArray<FhaQuerySpec> = [
  {
    sectionNumber: "1.10",
    queryText:
      "1.10 FHA Design Manual accessible primary use entrance common use entrance",
  },
  {
    sectionNumber: "1.3",
    queryText:
      "1.3 FHA accessible building entrance on an accessible route requirement",
  },
  {
    sectionNumber: "3.3",
    queryText: "3.3 FHA Design Manual usable doors requirement",
  },
  {
    sectionNumber: "6.11",
    queryText:
      "6.11 FHA Design Manual floor-mounted grab bar reinforced walls",
  },
  {
    sectionNumber: "7.33",
    queryText:
      "7.33 FHA Design Manual usable kitchens and bathrooms part B usable bathrooms",
  },
  {
    sectionNumber: "1.2",
    queryText:
      "1.2 FHA Design Manual definitions from the Fair Housing Accessibility Guidelines",
  },
];

function expectedDid(sectionNumber: string): string {
  const editionSlug = slugify(FHA_DESIGN_MANUAL_EDITION_LABEL);
  const localId = `${FEDERAL_ACCESSIBILITY_TENANT}/${editionSlug}/${slugify(
    normalizeSectionLabel(sectionNumber),
  )}`;
  return buildAtomDid("code-section", localId).raw;
}

export function buildFhaDesignManualCuratedQueries(): ReadonlyArray<CuratedQuery> {
  return FHA_SPECS.map<CuratedQuery>((spec, i) => ({
    queryId: `fha-design-manual-${String(i + 1).padStart(3, "0")}`,
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
