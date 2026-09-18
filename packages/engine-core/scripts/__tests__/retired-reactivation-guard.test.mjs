/**
 * P-275 tests for the reactivation blast-radius refusal — the dispatch's falsifier 3:
 * "the reactivation refusal fires on a synthetic run above the declared share".
 *
 * These are synthetic runs in the literal sense: a fabricated review + verdict, no store, no
 * county, no network. What they prove is the ORDERING that makes the refusal a control rather
 * than a warning: `planReactivationWrite` throws instead of returning a write plan, so a caller
 * that takes its write lease only when `plan.write` is true cannot have leased before the check.
 *
 * The counterfactual is stated, not exercised: `retired-reactivation-guard.mjs` did not exist on
 * the branch point, so the negative control is that this module's import fails there — i.e. on
 * origin/main there is no call site at all, and `review-retired-parcel-nodes.mjs --apply` proceeds
 * to `takeScopedLease` for however many reactivations the live source confirmed (P-212's run:
 * 56,691 of 57,704 retired rows, 98.25%, with the share never computed anywhere).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BLAST_RADIUS_EXCEEDED,
  BLAST_RADIUS_OVERRIDE_MALFORMED,
  BLAST_RADIUS_OVERRIDE_MISMATCH,
  BLAST_RADIUS_UNMEASURED,
} from "../writer-blast-radius-guard.mjs";
import {
  MAX_REACTIVATION_SHARE,
  REACTIVATION_TRANSITION,
  REACTIVATION_WRITER,
  assertReactivationBlastRadius,
  planReactivationWrite,
  reactivationOverrideFromEnv,
  reactivationOverrideToken,
  reactivationOverrideValue,
} from "../retired-reactivation-guard.mjs";
import {
  AUTHORISATION_ENV_VAR,
  MAX_DESTRUCTIVE_SHARE,
} from "../destructive-write-declaration.mjs";

const COUNTY = "48021";

/** The bare env-var VALUE (what `process.env.DESTRUCTIVE_WRITE_AUTHORISATION` holds, P-328). */
const value = (affected, population) => reactivationOverrideValue(COUNTY, affected, population);
/** The shell-assignment form, which is what a refusal message prints. */
const token = (affected, population) => reactivationOverrideToken(COUNTY, affected, population);

/** A verdict/review pair shaped exactly like the reconcile module's output. */
function syntheticRun({ affected, population }) {
  return {
    countyFips: COUNTY,
    review: { countyFips: COUNTY, priorRetired: population, candidates: [], stillAbsent: 0 },
    verdict: {
      countyFips: COUNTY,
      reactivate: Array.from({ length: affected }, (_, i) => ({
        parcelNodeId: `${COUNTY}:${i}`,
        reactivatedReason: "r",
      })),
      confirmedAbsent: [],
      unmeasured: [],
      stillRetired: [],
    },
  };
}

describe("retired-reactivation-guard: declared number and scope", () => {
  it("reads the program's ONE declared number (P-328), with the transition named", () => {
    expect(MAX_REACTIVATION_SHARE).toBe(MAX_DESTRUCTIVE_SHARE);
    expect(MAX_DESTRUCTIVE_SHARE).toBe(0.5);
    expect(REACTIVATION_TRANSITION).toBe("retired->active");
    expect(REACTIVATION_WRITER).toBe("parcel-node-retired-review-reactivation");
    // The writer id is part of the override token, so an authorization for the RETIREMENT
    // direction can never be replayed here.
    expect(REACTIVATION_WRITER).not.toBe("parcel-node-county-reconcile");
  });

  it("the token names writer, county AND both measured counts", () => {
    expect(value(40, 1013)).toBe("parcel-node-retired-review-reactivation:48021:40/1013");
    expect(token(40, 1013)).toBe(
      `${AUTHORISATION_ENV_VAR}=parcel-node-retired-review-reactivation:48021:40/1013`,
    );
  });

  it("reads the override from the environment as a bare VALUE, and treats blank as absent", () => {
    expect(reactivationOverrideFromEnv({})).toBeNull();
    expect(reactivationOverrideFromEnv({ [AUTHORISATION_ENV_VAR]: "   " })).toBeNull();
    expect(reactivationOverrideFromEnv({ [AUTHORISATION_ENV_VAR]: ` ${value(40, 1013)} ` })).toBe(value(40, 1013));
  });
});

describe("retired-reactivation-guard: the false-positive checks (it must NOT be noise)", () => {
  it("Bastrop's real residual needs no authorization: nothing to reactivate", () => {
    const run = syntheticRun({ affected: 0, population: 1013 });
    const plan = planReactivationWrite({ countyFips: COUNTY, ...run });
    expect(plan).toEqual({ write: false, reason: "nothing to reactivate", affected: 0, population: 1013 });
  });

  it("a repair inside the declared share passes without any override", () => {
    const run = syntheticRun({ affected: 50, population: 1013 }); // 4.94%
    const plan = planReactivationWrite({ countyFips: COUNTY, ...run });
    expect(plan.write).toBe(true);
    expect(plan.blastRadius.basis).toBe("within-threshold");
    expect(plan.blastRadius.share).toBeCloseTo(50 / 1013, 12); // 4.94%, under the program's 0.5 (P-328)
  });

  it("exactly at the declared share passes (the check is > maxShare, not >=)", () => {
    const v = assertReactivationBlastRadius({ countyFips: COUNTY, affected: 50, population: 100 });
    expect(v.basis).toBe("within-threshold");
    expect(v.share).toBe(0.5);
  });

  it("a county with no prior retired population passes under its own basis", () => {
    const plan = planReactivationWrite({ countyFips: COUNTY, ...syntheticRun({ affected: 3, population: 0 }) });
    expect(plan.write).toBe(true);
    expect(plan.blastRadius.basis).toBe("no-population");
  });
});

describe("retired-reactivation-guard: the refusals (falsifier 3)", () => {
  it("A SYNTHETIC RUN ABOVE THE DECLARED SHARE REFUSES -- and returns no write plan", () => {
    // A mass reactivation on the P-212 scale: 56,691 of 57,704 (98.25%).
    const run = syntheticRun({ affected: 56691, population: 57704 });
    let threw = null;
    let plan = null;
    try {
      plan = planReactivationWrite({ countyFips: COUNTY, ...run });
    } catch (err) {
      threw = err;
    }
    expect(threw?.code).toBe(BLAST_RADIUS_EXCEEDED);
    // The load-bearing half: no write plan came back, so a caller that gates its lease on
    // `plan.write` never reached the lease.
    expect(plan).toBeNull();
    expect(threw.share).toBeCloseTo(56691 / 57704, 12);
    expect(threw.expectedToken).toBe(token(56691, 57704));
    // The refusal hands the operator the exact token, with the counts in it.
    expect(threw.message).toContain("NOTHING WAS WRITTEN");
    expect(threw.message).toContain(token(56691, 57704));
    expect(threw.record).toMatchObject({
      writer: REACTIVATION_WRITER,
      scopeKey: COUNTY,
      affected: 56691,
      population: 57704,
      refuseCode: BLAST_RADIUS_EXCEEDED,
    });
  });

  it("a share just above the threshold also refuses -- there is no small-print band", () => {
    expect(() => assertReactivationBlastRadius({ countyFips: COUNTY, affected: 51, population: 100 })).toThrow(
      /BLAST_RADIUS_EXCEEDED|would transition 51 of 100/,
    );
  });

  it("the exact authorization for THIS measured run carries", () => {
    const run = syntheticRun({ affected: 60, population: 100 });
    const plan = planReactivationWrite({
      countyFips: COUNTY,
      ...run,
      override: value(60, 100),
    });
    expect(plan.write).toBe(true);
    expect(plan.blastRadius.basis).toBe("override-authorised");
    expect(plan.blastRadius.override.authorised).toBe(true);
  });

  it("an authorization from a DIFFERENT county does not carry", () => {
    expect(() =>
      assertReactivationBlastRadius({
        countyFips: "48453",
        affected: 60,
        population: 100,
        override: value(60, 100), // 48021's authorization
      }),
    ).toThrow(expect.objectContaining({ code: BLAST_RADIUS_OVERRIDE_MISMATCH }));
  });

  it("an authorization whose counts have MOVED does not carry", () => {
    expect(() =>
      assertReactivationBlastRadius({
        countyFips: COUNTY,
        affected: 61,
        population: 100,
        override: value(60, 100),
      }),
    ).toThrow(expect.objectContaining({ code: BLAST_RADIUS_OVERRIDE_MISMATCH }));
  });

  it("a typo'd override is MALFORMED, never silently read as absent", () => {
    expect(() =>
      assertReactivationBlastRadius({
        countyFips: COUNTY,
        affected: 60,
        population: 1013,
        override: "yes please",
      }),
    ).toThrow(expect.objectContaining({ code: BLAST_RADIUS_OVERRIDE_MALFORMED }));
  });

  it("an unmeasurable population refuses as UNMEASURED rather than guessing", () => {
    expect(() =>
      assertReactivationBlastRadius({ countyFips: COUNTY, affected: 60, population: undefined }),
    ).toThrow(expect.objectContaining({ code: BLAST_RADIUS_UNMEASURED }));
  });
});

describe("retired-reactivation-guard: the CALL SITE in the review CLI", () => {
  const cliSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "review-retired-parcel-nodes.mjs"),
    "utf8",
  );

  it("the CLI calls the guard BEFORE it takes the write lease", () => {
    // Structural, and said so: this is a source-order assertion, not a runtime one. It exists
    // because the whole control is worthless if the guard runs after the lease -- the guard's own
    // semantics are covered above, and this is the only property left that a unit test can hold on
    // to without a store. The behavioural half is asserted above: a refusal RETURNS NO WRITE PLAN.
    const guardAt = cliSource.indexOf("planReactivationWrite({");
    const leaseAt = cliSource.indexOf("takeScopedLease(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(leaseAt);
    // and the write is gated on the plan, not merely preceded by the check
    expect(cliSource).toContain("if (!writePlan.write)");
    expect(cliSource).toContain("override: args.blastRadiusOverride ?? reactivationOverrideFromEnv()");
  });

  it("the CLI never folds `unmeasured` into the absent count", () => {
    expect(cliSource).toContain("summary.unmeasured = verdict.unmeasured.length");
    expect(cliSource).toContain("summary.confirmedAbsent = verdict.confirmedAbsent.length");
    // The retired-share readings must name their denominators rather than being a bare ratio.
    expect(cliSource).toContain("retiredShareOfCountyNodesBefore");
    expect(cliSource).toContain("reactivationShareOfRetiredPopulation");
  });
});
