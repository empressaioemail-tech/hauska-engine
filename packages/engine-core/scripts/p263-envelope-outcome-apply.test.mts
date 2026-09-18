/**
 * P-342 — the hermetic suite for the P-263 envelope-outcome APPLY.
 *
 * This file proves every one of the lane's pre-registered falsifiers that does NOT need a store,
 * in BOTH directions where a direction exists (DEV_PROCESS 2.2: a control that cannot fail for
 * the right reason is a defect). The store-shaped falsifiers — the journal holds every
 * before-state, a reversal restores a fixture byte-identically, and the guard notices a
 * mislabelled atom written by hand into a real table — live in
 * `p263-envelope-outcome-apply.integration.test.mts`, which needs a Postgres and skips without one.
 *
 * NOTHING here touches a store. Nothing here writes.
 */
import { describe, expect, it } from "vitest";

import {
  TIER1_STATUS_NOT_A_ZERO_REASON,
  LEGACY_TIER1_NO_BUILDABLE_AREA_REASON,
} from "../src/property-reasoning/bake-from-tier1-snapshot.js";
import {
  classifyEnvelopeOutcomeBucket,
  isHonestZeroOutcome,
  movedOutcomeFor,
  movementFor,
  assertMovable,
} from "../src/property-reasoning/envelope-outcome-movement.js";
import { SIX_COUNTIES } from "./p263-phase0-counties.mjs";
import {
  authorisationTokenFor,
  authorisationValueFor,
  censusDigestOf,
  guardVerdict,
  planCounty,
  postStateVerdict,
  readArg,
  ruling12Verdict,
  hasFlag,
} from "./p263-envelope-outcome-apply";
import {
  BLAST_RADIUS_EXCEEDED,
  BLAST_RADIUS_OVERRIDE_MISMATCH,
  evaluateBlastRadius,
} from "./writer-blast-radius-guard.mjs";

const ZERO_PROOF = { method: "setback-inset-consumes-ring", areaSqFt: 0, verifiedBy: "parcel-ring" };

function row(atomDid, kind, reason, hasZero = false) {
  return { atomDid, kind, reason, hasZero, body: { entityType: "buildable-envelope", outcome: { kind, reason } } };
}

const UNZONED = "unzoned jurisdiction — no district basis for setbacks or envelope";
const NO_DISTRICT = "no district on record — jurisdiction not yet onboarded";
const UNCLASSIFIED =
  "edge 0: R32 0ft != expected 15ft for role front";

describe("P-342 classifier: one function, both directions", () => {
  it("classifies each of the four in-population buckets", () => {
    expect(classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: UNZONED, hasZero: false })).toBe("unzoned");
    expect(classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: NO_DISTRICT, hasZero: false })).toBe("no-district");
    expect(
      classifyEnvelopeOutcomeBucket({
        kind: "no-buildable-area",
        reason: LEGACY_TIER1_NO_BUILDABLE_AREA_REASON,
        hasZero: false,
      }),
    ).toBe("tier1StatusAssertion");
    expect(classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: UNCLASSIFIED, hasZero: false })).toBe("unclassifiedByReason");
  });

  it("excludes an atom that already carries a zero proof, and one that is not this kind", () => {
    // The exclusion arms must fire, or the population would swallow atoms the apply may not move.
    expect(classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: UNZONED, hasZero: true })).toBe("alreadyComputedZero");
    expect(classifyEnvelopeOutcomeBucket({ kind: "buildable", reason: UNZONED, hasZero: false })).toBe("notNoBuildableArea");
    expect(classifyEnvelopeOutcomeBucket({ kind: "provisional-front-edge", reason: NO_DISTRICT, hasZero: false })).toBe("notNoBuildableArea");
    expect(classifyEnvelopeOutcomeBucket({ kind: null, reason: null, hasZero: false })).toBe("notNoBuildableArea");
  });

  it("is not vacuous: the four buckets are all reachable and the classifier never returns one for another's input", () => {
    const seen = new Set([
      classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: UNZONED, hasZero: false }),
      classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: NO_DISTRICT, hasZero: false }),
      classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: LEGACY_TIER1_NO_BUILDABLE_AREA_REASON, hasZero: false }),
      classifyEnvelopeOutcomeBucket({ kind: "no-buildable-area", reason: UNCLASSIFIED, hasZero: false }),
    ]);
    expect(seen.size).toBe(4);
  });
});

describe("P-342 movement: what the apply constructs, and what it refuses to construct", () => {
  it("unzoned becomes not-applicable, keeping the atom's own reason", () => {
    expect(movedOutcomeFor("unzoned", UNZONED)).toEqual({ kind: "not-applicable", reason: UNZONED });
  });

  it("no-district becomes provisional-front-edge, keeping the atom's own reason", () => {
    expect(movedOutcomeFor("no-district", NO_DISTRICT)).toEqual({
      kind: "provisional-front-edge",
      reason: NO_DISTRICT,
    });
  });

  it("the retired Tier-1 literal is REPLACED, not carried: the false claim leaves the record", () => {
    const outcome = movedOutcomeFor("tier1StatusAssertion", LEGACY_TIER1_NO_BUILDABLE_AREA_REASON);
    expect(outcome?.kind).toBe("provisional-front-edge");
    expect(outcome?.reason).toBe(TIER1_STATUS_NOT_A_ZERO_REASON);
    expect(outcome?.reason).not.toBe(LEGACY_TIER1_NO_BUILDABLE_AREA_REASON);
    // And the retired literal itself must not survive anywhere in the new outcome.
    expect(JSON.stringify(outcome)).not.toContain(LEGACY_TIER1_NO_BUILDABLE_AREA_REASON);
  });

  it("moves NOTHING for the unclassifiable cohort (OPS-16 A-215 Ruling 12)", () => {
    expect(movedOutcomeFor("unclassifiedByReason", UNCLASSIFIED)).toBeNull();
    expect(movedOutcomeFor("alreadyComputedZero", UNZONED)).toBeNull();
    expect(movedOutcomeFor("notNoBuildableArea", UNZONED)).toBeNull();
  });

  it("assertMovable THROWS on the unmovable buckets instead of returning a no-op", () => {
    expect(() => assertMovable("unclassifiedByReason", UNCLASSIFIED)).toThrow(/P263_BUCKET_NOT_MOVABLE/);
    expect(() => assertMovable("alreadyComputedZero", UNZONED)).toThrow(/P263_BUCKET_NOT_MOVABLE/);
    expect(assertMovable("unzoned", UNZONED).kind).toBe("not-applicable");
  });

  it("describes the unclassifiable cohort as withheld, never as 'operator ruling needed'", () => {
    expect(movementFor("unclassifiedByReason", UNCLASSIFIED)).toMatch(/withheld/i);
    expect(movementFor("unclassifiedByReason", UNCLASSIFIED)).not.toMatch(/operator ruling needed/i);
  });
});

describe("P-342 surface predicate: isHonestZeroOutcome", () => {
  it("PRINTS only for a zero proof that is exactly zero", () => {
    expect(isHonestZeroOutcome({ kind: "no-buildable-area", reason: UNCLASSIFIED, zero: ZERO_PROOF })).toBe(true);
  });

  it("WITHHOLDS a no-buildable-area with no zero proof — the 30,434's shape", () => {
    expect(isHonestZeroOutcome({ kind: "no-buildable-area", reason: UNCLASSIFIED })).toBe(false);
    expect(isHonestZeroOutcome(movedOutcomeFor("no-district", NO_DISTRICT))).toBe(false);
    expect(isHonestZeroOutcome(movedOutcomeFor("unzoned", UNZONED))).toBe(false);
  });

  it("WITHHOLDS a zero proof that is not zero, and every other kind", () => {
    expect(isHonestZeroOutcome({ kind: "no-buildable-area", zero: { ...ZERO_PROOF, areaSqFt: 12 } })).toBe(false);
    expect(isHonestZeroOutcome({ kind: "buildable", areaSqFt: 0 })).toBe(false);
    expect(isHonestZeroOutcome(null)).toBe(false);
    expect(isHonestZeroOutcome(undefined)).toBe(false);
  });

  it("is not the promotion predicate: an unverified atom WITH a real zero still prints", () => {
    // A zero proof is the claim's own evidence; depth-warm promotion is a different axis.
    expect(isHonestZeroOutcome({ kind: "no-buildable-area", zero: ZERO_PROOF })).toBe(true);
  });
});

describe("P-342 plan: the buckets sum, and only the movable atoms are planned", () => {
  const rows = [
    row("did:48021:1", "no-buildable-area", UNZONED),
    row("did:48021:2", "no-buildable-area", UNZONED),
    row("did:48021:3", "no-buildable-area", NO_DISTRICT),
    row("did:48021:4", "no-buildable-area", LEGACY_TIER1_NO_BUILDABLE_AREA_REASON),
    row("did:48021:5", "no-buildable-area", UNCLASSIFIED),
    row("did:48021:6", "no-buildable-area", UNCLASSIFIED),
    row("did:48021:7", "no-buildable-area", UNZONED, true),
    row("did:48021:8", "buildable", null),
  ];

  it("counts population, every bucket and the sum invariant", () => {
    const plan = planCounty("48021", rows);
    expect(plan.envelopeAtomsInScope).toBe(8);
    expect(plan.population).toBe(6);
    expect(plan.toNotApplicable).toBe(2);
    expect(plan.toPendingDerivation).toBe(2);
    expect(plan.toPendingByTier1Status).toBe(1);
    expect(plan.cannotClassify).toBe(2);
    expect(plan.alreadyComputedZero).toBe(1);
    expect(plan.notNoBuildableArea).toBe(1);
    expect(plan.moves).toBe(4);
    expect(plan.toNotApplicable + plan.toPendingDerivation + plan.cannotClassify).toBe(plan.population);
  });

  it("plans ONLY the movable atoms, in stable order", () => {
    const plan = planCounty("48021", rows);
    expect(plan.movable.map((m) => m.atomDid)).toEqual([
      "did:48021:1",
      "did:48021:2",
      "did:48021:3",
      "did:48021:4",
    ]);
    expect(plan.movable.every((m) => m.movement === "toNotApplicable" || m.movement === "toPendingDerivation")).toBe(true);
    // The unclassifiable pair is on record but NOT in the plan — the apply must not sweep them.
    expect(plan.movable.some((m) => m.reason === UNCLASSIFIED)).toBe(false);
  });

  it("all six Phase-0 counties are accepted and nothing else can be", () => {
    expect(SIX_COUNTIES).toEqual(["48021", "48055", "48209", "48309", "48453", "48491"]);
    for (const fips of SIX_COUNTIES) expect(planCounty(fips, []).countyName).toBeTruthy();
  });
});

describe("P-342 cap (P-213): a missing share refuses, the exact token carries, a stale token does not", () => {
  const plan = planCounty(
    "48021",
    Array.from({ length: 100 }, (_, i) => row(`did:48021:${i}`, "no-buildable-area", UNZONED)),
  );

  it("refuses to run at all without a declared 0 < maxShare < 1 — it never defaults", () => {
    expect(() => evaluateBlastRadius({ writer: "w", scopeKey: "48021", affected: 100, population: 100, maxShare: 0 })).toThrow(/declared 0 < maxShare < 1/);
    expect(() => evaluateBlastRadius({ writer: "w", scopeKey: "48021", affected: 100, population: 100, maxShare: 1 })).toThrow(/declared 0 < maxShare < 1/);
    expect(() => evaluateBlastRadius({ writer: "w", scopeKey: "48021", affected: 100, population: 100, maxShare: undefined })).toThrow(/declared 0 < maxShare < 1/);
  });

  it("a run above the county's share REFUSES and names the exact authorization", () => {
    let caught = null;
    try {
      evaluateBlastRadius({
        writer: "p263-envelope-outcome-apply",
        scopeKey: "48021",
        affected: plan.moves,
        population: plan.envelopeAtomsInScope,
        maxShare: 0.5,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(BLAST_RADIUS_EXCEEDED);
    expect(caught.expectedToken).toBe(authorisationTokenFor(plan));
    expect(authorisationTokenFor(plan)).toBe(
      `BLAST_RADIUS_OVERRIDE=p263-envelope-outcome-apply:48021:100/100`,
    );
    // The paste form and the ENV VALUE differ by exactly the `NAME=` prefix — the guard reads
    // the value, the operator pastes the assignment, and the artifact carries both.
    expect(authorisationValueFor(plan)).toBe(`p263-envelope-outcome-apply:48021:100/100`);
    expect(authorisationTokenFor(plan)).toBe(`BLAST_RADIUS_OVERRIDE=${authorisationValueFor(plan)}`);
  });

  it("the exact authorization lets the same run through", () => {
    const verdict = evaluateBlastRadius({
      writer: "p263-envelope-outcome-apply",
      scopeKey: "48021",
      affected: plan.moves,
      population: plan.envelopeAtomsInScope,
      maxShare: 0.5,
      override: authorisationValueFor(plan),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe("override-authorised");
  });

  it("the PASTED assignment form is NOT the value: pasting it verbatim into the env is MALFORMED", () => {
    // A pure-numeric-prefix-free typo must not read as "no override supplied".
    expect(() =>
      evaluateBlastRadius({
        writer: "p263-envelope-outcome-apply",
        scopeKey: "48021",
        affected: plan.moves,
        population: plan.envelopeAtomsInScope,
        maxShare: 0.5,
        override: authorisationTokenFor(plan),
      }),
    ).toThrow(/must be <writer>:<scopeKey>:<affected>\/<population>/);
  });

  it("a STALE authorization (counts moved) does not carry", () => {
    const stale = `p263-envelope-outcome-apply:48021:99/100`;
    expect(() =>
      evaluateBlastRadius({
        writer: "p263-envelope-outcome-apply",
        scopeKey: "48021",
        affected: plan.moves,
        population: plan.envelopeAtomsInScope,
        maxShare: 0.5,
        override: stale,
      }),
    ).toThrow(/populations moved since/);
    try {
      evaluateBlastRadius({
        writer: "p263-envelope-outcome-apply",
        scopeKey: "48021",
        affected: plan.moves,
        population: plan.envelopeAtomsInScope,
        maxShare: 0.5,
        override: stale,
      });
    } catch (error) {
      expect(error.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    }
  });

  it("a run under its declared cap passes without any authorization", () => {
    const wide = planCounty("48021", [
      ...Array.from({ length: 10 }, (_, i) => row(`did:48021:x${i}`, "no-buildable-area", UNZONED)),
      ...Array.from({ length: 90 }, (_, i) => row(`did:48021:y${i}`, "buildable", null)),
    ]);
    const verdict = evaluateBlastRadius({
      writer: "p263-envelope-outcome-apply",
      scopeKey: "48021",
      affected: wide.moves,
      population: wide.envelopeAtomsInScope,
      maxShare: 0.5,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe("within-threshold");
  });
});

describe("P-342 census pin: a changed population or bucket changes the digest", () => {
  const base = planCounty("48021", [
    row("did:48021:1", "no-buildable-area", UNZONED),
    row("did:48021:2", "no-buildable-area", UNCLASSIFIED),
  ]);

  it("is stable for identical counts", () => {
    const again = planCounty("48021", [
      row("did:48021:1", "no-buildable-area", UNZONED),
      row("did:48021:2", "no-buildable-area", UNCLASSIFIED),
    ]);
    expect(again.censusDigest).toBe(base.censusDigest);
  });

  it("MOVES when a bucket moves, and when the population moves", () => {
    const moved = planCounty("48021", [
      row("did:48021:1", "no-buildable-area", UNZONED),
      row("did:48021:2", "no-buildable-area", UNZONED), // was unclassified
    ]);
    expect(moved.censusDigest).not.toBe(base.censusDigest);
    const fewer = planCounty("48021", [row("did:48021:1", "no-buildable-area", UNZONED)]);
    expect(fewer.censusDigest).not.toBe(base.censusDigest);
    expect(censusDigestOf(fewer)).toBe(fewer.censusDigest);
  });
});

describe("P-342 guard: it fires on a mislabelled atom, and reads zero after a clean movement", () => {
  it("FIRES on a county that still holds a mislabelled atom", () => {
    const plan = planCounty("48021", [row("did:48021:1", "no-buildable-area", UNZONED)]);
    expect(guardVerdict(plan).fires).toBe(true);
    expect(guardVerdict(plan).mislabelledOnRecord).toBe(1);
  });

  it("reads ZERO on a county whose movable atoms have moved and whose unclassified atoms remain", () => {
    const plan = planCounty("48021", [row("did:48021:2", "no-buildable-area", UNCLASSIFIED)]);
    const verdict = guardVerdict(plan);
    expect(verdict.fires).toBe(true); // still a `no-buildable-area` claim on record...
    expect(verdict.byBucket.unzoned).toBe(0);
    expect(verdict.byBucket.noDistrict).toBe(0);
    expect(verdict.byBucket.tier1StatusAssertion).toBe(0);
    // ...but it is the WITHHELD cohort, which the apply must not have swept.
    expect(verdict.byBucket.unclassifiedByReason).toBe(1);
  });

  it("explains WHY P-263's --guard still fires after a clean apply, instead of looking like drift", () => {
    const before = { toNotApplicable: 1, toPendingDerivation: 0, cannotClassify: 6 };
    const clean = postStateVerdict(before, {
      population: 6,
      toNotApplicable: 0,
      toPendingDerivation: 0,
      cannotClassify: 6,
    });
    // The apply's own verdict is green...
    expect(clean.ok).toBe(true);
    // ...while the census guard, which counts the whole population, would still exit non-zero.
    expect(clean.censusGuardWouldFire).toBe(true);
    expect(clean.censusGuardWouldFireBecause).toMatch(/withheld as unverified/);
    expect(clean.withheldPendingP343).toBe(6);
    // A county with no withheld cohort reconciles exactly: census guard green too.
    const bare = postStateVerdict(
      { toNotApplicable: 1, toPendingDerivation: 0, cannotClassify: 0 },
      { population: 0, toNotApplicable: 0, toPendingDerivation: 0, cannotClassify: 0 },
    );
    expect(bare.ok).toBe(true);
    expect(bare.censusGuardWouldFire).toBe(false);
    expect(bare.censusGuardWouldFireBecause).toBeNull();
  });

  it("postStateVerdict passes on the honest post-state and FAILS on both directions of drift", () => {
    const before = { toNotApplicable: 3, toPendingDerivation: 1, cannotClassify: 2 };
    // Correct: movable buckets empty, unclassified unchanged, population == the withheld cohort.
    expect(
      postStateVerdict(before, {
        population: 2,
        toNotApplicable: 0,
        toPendingDerivation: 0,
        cannotClassify: 2,
      }).ok,
    ).toBe(true);
    // Wrong direction 1: a bucket did not move.
    expect(
      postStateVerdict(before, {
        population: 3,
        toNotApplicable: 1,
        toPendingDerivation: 0,
        cannotClassify: 2,
      }).ok,
    ).toBe(false);
    // Wrong direction 2: the unclassifiable cohort was swept (Ruling 12 violated).
    expect(
      postStateVerdict(before, {
        population: 1,
        toNotApplicable: 0,
        toPendingDerivation: 0,
        cannotClassify: 1,
      }).ok,
    ).toBe(false);
  });
});

describe("P-342 CLI arg parsing", () => {
  it("reads both --flag=value and --flag value, and reports absence as null", () => {
    expect(readArg(["--county=48021"], "--county")).toBe("48021");
    expect(readArg(["--county", "48021"], "--county")).toBe("48021");
    expect(readArg([], "--county")).toBeNull();
    expect(readArg(["--county="], "--county")).toBe("");
  });

  it("does not mistake a value for a flag", () => {
    expect(hasFlag(["--apply", "--county=48021"], "--apply")).toBe(true);
    expect(hasFlag(["--county=48021"], "--apply")).toBe(false);
  });
});

/**
 * TASK 4 — Ruling 12 on the axis the SERVING surfaces actually gate on (depth-warm promotion),
 * not the axis the ruling is worded in ("no computed zero"). Both directions are asserted: the
 * verdict must read `withheld-everywhere` for an unpromoted cohort AND change to a finding for a
 * promoted one, or the instrument cannot tell the two states apart and reports a pass for
 * whatever it is handed.
 */
describe("P-342 Task 4: is the withheld cohort actually withheld on every surface?", () => {
  const bodyWith = (promotion) => ({
    entityType: "buildable-envelope",
    outcome: { kind: "no-buildable-area", reason: UNCLASSIFIED },
    ...(promotion === undefined ? {} : { depthWarmPromotion: promotion }),
  });
  const promoted = (atomDid, kind = "no-buildable-area", reason = UNCLASSIFIED) => ({
    atomDid,
    kind,
    reason,
    hasZero: false,
    body: { ...bodyWith("depth-warm-promoted-v1"), outcome: { kind, reason } },
  });
  const unpromoted = (atomDid, kind = "no-buildable-area", reason = UNCLASSIFIED) => ({
    atomDid,
    kind,
    reason,
    hasZero: false,
    body: { ...bodyWith(undefined), outcome: { kind, reason } },
  });

  it("reads promotion off the stored body with the engine's own predicate, citation fallback included", () => {
    // The marker shape `promote.ts` writes.
    expect(planCounty("48021", [promoted("d1")]).populationPromoted).toBe(1);
    // The citation fallback the surfaces share (a marker dropped by an older store/projection).
    const viaCitation = {
      atomDid: "d2",
      kind: "no-buildable-area",
      reason: UNCLASSIFIED,
      hasZero: false,
      body: {
        entityType: "buildable-envelope",
        outcome: { kind: "no-buildable-area", reason: UNCLASSIFIED },
        sourceCitation: "depth-warm-verified (depth-warm-promoted-v1)",
      },
    };
    expect(planCounty("48021", [viaCitation]).populationPromoted).toBe(1);
    // A-183's teardown trap: the field the atom does NOT have must not read as promoted.
    const trap = { ...unpromoted("d3"), body: { ...bodyWith(undefined), depthWarmPromoted: true } };
    expect(planCounty("48021", [trap]).populationPromoted).toBe(0);
    // And the false shape in the other direction: a cold derive is not promoted.
    const cold = { ...unpromoted("d4"), body: { ...bodyWith(undefined), sourceCitation: "regrid derive" } };
    expect(planCounty("48021", [cold]).populationPromoted).toBe(0);
  });

  it("counts the escape set only from the WITHHELD bucket, never from the movable ones", () => {
    const plan = planCounty("48021", [
      promoted("moved-promoted", "no-buildable-area", UNZONED),
      promoted("held-promoted-1"),
      promoted("held-promoted-2"),
      unpromoted("held-plain"),
      unpromoted("moved-plain", "no-buildable-area", NO_DISTRICT),
    ]);
    expect(plan.population).toBe(5);
    expect(plan.cannotClassify).toBe(3);
    // Two of the three withheld atoms are promoted — the number the audit turns on.
    expect(plan.cannotClassifyPromoted).toBe(2);
    expect(plan.cannotClassifyPromotedDids).toEqual(["held-promoted-1", "held-promoted-2"]);
    // The same axis over the whole population: 3 promoted atoms, movable ones included.
    expect(plan.populationPromoted).toBe(3);
  });

  it("caps the DID sample at five so a large cohort cannot inflate an artifact", () => {
    const rows = Array.from({ length: 9 }, (_, i) => promoted(`held-${i}`));
    const plan = planCounty("48021", rows);
    expect(plan.cannotClassifyPromoted).toBe(9);
    expect(plan.cannotClassifyPromotedDids).toHaveLength(5);
  });

  it("verdict: an unpromoted cohort reads `withheld-everywhere` and names the gate, not an assurance", () => {
    const verdict = ruling12Verdict(planCounty("48021", [unpromoted("a"), unpromoted("b")]));
    expect(verdict.withheld).toBe(2);
    expect(verdict.withheldAndPromoted).toBe(0);
    expect(verdict.verdict).toBe("withheld-everywhere");
    expect(verdict.why).toMatch(/unpromoted/);
    // It names the axis it measured rather than claiming the ruling's own words back.
    expect(verdict.surfacesGateOn).toMatch(/NOT on a computed zero proof/);
  });

  it("verdict: ONE promoted member of the cohort turns the pass into a finding that names the branches", () => {
    const verdict = ruling12Verdict(planCounty("48021", [unpromoted("a"), promoted("b")]));
    expect(verdict.withheld).toBe(2);
    expect(verdict.withheldAndPromoted).toBe(1);
    expect(verdict.verdict).toBe("ESCAPES-THE-PROMOTION-GATE");
    expect(verdict.withheldAndPromotedDids).toEqual(["b"]);
    // The finding names WHERE it escapes — a count alone would not be actionable.
    expect(verdict.why).toMatch(/atom-chain-to-facets\.ts/);
    expect(verdict.why).toMatch(/Setbacks consume the lot/);
    expect(verdict.why).toMatch(/P-343/);
  });

  it("the empty case is not a vacuous pass: a county with no withheld cohort reads zero on both sides", () => {
    const verdict = ruling12Verdict(planCounty("48021", [unpromoted("zone-only", "no-buildable-area", UNZONED)]));
    expect(verdict.withheld).toBe(0);
    expect(verdict.withheldAndPromoted).toBe(0);
    // Withheld==0 and escapes==0 is the `withheld-everywhere` string — a reader must not take it
    // as "the cohort was checked and cleared" for a county that has no cohort.
    expect(verdict.verdict).toBe("withheld-everywhere");
    expect(verdict.why).toMatch(/Every one of this county's 0 withheld atoms/);
  });
});
