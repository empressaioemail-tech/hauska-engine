/**
 * P-342 — ONE classifier for the P-263 envelope-outcome movement, shared by the
 * census that measures it and the apply that moves it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------------------------
 *
 * P-263's movement census (`scripts/p263-envelope-outcome-census.mts`) decides which
 * `no-buildable-area` envelope atoms MOVE, to WHICH state, and which it cannot
 * classify. P-342 builds the apply that performs that movement. If the apply
 * re-implemented the census's bucket logic, the two would be two classifiers for one
 * rule — the CTRL-1 shape DEV_PROCESS 2.4 says is caught only by a divergence test, and
 * here the divergence would be a WRITE performed against a classification the
 * instrument that measured it does not agree with. So the classifier lives here, once,
 * and both scripts import it. The alternative the dispatch names — the apply importing
 * the census's own exports — is the same rule but couples a writer to a script's module
 * graph; a `src/` module is the one thing both can import and vitest can test hermetically.
 *
 * ---------------------------------------------------------------------------------------------
 * THE COUNTING RULE (the instrument's contract — it travels with every figure)
 * ---------------------------------------------------------------------------------------------
 *
 *   Population: active `buildable-envelope` atoms whose `parcelNodeId` begins with one of
 *   the six Phase-0 county fips, whose `outcome.kind` is `no-buildable-area`, and which
 *   carry no `zero` proof. `status` is `active` unless the row says otherwise.
 *
 *   Bucket = {@link classifyEnvelopeOutcomeBucket}, the SAME function the writer guard
 *   calls (`envelope-outcome-honesty.ts#classifyEnvelopeAbsenceReason`), so the census,
 *   the apply and the guard cannot disagree about what a reason means:
 *     - "unzoned"     -> `unzoned`              — moves to `not-applicable`
 *     - "no-district" -> `no-district`          — moves to `provisional-front-edge`
 *     - the producer's retired Tier-1 literal -> `tier1StatusAssertion`
 *                                              — moves to `provisional-front-edge`
 *     - null (names neither) -> `unclassifiedByReason` — MOVES NOWHERE
 *   Every atom lands in exactly one bucket, and the buckets sum to the population by
 *   construction.
 *
 *   An atom ALREADY carrying a `zero` proof is excluded from the population and reported
 *   separately as `alreadyComputedZero`: it is not mislabelled, and the apply must not
 *   move it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `unclassifiedByReason` DOES NOT MOVE (OPS-16 A-215 Ruling 12)
 * ---------------------------------------------------------------------------------------------
 *
 * These atoms name a FAILED computation ("edge 0: R32 0ft != expected 15ft for role front")
 * rather than an absence of law or data. That is neither an honest zero nor one of the two
 * classifications P-263 established, so moving them would be the apply inventing a
 * classification the census declined to make. The operator's ruling is that they are
 * WITHHELD AS UNVERIFIED on every surface and never served as the legacy "Setbacks consume
 * the lot" claim; the apply leaves them exactly as they are on record and the surfaces gate
 * them out. Fixing them properly is P-343, not this lane.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE-QUESTION GATE
 * ---------------------------------------------------------------------------------------------
 *
 *   1. What executes this?   `classifyEnvelopeOutcomeBucket` (read side: the census, the
 *      apply's pre/post reads) and `movedOutcomeFor` (write side: the apply's new outcome
 *      for one atom). `isHonestZeroOutcome` is the shared predicate a SURFACE evaluates
 *      before it prints the legacy claim.
 *   2. What triggers it?     A `no-buildable-area` envelope atom read from the store, or a
 *      bucket computed from one.
 *   3. What fails?           `movedOutcomeFor` returns `null` for every bucket the apply
 *      may not move (`alreadyComputedZero`, `notNoBuildableArea`, `unclassifiedByReason`,
 *      unknown) — a caller that writes on `null` is the defect. `assertMovable` throws
 *      instead of returning, so a writer cannot treat a refusal as "nothing to do".
 *   4. What bypasses it?     STATED, because the answer is never none:
 *      (a) a raw Postgres `UPDATE atoms SET body = ...` outside the apply — no in-process
 *          module can see that write, which is the same bypass P-263's honesty guard
 *          names, and the reason the census exists as a recurrence control;
 *      (b) a caller that imports the classifier and then re-derives the movement instead
 *          of calling `movedOutcomeFor` — closed for the apply by its own test
 *          (`p263-envelope-outcome-apply.test.ts` asserts the writer's outcome comes from
 *          this module) but not enforced by the type system;
 *      (c) a surface that prints the claim without calling `isHonestZeroOutcome` — the
 *          map/MCP/PDF surfaces are separate repos and are audited, not compiled, against
 *          this rule (P-342 Task 4).
 */

import type { EnvelopeHonestOutcome } from "@hauska-engine/atoms";

import { LEGACY_TIER1_NO_BUILDABLE_AREA_REASON, TIER1_STATUS_NOT_A_ZERO_REASON } from "./bake-from-tier1-snapshot.js";
import {
  classifyEnvelopeAbsenceReason,
  outcomeForEnvelopeDecline,
} from "./envelope-outcome-honesty.js";

/**
 * The writer identity and the county set are NOT here: `ENVELOPE_MOVEMENT_WRITER`,
 * `SIX_COUNTIES` and `COUNTY_NAME` live at the script layer
 * (`scripts/p263-phase0-counties.mjs`), because which counties a run covers is run scope while
 * this module is jurisdiction-agnostic reasoning law.
 * `src/property-reasoning/__tests__/property-reasoning.test.ts` enforces that split by grep and
 * caught these literals when they were first written here.
 */

/** The decline code that maps an unzoned cohort to `not-applicable` (see `outcomeForEnvelopeDecline`). */
export const UNZONED_DECLINE_CODE = "unzoned-no-district-basis";

/**
 * Read the bucket off ONE atom's stored fields. `kind` and `reason` are the atom's
 * `outcome.kind` and `outcome.reason`; `hasZero` is whether `outcome.zero` is present.
 * Kept as a pure function of those three so a fixture can exercise every branch with no
 * store, and so the store's `coalesce(outcome.reason, absence.reason)` read and a
 * fixture's direct call take the SAME path.
 */
export type EnvelopeOutcomeBucket =
  /** A `no-buildable-area` claim that DOES carry a computed zero — not mislabelled, never moved. */
  | "alreadyComputedZero"
  /** Some other outcome kind — not in this population at all. */
  | "notNoBuildableArea"
  /** Reason names an absence of law ("unzoned"). Moves to `not-applicable`. */
  | "unzoned"
  /** Reason names a jurisdiction not yet wired. Moves to `provisional-front-edge`. */
  | "no-district"
  /** The pre-P-263 Tier-1 bake's own literal: a false zero whose producer this program fixed. Moves. */
  | "tier1StatusAssertion"
  /** A reason that names neither an absence of law/data nor the retired producer literal. MOVES NOWHERE. */
  | "unclassifiedByReason";

export function classifyEnvelopeOutcomeBucket(row: {
  kind: string | null | undefined;
  reason: string | null | undefined;
  hasZero: boolean;
}): EnvelopeOutcomeBucket {
  if (row.hasZero) return "alreadyComputedZero";
  if (row.kind !== "no-buildable-area") return "notNoBuildableArea";
  const absent = classifyEnvelopeAbsenceReason(row.reason ?? "");
  if (absent === "unzoned") return "unzoned";
  if (absent === "no-district") return "no-district";
  /**
   * A third arm the absence classifier cannot see, and the reason the census does not stop
   * at it: `LEGACY_TIER1_NO_BUILDABLE_AREA_REASON` is a producer's own literal, written by
   * exactly one branch (the pre-P-263 Tier-1 bake, which re-asserted an upstream STATUS as
   * its own computed zero). The branch has been fixed, so the cohort is attributable to the
   * fix rather than left in "operator ruling needed". Attribution is by the string the
   * producer exports, never by a literal copied here.
   */
  if (row.reason === LEGACY_TIER1_NO_BUILDABLE_AREA_REASON) return "tier1StatusAssertion";
  return "unclassifiedByReason";
}

/** The two states the population moves to; `null` = this bucket is not moved by the apply. */
export type EnvelopeOutcomeMovement = "toNotApplicable" | "toPendingDerivation" | null;

export function movementOf(bucket: EnvelopeOutcomeBucket): EnvelopeOutcomeMovement {
  switch (bucket) {
    case "unzoned":
      return "toNotApplicable";
    case "no-district":
    case "tier1StatusAssertion":
      return "toPendingDerivation";
    default:
      return null;
  }
}

/** True for the buckets the apply moves. The ONE predicate the apply and its tests share. */
export function isMovedBucket(bucket: EnvelopeOutcomeBucket): boolean {
  return movementOf(bucket) !== null;
}

/**
 * The new OUTCOME BODY for one atom in a moved bucket, or `null` when the apply may not
 * move it. This is the write side: it is the only place a moved outcome is constructed, so
 * the apply cannot invent a classification the classifier did not make.
 *
 * - `unzoned` -> `not-applicable` with the atom's own reason (the ordinance does not reach
 *   the parcel; the reason is a scope statement, so it is kept).
 * - `no-district` -> `provisional-front-edge` with the atom's own reason (the jurisdiction
 *   is zoned but not yet wired; the derivation is pending, not zero).
 * - `tier1StatusAssertion` -> `provisional-front-edge` with the producer's CURRENT honest
 *   reason, not the retired literal: the literal is the false claim itself ("Tier-1 snapshot
 *   status no-buildable-area" re-asserted as our own zero), so leaving it in place while
 *   changing only the kind would move the atom out of the population without removing the
 *   claim from the record.
 * - everything else -> `null`.
 */
export function movedOutcomeFor(
  bucket: EnvelopeOutcomeBucket,
  reason: string | null | undefined,
): EnvelopeHonestOutcome | null {
  const movement = movementOf(bucket);
  if (movement === null) return null;
  if (movement === "toNotApplicable") {
    return outcomeForEnvelopeDecline({
      declineCode: UNZONED_DECLINE_CODE,
      reason: reason ?? "",
    });
  }
  if (bucket === "tier1StatusAssertion") {
    return { kind: "provisional-front-edge", reason: TIER1_STATUS_NOT_A_ZERO_REASON };
  }
  return { kind: "provisional-front-edge", reason: reason ?? "" };
}

/** Throws instead of returning `null`, for a caller that must not treat a refusal as a no-op. */
export function assertMovable(
  bucket: EnvelopeOutcomeBucket,
  reason: string | null | undefined,
): EnvelopeHonestOutcome {
  const outcome = movedOutcomeFor(bucket, reason);
  if (outcome === null) {
    throw new Error(
      `P263_BUCKET_NOT_MOVABLE: bucket ${bucket} is not moved by the apply ` +
        `(only unzoned -> not-applicable, no-district and tier1StatusAssertion -> provisional-front-edge).`,
    );
  }
  return outcome;
}

/** Human-readable movement, per bucket. The census prints this; the apply records it. */
export function movementFor(bucket: EnvelopeOutcomeBucket, reason: string | null | undefined): string {
  if (bucket === "unzoned") {
    const outcome = movedOutcomeFor(bucket, reason);
    const text = outcome && "reason" in outcome ? outcome.reason : "";
    return `${outcome?.kind ?? "not-applicable"} (${text.slice(0, 48)}…)`;
  }
  if (bucket === "no-district") {
    return "provisional-front-edge — pending; the ledger decides the cell";
  }
  if (bucket === "tier1StatusAssertion") {
    return "provisional-front-edge — the branch that wrote this reason now names the upstream status instead of claiming a zero (P-263)";
  }
  if (bucket === "alreadyComputedZero") return "none — already carries a computed zero";
  if (bucket === "notNoBuildableArea") return "none — not this kind";
  return "UNCLASSIFIED — withheld as unverified; not moved (OPS-16 A-215 Ruling 12)";
}

/**
 * THE SURFACE PREDICATE. A `no-buildable-area` claim is honest ONLY when it shows the
 * computation that found the zero: `outcome.zero` present AND `zero.areaSqFt === 0`.
 * This is exactly the predicate the write-side guard enforces (`assertEnvelopeOutcomeIsHonest`)
 * — an atom that passes it can be printed as "Setbacks consume the lot", and one that does
 * not must be withheld as unverified.
 *
 * It is deliberately NOT the depth-warm promotion predicate (`isEnvelopeAtomVerified`,
 * P-249): verification and honesty are two different axes. A `no-buildable-area` atom with
 * no zero proof is dishonest whether or not it was ever promoted, and the 30,434
 * unclassified atoms are the population that proves it — that is why the surface gate is
 * this predicate and not the promotion one.
 */
export function isHonestZeroOutcome(outcome: unknown): boolean {
  if (outcome == null || typeof outcome !== "object") return false;
  const o = outcome as { kind?: unknown; zero?: unknown };
  if (o.kind !== "no-buildable-area") return false;
  const zero = o.zero as { areaSqFt?: unknown } | undefined | null;
  if (zero == null || typeof zero !== "object") return false;
  return zero.areaSqFt === 0;
}

/** The counting rule, verbatim, for any artifact that carries a figure derived from this module. */
export const ENVELOPE_MOVEMENT_COUNTING_RULE = {
  population:
    "active buildable-envelope atoms, parcelNodeId prefix in the county set, outcome.kind = no-buildable-area, no `zero` proof",
  classifier: "src/property-reasoning/envelope-outcome-movement.ts#classifyEnvelopeOutcomeBucket",
  buckets: ["unzoned", "no-district", "tier1StatusAssertion", "unclassifiedByReason"],
  thirdArmCountingRule:
    "`tier1StatusAssertion` is attributed by the producer's own exported reason string (bake-from-tier1-snapshot.ts#LEGACY_TIER1_NO_BUILDABLE_AREA_REASON), not by the absence classifier: it is a false zero whose producer P-263 fixed, so it moves. Only `unclassifiedByReason` is genuinely unclassifiable by this change and is withheld, never moved.",
  excludedAndReportedSeparately: ["alreadyComputedZero", "notNoBuildableArea"],
  sumInvariant:
    "toNotApplicable + toPendingDerivation + cannotClassify == population, per county and overall",
} as const;
