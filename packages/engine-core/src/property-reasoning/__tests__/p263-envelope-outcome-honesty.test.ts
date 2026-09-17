/**
 * P-263 falsifier 3, plus the outcome-kind half of the row's Done:
 *
 *   3. "A writer asked to emit `no-buildable-area` with an 'unzoned' reason
 *      fails a test." — the first two cases below are that failure.
 *   Done: "`unzoned` becomes `not-applicable` with its reason."
 *   Done: "`not onboarded` becomes whatever the current ledger supports" — at
 *      the SOURCE that is a pending derivation, not a zero, because the engine
 *      does not hold the ledger; case 5 asserts it claims nothing more.
 *   Done: "no atom carries `no-buildable-area` with a 'no district' or 'unzoned'
 *      reason" — case 6 walks both cascade cohorts.
 */
import { describe, expect, it } from "vitest";

import {
  buildCascadeEnvelopeDecline,
  NO_DISTRICT_ON_RECORD_REASON,
  UNZONED_NO_DISTRICT_BASIS_REASON,
} from "../cascade-unzoned-envelope-decline.js";
import {
  assertEnvelopeOutcomeIsHonest,
  classifyEnvelopeAbsenceReason,
  EnvelopeOutcomeDishonestError,
} from "../envelope-outcome-honesty.js";

const HAYS_PARCEL = "48209:156346";

function cascadeAtom(situsCity: string | null) {
  return buildCascadeEnvelopeDecline(
    {
      parcelNodeId: HAYS_PARCEL,
      atomDid: `did:hauska:zoning-fact:${HAYS_PARCEL}`,
      situsCity,
    },
    "48209",
    "2026-09-17T00:00:00.000Z",
  );
}

describe("P-263 — a no-buildable-area claim needs a computed zero and a computing reason", () => {
  it("refuses a no-buildable-area outcome carrying an 'unzoned' reason", () => {
    let thrown: unknown;
    try {
      assertEnvelopeOutcomeIsHonest(
        {
          kind: "no-buildable-area",
          reason: UNZONED_NO_DISTRICT_BASIS_REASON,
          // The reason alone disqualifies the kind, even with a zero attached:
          // an unzoned parcel has no ordinance to compute a setback from.
          zero: {
            method: "setback-inset-consumes-ring",
            areaSqFt: 0,
            verifiedBy: `did:hauska:zoning-fact:${HAYS_PARCEL}`,
          },
        },
        { writer: "test-writer", parcelNodeId: HAYS_PARCEL },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvelopeOutcomeDishonestError);
    expect((thrown as EnvelopeOutcomeDishonestError).code).toBe(
      "NO_BUILDABLE_AREA_WITH_ABSENCE_REASON",
    );
    expect(String((thrown as Error).message)).toContain("unzoned");
  });

  it("refuses a no-buildable-area outcome with no computed zero behind it", () => {
    let thrown: unknown;
    try {
      assertEnvelopeOutcomeIsHonest(
        {
          kind: "no-buildable-area",
          reason: "mechanical verify failed: front orientation mismatch",
        } as never,
        { writer: "test-writer" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvelopeOutcomeDishonestError);
    expect((thrown as EnvelopeOutcomeDishonestError).code).toBe(
      "NO_BUILDABLE_AREA_WITHOUT_ZERO",
    );
  });

  it("reads the absence classes off the reasons the producers actually write", () => {
    expect(classifyEnvelopeAbsenceReason(UNZONED_NO_DISTRICT_BASIS_REASON)).toBe("unzoned");
    expect(classifyEnvelopeAbsenceReason(NO_DISTRICT_ON_RECORD_REASON)).toBe("no-district");
    expect(
      classifyEnvelopeAbsenceReason(
        "setbacks consume the lot: front plus rear exceed the ring's own span",
      ),
    ).toBeNull();
  });

  it("accepts a genuine computed zero — the kind is not banned, only unearned", () => {
    expect(() =>
      assertEnvelopeOutcomeIsHonest(
        {
          kind: "no-buildable-area",
          reason: "setbacks consume the lot: front plus rear exceed the ring's own span",
          zero: {
            method: "district-setback-exceeds-lot-span",
            areaSqFt: 0,
            verifiedBy: `did:hauska:setback-rule:${HAYS_PARCEL}`,
          },
        },
        { writer: "test-writer" },
      ),
    ).not.toThrow();
  });
});

describe("P-263 — the cascade's two cohorts stop claiming a computed zero", () => {
  it("an unzoned parcel's envelope is not-applicable, with its own reason", () => {
    expect(cascadeAtom(null).outcome).toEqual({
      kind: "not-applicable",
      reason: UNZONED_NO_DISTRICT_BASIS_REASON,
    });
  });

  it("a not-yet-onboarded parcel is a pending derivation — not a scope statement, not a zero", () => {
    const atom = cascadeAtom("Kyle");
    expect(atom.outcome?.kind).toBe("provisional-front-edge");
    expect(atom.outcome?.reason).toBe(NO_DISTRICT_ON_RECORD_REASON);
  });

  it("neither cohort's outcome is no-buildable-area", () => {
    for (const atom of [cascadeAtom(null), cascadeAtom("Kyle")]) {
      expect(atom.outcome?.kind).not.toBe("no-buildable-area");
    }
  });

  it("keeps the decline code and reason the decline always carried on the contract fields", () => {
    // The OUTCOME moved; the contract's own absence vocabulary did not. Readers
    // that classify by absence.kind / warmVerifyDeclineCode (cert-grade's unzoned
    // short-circuit, the depth-warm dual-read) keep matching what they matched.
    const unzoned = cascadeAtom(null);
    expect(unzoned.warmVerifyDeclineCode).toBe("unzoned-no-district-basis");
    expect(unzoned.warmVerifyDecline).toBe(UNZONED_NO_DISTRICT_BASIS_REASON);
    expect(unzoned.absence?.reason).toBe(UNZONED_NO_DISTRICT_BASIS_REASON);
    expect(unzoned.verifiedAbsence?.evaluated).toBe(true);
  });
});
