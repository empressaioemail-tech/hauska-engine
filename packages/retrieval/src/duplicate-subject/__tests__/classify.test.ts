/**
 * EVERY CLASSIFIER IS PROVEN ABLE TO FIRE — DEV_PROCESS 2.2.
 *
 * A gating indicator is tested for its ability to fire BEFORE it is trusted.
 * A flood verdict predicate once silently passed every case for a night
 * because its own safety string matched the writer's help text; this file
 * exists so a zero in any class of the SS-W11 report means "measured zero"
 * and not "never could have been anything else".
 *
 * The negative cases matter as much: `vintage-undecidable` must NOT be
 * reachable when both sides name an edition, and `edition-differs` must NOT be
 * reachable when one side names none.
 */

import { describe, expect, it } from "vitest";

import {
  classifyEntity,
  normalizeValue,
  femaTileCentre,
  approxDistanceMetres,
  tallyPair,
} from "../classify.js";
import { DIVERGENCE_CLASSES, isComparable, isDisagreement } from "../types.js";
import type { GroundTruthReading, StoreReading } from "../types.js";

const reading = (over: Partial<StoreReading> = {}): StoreReading => ({
  present: true,
  value: null,
  edition: null,
  samplePoint: null,
  status: null,
  ...over,
});

const gt = (over: Partial<GroundTruthReading> = {}): GroundTruthReading => ({
  atSamplePointA: null,
  atSamplePointB: null,
  entityZoneSet: [],
  samplePointDistanceM: 0,
  edition: "NFHL_48_20260101",
  ...over,
});

describe("every divergence class can fire", () => {
  it("agree", () => {
    const v = classifyEntity("x", reading({ value: "AE" }), reading({ value: "ae" }), null);
    expect(v.divergence).toBe("agree");
  });

  it("absent-both", () => {
    const v = classifyEntity("x", reading({ value: null }), reading({ value: null }), null);
    expect(v.divergence).toBe("absent-both");
  });

  it("one-sided-a", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE" }),
      reading({ value: null, status: "unavailable" }),
      null,
    );
    expect(v.divergence).toBe("one-sided-a");
    expect(v.basis).toContain("unavailable");
  });

  it("one-sided-b", () => {
    const v = classifyEntity("x", reading({ value: null }), reading({ value: "X" }), null);
    expect(v.divergence).toBe("one-sided-b");
  });

  it("vintage-undecidable when one side records no edition", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO", edition: null }),
      null,
    );
    expect(v.divergence).toBe("vintage-undecidable");
    expect(v.basis).toContain("no source edition");
  });

  it("genuine-conflict with no ground truth when BOTH sides record an edition", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO", edition: "NFHL_48_20250501" }),
      null,
    );
    expect(v.divergence).toBe("genuine-conflict");
  });

  it("explained-by-sampling-point", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO" }),
      gt({ atSamplePointA: "AE", atSamplePointB: "AO", samplePointDistanceM: 312 }),
    );
    expect(v.divergence).toBe("explained-by-sampling-point");
    expect(v.basis).toContain("312 m apart");
  });

  it("split-subject", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO" }),
      gt({ atSamplePointA: "AE", atSamplePointB: "AE", entityZoneSet: ["AE", "AO", "X"] }),
    );
    expect(v.divergence).toBe("split-subject");
  });

  it("edition-differs when both sides name an edition and truth picks one", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO", edition: "NFHL_48_20250501" }),
      gt({ atSamplePointA: "AE", atSamplePointB: "AE", entityZoneSet: ["AE"] }),
    );
    expect(v.divergence).toBe("edition-differs");
    expect(v.basis).toContain("stale");
  });

  it("genuine-conflict when ground truth matches NEITHER store", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO", edition: "NFHL_48_20250501" }),
      gt({ atSamplePointA: "VE", atSamplePointB: "VE", entityZoneSet: ["VE"] }),
    );
    expect(v.divergence).toBe("genuine-conflict");
  });

  it("covers every declared class", () => {
    // Every class in DIVERGENCE_CLASSES is exercised by a test above. This
    // asserts the list itself has not grown a member with no firing test.
    const exercised = new Set([
      "agree",
      "absent-both",
      "one-sided-a",
      "one-sided-b",
      "vintage-undecidable",
      "genuine-conflict",
      "explained-by-sampling-point",
      "split-subject",
      "edition-differs",
    ]);
    for (const c of DIVERGENCE_CLASSES) expect(exercised.has(c)).toBe(true);
    expect(exercised.size).toBe(DIVERGENCE_CLASSES.length);
  });
});

describe("classes that must NOT fire", () => {
  it("edition-differs is unreachable when one side records no edition", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "NFHL_48_20260101" }),
      reading({ value: "AO", edition: null }),
      gt({ atSamplePointA: "AE", atSamplePointB: "AE", entityZoneSet: ["AE"] }),
    );
    expect(v.divergence).toBe("vintage-undecidable");
    expect(v.divergence).not.toBe("edition-differs");
  });

  it("a sampling-point explanation is not claimed when the points coincide", () => {
    const v = classifyEntity(
      "x",
      reading({ value: "AE", edition: "e1" }),
      reading({ value: "AO", edition: "e2" }),
      gt({ atSamplePointA: "AE", atSamplePointB: "AO", samplePointDistanceM: 0 }),
    );
    expect(v.divergence).not.toBe("explained-by-sampling-point");
  });

  it("zone families are NOT folded together", () => {
    // AE vs A and X vs X500 stay disagreements. Folding them would let the
    // instrument decide which disagreements matter.
    expect(normalizeValue("AE")).not.toBe(normalizeValue("A"));
    expect(normalizeValue("X")).not.toBe(normalizeValue("X500"));
    const v = classifyEntity("x", reading({ value: "X" }), reading({ value: "X500" }), null);
    expect(v.divergence).not.toBe("agree");
  });
});

describe("sample-point reconstruction mirrors the tier2 bake", () => {
  it("quantises to the 0.005-degree tile centre", () => {
    // FEMA_TILE_DEG = 0.005; tileKey/tileCenter both use Math.round(v/deg)*deg
    // then toFixed(5), and the key IS the cell centre. Verbatim from
    // legacy-design-tools artifacts/api-server/src/nodeFacetBakeTier2Cli.ts:286-296.
    expect(femaTileCentre({ lat: 30.1112, lng: -97.3138 })).toEqual({ lat: 30.11, lng: -97.315 });
    expect(femaTileCentre({ lat: 30.114, lng: -97.316 })).toEqual({ lat: 30.115, lng: -97.315 });
  });

  it("two parcels 200 m apart can land in different tiles, and one parcel's tile centre is not its centroid", () => {
    // The whole mechanism in one assertion: the tile is what gets queried.
    const a = femaTileCentre({ lat: 30.1124, lng: -97.3124 });
    const b = femaTileCentre({ lat: 30.114, lng: -97.316 });
    expect(a).not.toEqual(b);
    const centroid = { lat: 30.1124, lng: -97.3124 };
    expect(approxDistanceMetres(centroid, femaTileCentre(centroid))).toBeGreaterThan(50);
  });

  it("the worst case is bounded by the half-diagonal of a tile", () => {
    // Half a tile is 0.0025 deg: ~277 m of latitude and ~240 m of longitude at
    // 30N, so the half-diagonal is ~366 m. A parcel's tier2 flood zone can be
    // decided by a point that far away.
    const worst = approxDistanceMetres(
      { lat: 30.11249, lng: -97.31249 },
      femaTileCentre({ lat: 30.11249, lng: -97.31249 }),
    );
    expect(worst).toBeGreaterThan(300);
    expect(worst).toBeLessThan(400);
  });
});

describe("tally denominators", () => {
  const verdicts = [
    classifyEntity("1", reading({ value: "AE" }), reading({ value: "AE" }), null),
    classifyEntity("2", reading({ value: "AE" }), reading({ value: "AO" }), null),
    classifyEntity("3", reading({ value: "AE" }), reading({ value: null, status: "unavailable" }), null),
    classifyEntity("4", reading({ value: "AE" }), reading({ value: null, status: "unavailable" }), null),
    classifyEntity("5", reading({ value: "AE" }), reading({ value: null, status: "unavailable" }), null),
  ];

  it("the comparable denominator excludes one-sided entities", () => {
    const t = tallyPair({
      subject: "flood-zone",
      storeA: "a",
      storeB: "b",
      countyFips: "48021",
      rosterUnion: 5,
      rowsA: 5,
      rowsB: 5,
      verdicts,
    });
    expect(t.comparable).toBe(2);
    expect(t.disagreementRate).toEqual(
      expect.objectContaining({ numerator: 1, denominator: 2, pct: 50 }),
    );
  });

  it("the roster-wide rate understates by exactly the one-sided share, and says so", () => {
    const t = tallyPair({
      subject: "flood-zone",
      storeA: "a",
      storeB: "b",
      countyFips: "48021",
      rosterUnion: 5,
      rowsA: 5,
      rowsB: 5,
      verdicts,
    });
    // 50% against 20% — the SAME numerator. This 2.5x gap is the shape that
    // made one county's flood divergence look 200x smaller than another's.
    expect(t.disagreementRateOverRoster.pct).toBe(20);
    expect(t.disagreementRateOverRoster.countingRule).toContain("never be quoted alone");
  });

  it("isComparable and isDisagreement agree with the tally", () => {
    expect(isComparable("agree")).toBe(true);
    expect(isComparable("one-sided-a")).toBe(false);
    expect(isDisagreement("agree")).toBe(false);
    expect(isDisagreement("split-subject")).toBe(true);
  });
});
