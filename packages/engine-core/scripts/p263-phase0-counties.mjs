/**
 * P-342 — the Phase-0 county set, held at the SCRIPT layer on purpose.
 *
 * These literals lived in `src/property-reasoning/envelope-outcome-movement.ts` for one
 * revision and moved here the moment `src/property-reasoning/__tests__/property-reasoning.test.ts`
 * caught them: that suite greps every non-fixture `.ts` module under `src/property-reasoning/`
 * for jurisdiction literals (WDLL 3.8: the reasoning modules are jurisdiction-agnostic, and the
 * six-county set is a Phase-0 rollout fact, not reasoning law).
 *
 * The rule the move encodes: the CLASSIFIER is jurisdiction-agnostic and stays in `src/`; the
 * COUNTIES this lane happens to run against are a run-scope fact and live beside the scripts
 * that scope a run. A seventh county joins by editing this file and nothing else.
 */

/** The six Phase-0 counties (doc_repo `_catalog` six-county set), as fips strings. */
export const SIX_COUNTIES = ["48021", "48055", "48209", "48309", "48453", "48491"];

export const COUNTY_NAME = {
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48209": "Hays",
  "48309": "McLennan",
  "48453": "Travis",
  "48491": "Williamson",
};

/** `48021 Bastrop` — the label every artifact in this lane prints beside a fips. */
export function countyLabel(fips) {
  return `${fips} ${COUNTY_NAME[fips] ?? fips}`;
}

/**
 * The writer identifier P-213's blast-radius guard is keyed on. Part of the override token, so
 * an authorisation issued for the census (which is read-only and takes no cap) can never carry
 * into the apply.
 */
export const ENVELOPE_MOVEMENT_WRITER = "p263-envelope-outcome-apply";
