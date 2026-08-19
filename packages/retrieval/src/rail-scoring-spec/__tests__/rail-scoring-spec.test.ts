/**
 * LIVENESS AND DIVERGENCE TESTS for the six rail measurement specs (SS-W14, P-47).
 *
 * A gating indicator is tested for its ability to FIRE before it is trusted. A
 * test that cannot fail for the right reason is a defect, not a test. Every
 * guard below is asserted to fire on constructed input AND to stay silent on
 * the neighbouring input, because a guard that always fires is as dead as one
 * that never does.
 *
 * The numeric cases are the REAL measurements this lane took on 2026-08-19, so
 * a change to the scoring rules that would have moved a live county's verdict
 * fails here first.
 */

import { describe, expect, it } from "vitest";

import {
  EASEMENT_SPEC,
  FOOTPRINT_SPEC,
  GUARD_ABSENCE_WITHOUT_BASIS,
  GUARD_NEGATIVE_INPUT,
  GUARD_ORPHAN_DETERMINATION,
  GUARD_OVER_100,
  GUARD_UNSCORABLE_RAIL,
  RAIL_CORRIDOR_SPEC,
  RAIL_SCORING_SPECS,
  RAIL_SCORING_SPEC_BY_KEY,
  ROADS_SPEC,
  RRC_PIPELINES_SPEC,
  RRC_WELLS_SPEC,
  UNSCORED_RAIL_KEYS,
  countingRuleFor,
  determinationCeilingSet,
  isPublishable,
  scoreCell,
} from "../index.js";
import type { CellMeasurement, UnscoredRailKey } from "../index.js";

const ALL_254 = Array.from({ length: 254 }, (_, i) =>
  String(48001 + i * 2).padStart(5, "0"),
);

function ceilingFor(railKey: UnscoredRailKey, counties: string[] = ALL_254) {
  return determinationCeilingSet({
    railKey,
    counties,
    derivation: "test fixture",
    derivedAt: "2026-08-19T00:00:00.000Z",
  });
}

function cell(over: Partial<CellMeasurement> = {}): CellMeasurement {
  return {
    countyFips: "48021",
    railKey: "rrc-pipelines",
    covered: 5879,
    establishedAbsent: 56377,
    denominator: 62398,
    orphanDeterminations: 0,
    insideDeterminationCeiling: true,
    measured: true,
    ...over,
  };
}

describe("the spec record itself", () => {
  it("covers exactly the six rails with no ledger row, and no others", () => {
    expect(RAIL_SCORING_SPECS.map((s) => s.railKey).sort()).toEqual(
      [...UNSCORED_RAIL_KEYS].sort(),
    );
    expect(RAIL_SCORING_SPECS).toHaveLength(6);
  });

  it("gives every rail all three state definitions, non-empty", () => {
    for (const spec of RAIL_SCORING_SPECS) {
      expect(spec.coveredDefinition.length).toBeGreaterThan(20);
      expect(spec.establishedAbsenceDefinition.length).toBeGreaterThan(20);
      expect(spec.notYetDefinition.length).toBeGreaterThan(20);
    }
  });

  it("gives every rail a denominator WITH the rule that produced it", () => {
    for (const spec of RAIL_SCORING_SPECS) {
      expect(spec.denominator.rule.length).toBeGreaterThan(20);
      expect(spec.denominator.derivation.length).toBeGreaterThan(20);
      expect(spec.denominator.evidence.length).toBeGreaterThan(20);
    }
  });

  it("gives every rail both ceilings and a re-derived verdict", () => {
    for (const spec of RAIL_SCORING_SPECS) {
      expect(spec.ceiling.acquisitionCeilingRule.length).toBeGreaterThan(20);
      expect(spec.ceiling.determinationCeilingRule.length).toBeGreaterThan(20);
      expect(spec.ceiling.reDerivedVerdict.length).toBeGreaterThan(20);
      expect(spec.ceiling.ledgerPublishesToday.length).toBeGreaterThan(10);
    }
  });

  it("names a blocking gap for every rail it calls unscorable, and none for the rest", () => {
    for (const spec of RAIL_SCORING_SPECS) {
      if (spec.scorableToday) expect(spec.blockingGap).toBe("");
      else expect(spec.blockingGap.length).toBeGreaterThan(40);
    }
    expect(
      RAIL_SCORING_SPECS.filter((s) => !s.scorableToday).map((s) => s.railKey),
    ).toEqual(["roads", "easement"]);
  });

  it("records the two ceilings as DIFFERENT for easement, which is the mud 209/186 shape", () => {
    // Acquisition reach 2, determination reach 254. If a future edit collapses
    // these to one number, easement absences get bounded by a two-county
    // routing table and 252 honest cells vanish.
    expect(EASEMENT_SPEC.ceiling.acquisitionCeilingRule).toContain("TWO");
    expect(EASEMENT_SPEC.ceiling.determinationCeilingRule).toContain("254");
    expect(EASEMENT_SPEC.ceiling.determinationCeilingRule).not.toEqual(
      EASEMENT_SPEC.ceiling.acquisitionCeilingRule,
    );
  });

  it("refuses to inherit the published rrc-wells ceiling of 1", () => {
    expect(RRC_WELLS_SPEC.ceiling.ledgerPublishesToday).toContain(
      "maxCountiesReachable 1",
    );
    expect(RRC_WELLS_SPEC.ceiling.reDerivedVerdict).toContain("254, NOT 1");
  });

  it("flags the three rails whose state is NOT readable from entity_id", () => {
    const notSuffix = RAIL_SCORING_SPECS.filter(
      (s) => s.discriminator !== "entity-id-suffix",
    ).map((s) => s.railKey);
    // Only rrc-wells encodes covered-vs-absent in the key (':none').
    expect(notSuffix.sort()).toEqual(
      ["easement", "footprint", "rail-corridor", "roads", "rrc-pipelines"].sort(),
    );
    expect(RRC_WELLS_SPEC.discriminator).toBe("entity-id-suffix");
  });

  it("names a false-absence shape for every rail that has one", () => {
    // rrc-pipelines and rail-corridor both emit an absence kind that fires on a
    // SOURCE READ FAILURE. Counting those as findings about the world converts
    // an outage into mass absence, one whole county at a time.
    expect(RRC_PIPELINES_SPEC.falseAbsenceShapes.join(" ")).toContain(
      "sourceReadFailed",
    );
    expect(RAIL_CORRIDOR_SPEC.falseAbsenceShapes.join(" ")).toContain(
      "no-rail-coverage",
    );
    expect(FOOTPRINT_SPEC.falseAbsenceShapes.join(" ")).toContain(
      "no usable parcel ring",
    );
    for (const spec of RAIL_SCORING_SPECS) {
      expect(spec.falseAbsenceShapes.length).toBeGreaterThan(0);
    }
  });

  it("keeps roads off the parcel unit", () => {
    // road-node is keyed on the OSM way and is excluded from
    // PARCEL_KEYED_PROPERTY_ENTITY_TYPES. A parcel denominator here would
    // invent a hole for every parcel in Texas.
    expect(ROADS_SPEC.unit).toBe("source-feature");
    expect(ROADS_SPEC.entityIdShape).toBe("<fips>:road:<osmWayId>");
  });
});

describe("countingRuleFor travels with the number", () => {
  it("names the unit and the denominator inline", () => {
    const rule = countingRuleFor("rrc-wells");
    expect(rule).toContain("one unit is parcel");
    expect(rule).toContain("parcel-node");
    expect(rule).toContain("excluded and reported separately");
  });

  it("differs between a parcel rail and a county-hybrid rail", () => {
    expect(countingRuleFor("rrc-wells")).not.toEqual(countingRuleFor("easement"));
  });
});

describe("guard: over-100 fires (the mud 209/186 shape)", () => {
  it("fires when determinations exceed the denominator", () => {
    // Crane 48103 measured live: 5,567 pipeline determinations against 5,553
    // geometryLoaded=true nodes. Scoring against the geometry-true subset only
    // reproduces the defect exactly.
    const score = scoreCell(
      cell({
        countyFips: "48103",
        covered: 2856,
        establishedAbsent: 2711,
        denominator: 5553,
      }),
      ceilingFor("rrc-pipelines", ["48103"]),
    );
    expect(score.coveragePct).toBeCloseTo(100.25, 2);
    expect(score.guardViolations.join(" ")).toContain(GUARD_OVER_100);
    expect(isPublishable(score)).toBe(false);
  });

  it("stays silent on the SAME county scored against the full roster", () => {
    // The adopted rule: denominator is every parcel-node atom, 5,805 for Crane.
    const score = scoreCell(
      cell({
        countyFips: "48103",
        covered: 2856,
        establishedAbsent: 2711,
        denominator: 5805,
      }),
      ceilingFor("rrc-pipelines", ["48103"]),
    );
    expect(score.coveragePct).toBeCloseTo(95.9, 1);
    expect(score.guardViolations).toEqual([]);
    expect(score.verdict).toBe("satisfied-present");
  });
});

describe("guard: orphan determinations are measured, never assumed zero", () => {
  it("fires on a determination with no roster member", () => {
    const score = scoreCell(cell({ orphanDeterminations: 3 }), ceilingFor("rrc-pipelines"));
    expect(score.guardViolations.join(" ")).toContain(GUARD_ORPHAN_DETERMINATION);
  });

  it("stays silent at zero, which is what Bastrop 48021 actually measured", () => {
    const score = scoreCell(cell({ orphanDeterminations: 0 }), ceilingFor("rrc-pipelines"));
    expect(score.guardViolations).toEqual([]);
  });
});

describe("guard: an unrun measurement is not a zero", () => {
  it("returns not-measured with a null pct, never 0", () => {
    const score = scoreCell(cell({ measured: false }), ceilingFor("rrc-pipelines"));
    expect(score.verdict).toBe("not-measured");
    expect(score.coveragePct).toBeNull();
  });

  it("returns not-measured for an empty roster rather than 0%", () => {
    const score = scoreCell(
      cell({ covered: 0, establishedAbsent: 0, denominator: 0 }),
      ceilingFor("rrc-pipelines"),
    );
    expect(score.verdict).toBe("not-measured");
    expect(score.coveragePct).toBeNull();
  });

  it("a genuinely empty but rostered county IS not-yet at 0%, which is a different thing", () => {
    const score = scoreCell(
      cell({ countyFips: "48201", covered: 0, establishedAbsent: 0, denominator: 1523640 }),
      ceilingFor("rrc-pipelines", ["48201"]),
    );
    expect(score.verdict).toBe("not-yet");
    expect(score.coveragePct).toBe(0);
  });
});

describe("guard: out-of-reach is set membership, never a count", () => {
  it("classifies out-of-reach only against the SET", () => {
    const score = scoreCell(
      cell({ countyFips: "48261", insideDeterminationCeiling: false }),
      ceilingFor("rrc-pipelines", ["48021"]),
    );
    expect(score.verdict).toBe("out-of-reach");
    expect(score.coveragePct).toBeNull();
    expect(score.guardViolations).toEqual([]);
  });

  it("catches a cell that claims out-of-reach while sitting INSIDE the set", () => {
    // This is the rail-corridor case: 252 written against a ceiling COUNT of
    // 253, where a count forced 2 cells to out-of-reach and at most 1 could be.
    const score = scoreCell(
      cell({ railKey: "rail-corridor", countyFips: "48021", insideDeterminationCeiling: false }),
      ceilingFor("rail-corridor", ["48021"]),
    );
    expect(score.verdict).toBe("out-of-reach");
    expect(score.guardViolations.join(" ")).toContain("IS in the");
    expect(isPublishable(score)).toBe(false);
  });

  it("catches the reverse: a cell claiming in-reach that the set excludes", () => {
    const score = scoreCell(
      cell({ railKey: "rail-corridor", countyFips: "48999" }),
      ceilingFor("rail-corridor", ["48021"]),
    );
    expect(score.guardViolations.join(" ")).toContain("is NOT in the");
  });

  it("catches a ceiling handed in for the wrong rail", () => {
    const score = scoreCell(cell({ railKey: "rrc-wells" }), ceilingFor("rrc-pipelines"));
    expect(score.guardViolations.join(" ")).toContain("ceiling is for rail");
  });
});

describe("guard: satisfied-absent owes a basis", () => {
  it("fires when every determination is an absence and no basis is given", () => {
    const score = scoreCell(
      cell({ covered: 0, establishedAbsent: 62398, denominator: 62398 }),
      ceilingFor("rrc-pipelines"),
    );
    expect(score.verdict).toBe("satisfied-absent");
    expect(score.guardViolations).toContain(GUARD_ABSENCE_WITHOUT_BASIS);
  });

  it("stays silent when the basis is supplied", () => {
    const score = scoreCell(
      cell({ covered: 0, establishedAbsent: 62398, denominator: 62398 }),
      ceilingFor("rrc-pipelines"),
      "tx_rrc_pipeline read succeeded and no segment falls within the buffer of any parcel",
    );
    expect(score.verdict).toBe("satisfied-absent");
    expect(score.guardViolations).toEqual([]);
    expect(score.absenceBasis).not.toBeNull();
  });

  it("does not demand a basis when even one determination is positive", () => {
    const score = scoreCell(cell({ covered: 1 }), ceilingFor("rrc-pipelines"));
    expect(score.verdict).toBe("satisfied-present");
    expect(score.guardViolations).toEqual([]);
  });
});

describe("guard: an unscorable rail refuses to produce a percentage", () => {
  it("fires for roads, whose denominator is persisted nowhere", () => {
    const score = scoreCell(
      cell({ railKey: "roads", countyFips: "48021", covered: 36802, denominator: 36802, establishedAbsent: 0 }),
      ceilingFor("roads", ["48021"]),
    );
    expect(score.coveragePct).toBeNull();
    expect(score.verdict).toBe("not-measured");
    expect(score.guardViolations).toContain(GUARD_UNSCORABLE_RAIL);
  });

  it("fires for easement, whose family holds zero atoms", () => {
    const score = scoreCell(
      cell({ railKey: "easement", covered: 0, establishedAbsent: 0, denominator: 254 }),
      ceilingFor("easement"),
    );
    expect(score.guardViolations).toContain(GUARD_UNSCORABLE_RAIL);
  });

  it("does NOT fire for the four rails that are scorable today", () => {
    for (const railKey of ["footprint", "rrc-wells", "rrc-pipelines", "rail-corridor"] as const) {
      const score = scoreCell(cell({ railKey }), ceilingFor(railKey));
      expect(score.guardViolations).not.toContain(GUARD_UNSCORABLE_RAIL);
    }
  });
});

describe("guard: negative inputs", () => {
  it("fires on a negative count rather than producing a plausible ratio", () => {
    const score = scoreCell(cell({ covered: -1 }), ceilingFor("rrc-pipelines"));
    expect(score.guardViolations).toContain(GUARD_NEGATIVE_INPUT);
  });
});

describe("divergence: mutating ONE input moves the verdict", () => {
  const base = cell();
  const ceiling = ceilingFor("rrc-pipelines");

  it("threshold is the only thing separating not-yet from satisfied", () => {
    const spec = RAIL_SCORING_SPEC_BY_KEY["rrc-pipelines"];
    const justUnder = scoreCell(
      { ...base, covered: 0, establishedAbsent: Math.floor(base.denominator * 0.89) },
      ceiling,
    );
    const justOver = scoreCell(
      { ...base, covered: 1, establishedAbsent: Math.ceil(base.denominator * 0.95) },
      ceiling,
    );
    expect(spec.thresholdPct).toBe(90);
    expect(justUnder.verdict).toBe("not-yet");
    expect(justOver.verdict).toBe("satisfied-present");
  });

  it("satisfied-present and satisfied-absent must never read the same", () => {
    // One is a claim that the thing IS there. The other is a claim that it is
    // NOT. They carry different obligations and cost different money to fix.
    const present = scoreCell({ ...base, covered: 5879 }, ceiling);
    const absent = scoreCell(
      { ...base, covered: 0, establishedAbsent: base.denominator },
      ceiling,
      "positive determination against a successful source read",
    );
    expect(present.verdict).not.toBe(absent.verdict);
    expect(present.absenceBasis).toBeNull();
    expect(absent.absenceBasis).not.toBeNull();
  });

  it("not-yet and not-measured must never read the same", () => {
    // not-yet is a rostered county with no determinations: run the writer.
    // not-measured is a county the scorer never reached: run the scorer.
    // Different remediations, different prices.
    const notYet = scoreCell(
      { ...base, covered: 0, establishedAbsent: 0 },
      ceiling,
    );
    const notMeasured = scoreCell({ ...base, measured: false }, ceiling);
    expect(notYet.verdict).toBe("not-yet");
    expect(notYet.coveragePct).toBe(0);
    expect(notMeasured.verdict).toBe("not-measured");
    expect(notMeasured.coveragePct).toBeNull();
  });
});

describe("the live 2026-08-19 measurements score the way the spec says", () => {
  it("Harris 48201 rrc-pipelines scores 100.00% satisfied-present", () => {
    const score = scoreCell(
      cell({
        countyFips: "48201",
        covered: 278787,
        establishedAbsent: 1244853,
        denominator: 1523640,
        orphanDeterminations: 0,
      }),
      ceilingFor("rrc-pipelines", ["48201"]),
    );
    expect(score.coveragePct).toBe(100);
    expect(score.verdict).toBe("satisfied-present");
    expect(isPublishable(score)).toBe(true);
  });

  it("Bastrop 48021 rail-corridor scores 99.77% against the parcel-node roster", () => {
    const score = scoreCell(
      cell({
        railKey: "rail-corridor",
        countyFips: "48021",
        covered: 3637,
        establishedAbsent: 58619,
        denominator: 62398,
      }),
      ceilingFor("rail-corridor", ["48021"]),
    );
    expect(score.coveragePct).toBeCloseTo(99.77, 2);
    expect(score.verdict).toBe("satisfied-present");
  });

  it("Wise 48497 footprint scores 100.00% with more absences than presences", () => {
    // 23,799 covered and 24,629 established-absent. A rail can be fully
    // measured and mostly empty, and that is a satisfied cell, not a gap.
    const score = scoreCell(
      cell({
        railKey: "footprint",
        countyFips: "48497",
        covered: 23799,
        establishedAbsent: 24629,
        denominator: 48428,
      }),
      ceilingFor("footprint", ["48497"]),
    );
    expect(score.coveragePct).toBe(100);
    expect(score.verdict).toBe("satisfied-present");
  });

  it("Harris 48201 rrc-wells is not-yet at 0%, and is NOT out-of-reach", () => {
    // The published ceiling of 1 names Harris as the ONLY reachable county.
    // The store says Harris holds zero well atoms and 174 other counties hold
    // 4.3 million. Under the re-derived ceiling of 254, Harris is simply
    // not-yet, and the 173 counties the old ceiling would have excluded are in.
    const score = scoreCell(
      cell({
        railKey: "rrc-wells",
        countyFips: "48201",
        covered: 0,
        establishedAbsent: 0,
        denominator: 1523640,
      }),
      ceilingFor("rrc-wells", ["48201", "48103"]),
    );
    expect(score.verdict).toBe("not-yet");
    expect(score.coveragePct).toBe(0);

    const crane = scoreCell(
      cell({
        railKey: "rrc-wells",
        countyFips: "48103",
        covered: 3728,
        establishedAbsent: 1839,
        denominator: 5805,
      }),
      ceilingFor("rrc-wells", ["48201", "48103"]),
    );
    expect(crane.coveragePct).toBeCloseTo(95.9, 1);
    expect(crane.verdict).toBe("satisfied-present");
  });
});
