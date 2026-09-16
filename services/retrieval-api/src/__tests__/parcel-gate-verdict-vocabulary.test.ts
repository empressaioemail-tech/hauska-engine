import { describe, expect, it } from "vitest";

import {
  ACCEPTED_PARCEL_GATE_VERDICT_KINDS,
  PARCEL_GATE_VERDICT_VOCABULARY_PIN,
  acceptedParcelGateVerdictKinds,
  classifyParcelGateVerdictKind,
  isAcceptedParcelGateVerdictKind,
  type ParcelGateVerdictKind,
} from "../parcel-gate-verdict-vocabulary.js";

/**
 * P-293 remainder — the vocabulary pin's divergence tripwire.
 *
 * `TRANSCRIBED_FROM_FACTORY` below is a HAND transcription of the two
 * migration files, read at hauska-factory main on 2026-09-16 (read-only, via
 * the GitHub API; blob SHAs recorded beside each list so a refresh can tell
 * which file moved). It is deliberately NOT derived from the pin, from a
 * set, or from any helper in the module under test: a test whose expectation
 * comes from the thing it is testing can never fail for the reason it
 * exists, and this pin's whole job is to make an upstream widening a
 * FINDING rather than a silence.
 *
 * The two lists are the CHECK constraint's history: 0009 wrote the original
 * three, 0011a re-wrote it ALONGSIDE them (never replacing them, because
 * live rows still carry a bare 'excluded'). The live constraint is 0011a's.
 */
const FACTORY_READ_AT = {
  repo: "empressaioemail-tech/hauska-factory",
  ref: "main",
  sha: "afdda428811eac1c1fc59055ece36496a0f1685a",
  readOn: "2026-09-16",
};

const TRANSCRIBED_FROM_FACTORY = {
  "migrations/0009_parcel_gate_verdict.sql": {
    blobSha: "c47ea23b1863d3bcc2212c6fc62a26f3721cf89f",
    checkList: ["pass", "refuse", "excluded"],
  },
  "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql": {
    blobSha: "d3c0205d93eb5c19c7652504321eafbe7221fe67",
    checkList: [
      "pass",
      "refuse",
      "excluded",
      "excluded-not-applicable",
      "excluded-mid-cutover",
      "excluded-no-acquisition-path",
    ],
  },
} as const;

/** The CHECK as it stands after 0011a: the second migration's list, verbatim. */
const LIVE_CHECK_LIST: readonly string[] =
  TRANSCRIBED_FROM_FACTORY["migrations/0011a_parcel_gate_verdict_excluded_kinds.sql"]
    .checkList;

/** The three kinds P-201 / A-153 named, transcribed from the writer's own constants. */
const TRANSCRIBED_EXCLUDED_KINDS: readonly string[] = [
  "excluded-not-applicable",
  "excluded-mid-cutover",
  "excluded-no-acquisition-path",
];

describe("parcel_gate_verdict vocabulary pin (P-293 remainder)", () => {
  it("the pin's accepted list EQUALS the live CHECK transcribed from the migrations, in order", () => {
    // Editing the pin without re-reading the migrations fails HERE; editing a
    // migration without refreshing the pin fails here too (the transcription
    // is the test's own copy, so the two can only agree if both were read).
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted).toEqual([...LIVE_CHECK_LIST]);
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted).toHaveLength(6);
  });

  it("0009's original three survive as a STRICT subset (0011a widened, never replaced)", () => {
    const original = TRANSCRIBED_FROM_FACTORY["migrations/0009_parcel_gate_verdict.sql"].checkList;
    const accepted = acceptedParcelGateVerdictKinds();
    for (const kind of original) expect(accepted.has(kind)).toBe(true);
    // Not equal: if 0011a's three ever vanished, the two lists would collapse
    // into one and this assertion is what notices.
    expect(original.length).toBeLessThan(LIVE_CHECK_LIST.length);
  });

  it("the pin stamps the repo, the SHA it was read at, and BOTH migration paths", () => {
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryRepo).toBe(FACTORY_READ_AT.repo);
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factorySha).toBe(FACTORY_READ_AT.sha);
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryPaths).toContain(
      "migrations/0009_parcel_gate_verdict.sql",
    );
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryPaths).toContain(
      "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql",
    );
    // Every stamped path carries its own blob evidence, keyed by the same
    // string, so a refresh cannot half-update the stamp.
    for (const p of PARCEL_GATE_VERDICT_VOCABULARY_PIN.factoryPaths) {
      expect(Object.keys(PARCEL_GATE_VERDICT_VOCABULARY_PIN.upstreamBlobShas)).toContain(p);
    }
  });

  it("the pin's blob SHAs are the ones the list was read from", () => {
    const stamped = PARCEL_GATE_VERDICT_VOCABULARY_PIN.upstreamBlobShas;
    expect(stamped["migrations/0009_parcel_gate_verdict.sql"]).toBe(
      TRANSCRIBED_FROM_FACTORY["migrations/0009_parcel_gate_verdict.sql"].blobSha,
    );
    expect(stamped["migrations/0011a_parcel_gate_verdict_excluded_kinds.sql"]).toBe(
      TRANSCRIBED_FROM_FACTORY["migrations/0011a_parcel_gate_verdict_excluded_kinds.sql"].blobSha,
    );
  });

  it("every accepted kind round-trips through the classifier, and the union is exactly these six", () => {
    for (const kind of LIVE_CHECK_LIST) {
      expect(classifyParcelGateVerdictKind(kind)).toEqual({
        state: "accepted",
        kind: kind as ParcelGateVerdictKind,
      });
      expect(isAcceptedParcelGateVerdictKind(kind)).toBe(true);
    }
    expect(ACCEPTED_PARCEL_GATE_VERDICT_KINDS.size).toBe(LIVE_CHECK_LIST.length);
  });

  it("the excluded-* family is a strict subset of the accepted list and wears the prefix", () => {
    const accepted = acceptedParcelGateVerdictKinds();
    expect([...PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds].sort()).toEqual(
      [...TRANSCRIBED_EXCLUDED_KINDS].sort(),
    );
    for (const kind of TRANSCRIBED_EXCLUDED_KINDS) {
      expect(accepted.has(kind)).toBe(true);
      expect(kind.startsWith("excluded-")).toBe(true);
      expect(kind).not.toBe("excluded");
    }
    expect(PARCEL_GATE_VERDICT_VOCABULARY_PIN.excludedKinds.length).toBeLessThan(
      LIVE_CHECK_LIST.length,
    );
  });

  it("the list is CLOSED, not a prefix match: an invented excluded-* string is UNRECOGNISED", () => {
    // The trap this asserts against: 'excluded' is the prefix with no suffix,
    // so `startsWith("excluded")` would accept both families for the wrong
    // reason and silently admit every future `excluded-anything`.
    for (const invented of [
      "excluded-made-up-state",
      "excluded-",
      "excluded-not-applicable-v2",
      "EXCLUDED",
      "pass ",
      "",
    ]) {
      expect(classifyParcelGateVerdictKind(invented)).toEqual({
        state: "unrecognised",
        raw: invented,
      });
      expect(isAcceptedParcelGateVerdictKind(invented)).toBe(false);
    }
  });
});
