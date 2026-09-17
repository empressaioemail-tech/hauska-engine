/**
 * P-263 — one place that decides whether a buildable-envelope OUTCOME may
 * assert what it says, and one guard every writer of that outcome calls.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INCIDENT THIS PREVENTS
 * ---------------------------------------------------------------------------------------------
 *
 * 490,185 buildable-envelope atoms in the six Phase-0 counties carried
 * `outcome.kind: "no-buildable-area"`, mostly for reasons that name an ABSENCE
 * of law or of data rather than a computed zero: "unzoned jurisdiction — no
 * district basis for setbacks or envelope" (208,868) and "no district on
 * record — jurisdiction not yet onboarded" (153,775).
 *
 * Two facts made that a served falsehood rather than a naming quibble:
 *
 *   1. `no-buildable-area` means a COMPUTATION found zero buildable square
 *      feet. For those cohorts no derivation was run at all — the writer was a
 *      decline path (`depth-warm/honest-decline-promote.ts`,
 *      `property-reasoning/cascade-unzoned-envelope-decline.ts`) that stamped
 *      the same outcome kind regardless of why it was declining.
 *   2. retrieval's `serving-sweep/vendor/atom-chain-to-facets.ts` turns that
 *      kind into `status: "no-buildable-area"`, `buildableAreaPct: 0` and the
 *      sentence "Setbacks consume the lot — no buildable area remains." — i.e.
 *      the customer was told a setback computation had consumed the lot on
 *      land the engine had never attempted to compute a setback for.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE-QUESTION GATE
 * ---------------------------------------------------------------------------------------------
 *
 *   1. What executes this?   `assertEnvelopeOutcomeIsHonest`, called by every
 *      writer BEFORE it constructs or persists a buildable-envelope outcome
 *      (`emitBuildableEnvelope`, `buildHonestVerifyDeclineAtom`, and the
 *      Tier-1 bake's outcome selection).
 *   2. What triggers it?     A `no-buildable-area` outcome that either carries
 *      no computed zero proof or carries a reason whose text names an absence
 *      of law/data ("unzoned", "no district") instead of a computation.
 *   3. What fails?           It THROWS `ENVELOPE_OUTCOME_DISHONEST`
 *      (`NO_BUILDABLE_AREA_WITHOUT_ZERO`, `NO_BUILDABLE_AREA_WITH_ABSENCE_REASON`,
 *      `ZERO_PROOF_NOT_ZERO`). The caller must not catch it and continue.
 *   4. What bypasses it?     STATED, because the answer is never none:
 *      (a) a hand `UPDATE atoms SET body = ...` outside any writer, which no
 *          in-process guard can see — that is what the P-263 census counts;
 *      (b) atoms already in a store, written before this guard existed (the
 *          490,185); the census measures them and the operator-authorised apply
 *          moves them, this module does not reach backwards;
 *      (c) a writer that never calls it — the compile-time requirement on
 *          `EnvelopeHonestOutcome` closes this for `no-buildable-area`
 *          specifically, since the zero proof cannot be omitted from a value
 *          that type-checks.
 */
import type {
  BuildableEnvelopeZeroProof,
  EnvelopeHonestOutcome,
} from "@hauska-engine/atoms";

/** Raised by {@link assertEnvelopeOutcomeIsHonest}; never caught by a caller. */
export class EnvelopeOutcomeDishonestError extends Error {
  readonly code: EnvelopeOutcomeDishonestyCode;

  constructor(code: EnvelopeOutcomeDishonestyCode, message: string) {
    super(message);
    this.name = "EnvelopeOutcomeDishonestError";
    this.code = code;
  }
}

export type EnvelopeOutcomeDishonestyCode =
  /** A `no-buildable-area` claim with no computed zero behind it. */
  | "NO_BUILDABLE_AREA_WITHOUT_ZERO"
  /** A `no-buildable-area` claim whose REASON names an absence of law or data. */
  | "NO_BUILDABLE_AREA_WITH_ABSENCE_REASON"
  /** A zero proof whose `areaSqFt` is not exactly 0. */
  | "ZERO_PROOF_NOT_ZERO";

/** The reason classes that can never carry a `no-buildable-area` claim. */
export type EnvelopeAbsenceReasonClass = "unzoned" | "no-district";

/**
 * Read an ABSENCE class off a decline reason's own words. Kept as a text
 * classifier rather than an enum because the reasons are written by several
 * producers (the cascade has two codes, the breadth bake has its own wording)
 * and the invariant the operator ruled is about what the atom SAYS, not about
 * which module wrote it.
 */
export function classifyEnvelopeAbsenceReason(
  reason: string,
): EnvelopeAbsenceReasonClass | null {
  const text = reason.toLowerCase();
  if (/\bunzoned\b/.test(text) || /no district basis/.test(text)) {
    return "unzoned";
  }
  if (
    /not yet onboarded/.test(text) ||
    /no district on record/.test(text) ||
    /no district\b/.test(text)
  ) {
    return "no-district";
  }
  return null;
}

/**
 * The honest outcome for a DECLINE (an opinion that was not computed), keyed on
 * the decline code the producer already carries.
 *
 * - An unzoned/unincorporated cohort has no ordinance reaching the parcel, so
 *   the envelope is `not-applicable` with its own reason (the mission's
 *   `unzoned` -> `not-applicable`).
 * - A jurisdiction that IS zoned but is not yet wired ("no district on
 *   record") is a PENDING derivation, not a scope statement and not a zero:
 *   `provisional-front-edge`. The ledger apply decides what the cell becomes;
 *   the engine must not pre-empt that with a claim about buildability.
 * - Every other decline code is a derivation that could not be completed, which
 *   is also pending rather than zero.
 */
export function outcomeForEnvelopeDecline(input: {
  declineCode?: string | null;
  reason: string;
}): Extract<
  EnvelopeHonestOutcome,
  { kind: "not-applicable" } | { kind: "provisional-front-edge" }
> {
  const code = (input.declineCode ?? "").trim();
  if (code === "unzoned-no-district-basis" || code === "no-zoning-stamp") {
    return { kind: "not-applicable", reason: input.reason };
  }
  return { kind: "provisional-front-edge", reason: input.reason };
}

/**
 * The gate. Throws — never returns a boolean the caller may ignore — when an
 * outcome claims a zero it cannot show, or claims one for a reason that names
 * an absence of law/data.
 */
export function assertEnvelopeOutcomeIsHonest(
  outcome: EnvelopeHonestOutcome,
  context: { writer: string; parcelNodeId?: string },
): void {
  if (outcome.kind !== "no-buildable-area") return;

  const where = `${context.writer}${context.parcelNodeId ? ` (${context.parcelNodeId})` : ""}`;

  const absenceClass = classifyEnvelopeAbsenceReason(outcome.reason);
  if (absenceClass) {
    throw new EnvelopeOutcomeDishonestError(
      "NO_BUILDABLE_AREA_WITH_ABSENCE_REASON",
      `${where}: no-buildable-area may not carry a "${absenceClass}" reason ` +
        `("${outcome.reason}") — that reason names an absence of law or data, and the ` +
        `honest outcome for it is not-applicable (unzoned) or provisional-front-edge ` +
        `(not yet wired), never a computed zero (P-263).`,
    );
  }

  const zero = (outcome as { zero?: BuildableEnvelopeZeroProof }).zero;
  if (!zero) {
    throw new EnvelopeOutcomeDishonestError(
      "NO_BUILDABLE_AREA_WITHOUT_ZERO",
      `${where}: no-buildable-area requires a computed, verified zero ` +
        `(BuildableEnvelopeZeroProof) — an outcome with no computation behind it is ` +
        `provisional-front-edge (P-263).`,
    );
  }
  if (zero.areaSqFt !== 0) {
    throw new EnvelopeOutcomeDishonestError(
      "ZERO_PROOF_NOT_ZERO",
      `${where}: no-buildable-area's zero proof reports ${zero.areaSqFt} sq ft — ` +
        `the claim is exactly zero or it is not this kind (P-263).`,
    );
  }
}
