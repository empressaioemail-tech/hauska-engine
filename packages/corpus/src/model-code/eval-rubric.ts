/**
 * Layer 1 eval rubric — ICC model-code base (ADR-019).
 *
 * The rubric a Layer 1 model-code edition is held to before it is
 * declared loaded, plus the curated query set the eval harness scores
 * it against. Authored ahead of the corpus (Code Connect is
 * credential-gated): when an edition is ingested, run the extractor,
 * write the atoms, and run `eval.evaluate()` with `LAYER_1_QUALITY_BAR`
 * and these queries.
 *
 * Mirrors the per-jurisdiction eval pattern (49 §B.4 + the `eval`
 * module). The model-code base is shared substrate under every
 * jurisdiction that adopts an edition, so its bar is the strict
 * 1.0 / 1.0 / 1.0 the Sync 4 / 4.5 / 5 jurisdiction ingests achieved —
 * not the `DEFAULT_QUALITY_BAR` floor (0.9 / 1.0 / 0.95).
 *
 * The curated queries below are a SEED set hand-authored against the
 * first-wave edition of the corpus-edition plan (2021 IRC). Once the
 * live corpus exists, the seed is extended to the full ~50-100-query
 * set per edition through the `curated-queries` LLM-generation +
 * reviewer-zero review flow; the seed pins the entityId scheme and the
 * authoring pattern so that extension is mechanical.
 */

import { buildAtomDid } from "@hauska-engine/atoms";

import { ICC_MODEL_CODE_TENANT } from "../adapters/icc-code-connect/index.js";
import type { CuratedQuery, QualityBarThresholds } from "../eval/index.js";
import { modelCodeSectionEntityId } from "./extractor.js";

/**
 * The Layer 1 quality bar. An edition is declared loaded only when the
 * eval harness scores 1.0 on all three dimensions against the curated
 * set: top-3 retrieval, section-number retrievability, and
 * cross-reference resolution.
 */
export const LAYER_1_QUALITY_BAR: QualityBarThresholds = {
  top3RetrievalMin: 1.0,
  sectionNumRetrievabilityMin: 1.0,
  crossRefResolutionMin: 1.0,
};

/**
 * The `code-section` atom DID for an I-Code section, computed from the
 * model-code extractor's entityId scheme. A curated query's
 * `expectedAtomDid` is built with this, so the rubric and the extractor
 * cannot drift.
 */
export function modelCodeSectionDid(
  editionLabel: string,
  sectionNumber: string,
  tenant: string = ICC_MODEL_CODE_TENANT,
): string {
  return buildAtomDid(
    "code-section",
    modelCodeSectionEntityId(tenant, editionLabel, sectionNumber),
  ).raw;
}

/** One seed query before the boilerplate fields are filled in. */
interface SeedQuerySpec {
  /** Target section number, e.g. "R301". */
  sectionNumber: string;
  /** Reviewer-realistic query text. */
  queryText: string;
}

/**
 * Expand a seed spec list into `CuratedQuery` records for one edition.
 * Authorship is `human-curated` (hand-authored, not LLM-generated);
 * `status` stays `draft` until reviewer-zero promotes the set — the
 * eval harness scores queries regardless of status, so the seed is
 * runnable now.
 */
function buildSeedQueries(
  editionLabel: string,
  queryIdPrefix: string,
  specs: ReadonlyArray<SeedQuerySpec>,
): CuratedQuery[] {
  return specs.map((spec, i) => ({
    queryId: `${queryIdPrefix}-${String(i + 1).padStart(3, "0")}`,
    jurisdictionTenant: ICC_MODEL_CODE_TENANT,
    queryText: spec.queryText,
    expectedAtomDid: modelCodeSectionDid(editionLabel, spec.sectionNumber),
    queryType: "retrieval",
    authorshipSource: "human-curated",
    humanReviewedBy: null,
    humanReviewedAt: null,
    status: "draft",
  }));
}

/** Edition label for the first-wave model-code edition. */
export const IRC_2021_EDITION_LABEL = "2021 International Residential Code";

/**
 * Seed curated query set for the 2021 IRC — the first-wave edition of
 * the corpus-edition plan. Reviewer-realistic retrieval queries; each
 * names the governing section so the known answer is unambiguous.
 */
export const IRC_2021_CURATED_QUERIES: ReadonlyArray<CuratedQuery> =
  buildSeedQueries(IRC_2021_EDITION_LABEL, "irc-2021", [
    {
      sectionNumber: "R301",
      queryText:
        "IRC R301 design criteria for the structural loads a residential building must support",
    },
    {
      sectionNumber: "R301",
      queryText: "IRC Section R301 climatic and geographic design criteria",
    },
    {
      sectionNumber: "R302",
      queryText: "IRC R302 fire-resistant construction of exterior walls",
    },
    {
      sectionNumber: "R302",
      queryText:
        "IRC Section R302 fire-resistant construction requirements for dwelling units",
    },
    {
      sectionNumber: "R202",
      queryText: "IRC R202 definitions of residential code terms",
    },
    {
      sectionNumber: "R201",
      queryText: "IRC R201 general provisions for the code definitions chapter",
    },
  ]);

/**
 * The Layer 1 curated query sets, keyed by edition label. Seeded with
 * the 2021 IRC; the 2021 IBC and IECC sets (corpus-edition plan wave 1)
 * are authored when those editions are ingested, against the same
 * pattern.
 */
export const LAYER_1_CURATED_QUERIES: Record<
  string,
  ReadonlyArray<CuratedQuery>
> = {
  [IRC_2021_EDITION_LABEL]: IRC_2021_CURATED_QUERIES,
};
