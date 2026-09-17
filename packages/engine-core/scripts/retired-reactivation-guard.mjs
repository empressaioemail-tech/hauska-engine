/**
 * P-275: the blast-radius refusal on the REACTIVATION direction (retired -> active).
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A REFUSAL IS NEEDED IN THIS DIRECTION TOO
 * ---------------------------------------------------------------------------------------------
 *
 * `writer-blast-radius-guard.mjs` (P-213) exists because a bad reconcile retired 57,704 of
 * Bastrop's 62,394 parcel-node atoms in one run (92.5 percent) and nothing was looking at the
 * population. Its own header names, as bypass (c), the exact gap this module closes:
 *
 *   "(c) `review-retired-parcel-nodes.mjs`'s reactivation path — the opposite direction
 *        (retired -> active) and out of THIS module's scope (a mass, unwarranted reactivation is a
 *        different failure mode with its own live-corroboration gate, not a 'destructive state'
 *        transition)."
 *
 * The live-corroboration gate IS the substantive control — only a parcel the county's OWN service
 * confirms gets reactivated, so a mass reactivation cannot happen by accident of an undersized
 * plan. But P-212's experience is the argument for a second one: that run reactivated 56,691 of
 * 57,704 retired rows (98.25 percent) in a single invocation and the share was never computed
 * anywhere. If a future live source is mis-registered — Williamson's `PropertyID` for
 * `QuickRefID` is a live-looking example of a field that answers wrongly rather than not at all —
 * the corroboration gate does not constrain the SIZE of what it admits. So the direction that was
 * declared out of scope is now wired to the same control, with its own declared number and its own
 * scope key, rather than to a second threshold convention invented beside it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DECLARED NUMBER AND ITS DENOMINATOR
 * ---------------------------------------------------------------------------------------------
 *
 * `MAX_REACTIVATION_SHARE = 0.05` — the same declared number `write-parcel-node-county.mjs` uses
 * for `MAX_ORPHAN_SHARE`, for the same reason: a batch that moves more than 5 percent of a
 * population in one run is an incident-shaped event and must be authorized knowingly.
 *
 * The DENOMINATOR is the county's retired population the reactivation is drawn from (the review's
 * `priorRetired`), not the county's total nodes and not the candidate count. This follows the
 * guard's own rule: "the population a caller measures is exactly the denominator its own share
 * claim depends on". A county with 1,013 retired rows authorizes at most 50 rows; Bastrop's
 * residual needs no authorization at all, which is the intended outcome.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CONSEQUENCE, STATED OUT LOUD
 * ---------------------------------------------------------------------------------------------
 *
 * Under 0.05, ANY reactivation of more than 5 percent of a county's retired rows refuses and
 * demands the exact measured token. That is deliberate and it makes an authorized mass repair a
 * two-step act: run report-only to read the counts, then re-execute with the token those counts
 * print. The refusal message and the run summary both carry that token, with the counts in it, so
 * the second step is mechanical rather than a hunt.
 *
 * The threshold and override semantics are NOT reimplemented here — `evaluateBlastRadius` is
 * imported and called. Nothing in `writer-blast-radius-guard.mjs` is edited by this module.
 */

import { evaluateBlastRadius, overrideTokenFor } from "./writer-blast-radius-guard.mjs";

/** Stable writer id. Part of the override token, so it cannot drift from an authorization. */
export const REACTIVATION_WRITER = "parcel-node-retired-review-reactivation";

/** Declared share, per writer. See the header for the basis. */
export const MAX_REACTIVATION_SHARE = 0.05;

/**
 * Ascending: retire -> reactivate. A retired row returning to active is checked against how much
 * of the retired population it is reviving.
 */
export const REACTIVATION_TRANSITION = "retired->active";

function scopeFor(countyFips) {
  return String(countyFips);
}

/**
 * The bare override VALUE for one measured run — what `BLAST_RADIUS_OVERRIDE` is set to, and
 * what `evaluateBlastRadius({ override })` expects (it parses the VALUE, not the assignment).
 */
export function reactivationOverrideValue(countyFips, affected, population) {
  return `${REACTIVATION_WRITER}:${scopeFor(countyFips)}:${affected}/${population}`;
}

/** The bare override value a run reads from its environment, or null. */
export function reactivationOverrideFromEnv(env = process.env) {
  const raw = env?.["BLAST_RADIUS_OVERRIDE"];
  return raw === undefined || String(raw).trim() === "" ? null : String(raw).trim();
}

/** The shell-assignment form, for the refusal message an operator re-executes. */
export function reactivationOverrideToken(countyFips, affected, population) {
  return overrideTokenFor(REACTIVATION_WRITER, scopeFor(countyFips), affected, population);
}

/**
 * Throws (`BLAST_RADIUS_EXCEEDED` / `BLAST_RADIUS_OVERRIDE_MISMATCH` / `BLAST_RADIUS_UNMEASURED`)
 * if this reactivation is too large a share of the county's retired population to land
 * unauthorized. Returns the guard's verdict object on every passing basis.
 *
 * `affected`   rows THIS run would move to active — `verdict.reactivate.length`.
 * `population` the county's retired rows the reactivation is drawn from — `review.priorRetired`.
 * `override`   raw `BLAST_RADIUS_OVERRIDE` string, or null.
 */
export function assertReactivationBlastRadius({
  countyFips,
  affected,
  population,
  override = null,
} = {}) {
  return evaluateBlastRadius({
    writer: REACTIVATION_WRITER,
    scopeKey: scopeFor(countyFips),
    affected,
    population,
    maxShare: MAX_REACTIVATION_SHARE,
    override,
  });
}

/**
 * The whole pre-write decision, pure and synchronous: given an already-computed review and verdict,
 * decide whether a write may proceed at all, and refuse BEFORE any lease is taken if it may not.
 *
 * Returns `{ write: false, reason }` when there is nothing to do, and
 * `{ write: true, affected, population, blastRadius }` when the write is authorized — in which
 * case the caller may take the write lease. Throws (propagated from the guard, never caught here)
 * when the share is too large and no valid authorization was supplied: a throw means the caller
 * must not have written anything, and the ordering in the caller is what makes that true.
 */
export function planReactivationWrite({ countyFips, review, verdict, override = null } = {}) {
  const affected = verdict?.reactivate?.length ?? 0;
  const population = review?.priorRetired ?? 0;
  if (affected === 0) {
    return { write: false, reason: "nothing to reactivate", affected: 0, population };
  }
  const blastRadius = assertReactivationBlastRadius({
    countyFips,
    affected,
    population,
    override,
  });
  return { write: true, affected, population, blastRadius };
}
