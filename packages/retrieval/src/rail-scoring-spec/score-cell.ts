/**
 * THE EXECUTABLE HALF OF THE SPEC. Lane SS-W14 (P-47).
 *
 * `specs.ts` says what each rail MEANS. This file turns those rules into a
 * pure function a scorer calls, plus the guards that make a wrong number
 * refuse to publish itself rather than shipping quietly.
 *
 * IT SCORES A CELL FROM MEASUREMENTS THAT ARE HANDED TO IT. It opens no
 * database and issues no query. The measuring is lane SS-W12's capability; the
 * arithmetic and the guards are the contract, and keeping them here means the
 * rules can be tested without a store.
 *
 * THE GUARDS EXIST BECAUSE EACH ONE HAS ALREADY COST SOMEBODY:
 *
 *   over-100                mud scored 209/186 by counting absences inside the
 *                           acquisition fraction. Any ratio above 100% is a
 *                           denominator defect, never a coverage triumph.
 *   orphan-determination    a determination that matches no roster member is
 *                           how a ratio climbs past its denominator in the
 *                           first place. Measured, never assumed zero.
 *   absence-without-basis   the ledger's own CHECK constraint requires
 *                           absence_basis on satisfied-absent. An absence with
 *                           no basis is not an absence.
 *   unmeasured-is-not-zero  an unrun measurement resolves to not-measured, and
 *                           NEVER to 0%. That is the defect class this whole
 *                           programme hunts.
 *   ceiling-must-be-a-set   a cell is out-of-reach only when a SET says so. A
 *                           ceiling COUNT cannot classify a cell, and SS-W9
 *                           had to call 2 rail-corridor cells out-of-reach
 *                           when at most 1 could be, purely because the live
 *                           probe returns a number.
 *   unscorable-rail         roads and easement cannot produce a percentage
 *                           today. Returning one anyway would be the most
 *                           expensive kind of quiet.
 */

import { RAIL_SCORING_SPEC_BY_KEY } from "./specs.js";
import type { CellMeasurement, CellScore, UnscoredRailKey } from "./types.js";

/** Guard tokens. Stable strings, because callers assert on them. */
export const GUARD_OVER_100 = "over-100";
export const GUARD_ORPHAN_DETERMINATION = "orphan-determination";
export const GUARD_ABSENCE_WITHOUT_BASIS = "absence-without-basis";
export const GUARD_NEGATIVE_INPUT = "negative-input";
export const GUARD_UNSCORABLE_RAIL = "unscorable-rail";

/**
 * Counties a rail can be DETERMINED in, as a set. Never a count.
 *
 * A count cannot classify a cell, which is precisely why SS-W9 reported 2
 * rail-corridor cells out-of-reach against a written total of 252 and a
 * ceiling of 253, where at most one of the two could be genuine.
 */
export interface DeterminationCeilingSet {
  railKey: UnscoredRailKey;
  /** Five-digit FIPS. Membership is the ONLY out-of-reach test. */
  counties: ReadonlySet<string>;
  /** How the set was produced, precisely enough to re-run. */
  derivation: string;
  /** When it was produced. A ceiling is a claim about its timestamp. */
  derivedAt: string;
}

export function determinationCeilingSet(input: {
  railKey: UnscoredRailKey;
  counties: Iterable<string>;
  derivation: string;
  derivedAt: string;
}): DeterminationCeilingSet {
  return {
    railKey: input.railKey,
    counties: new Set(input.counties),
    derivation: input.derivation,
    derivedAt: input.derivedAt,
  };
}

/**
 * The inline counting rule that travels with the number, at the point of use.
 * Built from the rail's own spec so it can never drift from it.
 */
export function countingRuleFor(railKey: UnscoredRailKey): string {
  const spec = RAIL_SCORING_SPEC_BY_KEY[railKey];
  return (
    `(covered + established-absent) / denominator, where one unit is ` +
    `${spec.unit}; denominator = ${spec.denominator.rule}` +
    (spec.denominator.exclusionClass
      ? `; excluded and reported separately: ${spec.denominator.exclusionClass}`
      : "")
  );
}

/**
 * Score one cell. Pure. Returns guardViolations rather than throwing, because
 * a scorer run over 254 counties must report every bad cell, not die on the
 * first one, and a caller that ignores the array has made a visible choice.
 */
export function scoreCell(
  measurement: CellMeasurement,
  ceiling: DeterminationCeilingSet,
  absenceBasis: string | null = null,
): CellScore {
  const spec = RAIL_SCORING_SPEC_BY_KEY[measurement.railKey];
  const violations: string[] = [];
  const countingRule = countingRuleFor(measurement.railKey);

  const base = {
    countyFips: measurement.countyFips,
    railKey: measurement.railKey,
    countingRule,
  };

  if (ceiling.railKey !== measurement.railKey) {
    violations.push(
      `ceiling is for rail ${ceiling.railKey} but cell is ${measurement.railKey}`,
    );
  }

  if (
    measurement.covered < 0 ||
    measurement.establishedAbsent < 0 ||
    measurement.denominator < 0 ||
    measurement.orphanDeterminations < 0
  ) {
    violations.push(GUARD_NEGATIVE_INPUT);
  }

  // An unrun measurement is not a zero. This is checked FIRST because every
  // arithmetic branch below would otherwise turn an absent measurement into a
  // confident 0%.
  if (!measurement.measured) {
    return {
      ...base,
      verdict: "not-measured",
      coveragePct: null,
      absenceBasis: null,
      guardViolations: violations,
    };
  }

  // Out-of-reach is decided by SET MEMBERSHIP and nothing else.
  if (!measurement.insideDeterminationCeiling) {
    if (ceiling.counties.has(measurement.countyFips)) {
      violations.push(
        `cell claims out-of-reach but ${measurement.countyFips} IS in the ` +
          `${ceiling.railKey} determination ceiling set`,
      );
    }
    return {
      ...base,
      verdict: "out-of-reach",
      coveragePct: null,
      absenceBasis: null,
      guardViolations: violations,
    };
  }

  if (!ceiling.counties.has(measurement.countyFips)) {
    violations.push(
      `cell claims in-reach but ${measurement.countyFips} is NOT in the ` +
        `${ceiling.railKey} determination ceiling set`,
    );
  }

  // A rail with no persisted denominator cannot produce a percentage. Saying so
  // costs one branch; not saying so costs a published number nobody can defend.
  if (!spec.scorableToday) {
    violations.push(GUARD_UNSCORABLE_RAIL);
    return {
      ...base,
      verdict: "not-measured",
      coveragePct: null,
      absenceBasis: null,
      guardViolations: violations,
    };
  }

  if (measurement.orphanDeterminations > 0) {
    violations.push(
      `${GUARD_ORPHAN_DETERMINATION}: ${measurement.orphanDeterminations} ` +
        `determination(s) match no parcel-node on the county roster`,
    );
  }

  const determined = measurement.covered + measurement.establishedAbsent;

  if (measurement.denominator === 0) {
    // No roster is not zero coverage. It is nothing to measure against.
    return {
      ...base,
      verdict: "not-measured",
      coveragePct: null,
      absenceBasis: null,
      guardViolations: violations,
    };
  }

  const pct = (determined / measurement.denominator) * 100;

  if (pct > 100) {
    violations.push(
      `${GUARD_OVER_100}: ${determined}/${measurement.denominator} = ` +
        `${pct.toFixed(2)}%. Absences are counted BESIDE acquisition, never ` +
        `within it, and the denominator is the full roster`,
    );
  }

  const rounded = Number(pct.toFixed(2));

  if (rounded < spec.thresholdPct) {
    return {
      ...base,
      verdict: "not-yet",
      coveragePct: rounded,
      absenceBasis: null,
      guardViolations: violations,
    };
  }

  // At or above threshold. A cell whose determinations are ENTIRELY absences is
  // satisfied-absent and owes a basis; the ledger's own CHECK constraint
  // enforces the same thing one layer down.
  if (measurement.covered === 0 && measurement.establishedAbsent > 0) {
    if (!absenceBasis || absenceBasis.trim().length === 0) {
      violations.push(GUARD_ABSENCE_WITHOUT_BASIS);
    }
    return {
      ...base,
      verdict: "satisfied-absent",
      coveragePct: rounded,
      absenceBasis: absenceBasis ?? null,
      guardViolations: violations,
    };
  }

  return {
    ...base,
    verdict: "satisfied-present",
    coveragePct: rounded,
    absenceBasis: null,
    guardViolations: violations,
  };
}

/** True when a scored cell is safe to write to the ledger. */
export function isPublishable(score: CellScore): boolean {
  return score.guardViolations.length === 0;
}
