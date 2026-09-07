import { describe, expect, it } from "vitest";

import {
  classifySamplePointContainment,
  countTestableRings,
  deriveFloodSamplePoint,
  emptyContainmentTally,
  floodDeterminationGate,
  tallyContainment,
} from "../flood-hazard-fact/containment.js";
import { geometryCentroid } from "../flood-hazard-fact/geo.js";

/**
 * A C-shaped (concave) parcel. Its outer ring wraps around an open mouth on the
 * east side, and the arithmetic mean of its vertices lands in that mouth —
 * OUTSIDE the parcel. This is the flag-lot / crescent shape the check exists
 * for, and it is what a real writer run produces because
 * `geometryCentroid` is a vertex mean, not a point on surface.
 */
const C_SHAPED_PARCEL = {
  type: "Polygon",
  coordinates: [
    [
      [-97.4, 30.1],
      [-97.3, 30.1],
      [-97.3, 30.11],
      [-97.39, 30.11],
      [-97.39, 30.14],
      [-97.3, 30.14],
      [-97.3, 30.15],
      [-97.4, 30.15],
      [-97.4, 30.1],
    ],
  ],
};

const SQUARE_PARCEL = {
  type: "Polygon",
  coordinates: [
    [
      [-97.4, 30.1],
      [-97.3, 30.1],
      [-97.3, 30.2],
      [-97.4, 30.2],
      [-97.4, 30.1],
    ],
  ],
};

/** A donut: the point at the geometric middle sits inside the hole. */
const DONUT_PARCEL = {
  type: "Polygon",
  coordinates: [
    [
      [-97.4, 30.1],
      [-97.3, 30.1],
      [-97.3, 30.2],
      [-97.4, 30.2],
      [-97.4, 30.1],
    ],
    [
      [-97.37, 30.13],
      [-97.33, 30.13],
      [-97.33, 30.17],
      [-97.37, 30.17],
      [-97.37, 30.13],
    ],
  ],
};

const TWO_PART_PARCEL = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [-97.4, 30.1],
        [-97.39, 30.1],
        [-97.39, 30.11],
        [-97.4, 30.11],
        [-97.4, 30.1],
      ],
    ],
    [
      [
        [-97.2, 30.3],
        [-97.19, 30.3],
        [-97.19, 30.31],
        [-97.2, 30.31],
        [-97.2, 30.3],
      ],
    ],
  ],
};

describe("containment: the check must be observed FAILING before it is trusted", () => {
  it("FIRES on the real production centroid of a real concave shape", () => {
    // The point under test is produced by the SHIPPING writer function, not by
    // the test. If `geometryCentroid` ever became a point-on-surface, this test
    // would go green for the right reason and the assertion below would need to
    // change with it — which is the point.
    const point = geometryCentroid(C_SHAPED_PARCEL);
    expect(point).not.toBeNull();

    const verdict = classifySamplePointContainment(point, C_SHAPED_PARCEL);
    expect(verdict.state).toBe("not-contained");
    expect(verdict.ringsTested).toBe(1);

    const gate = floodDeterminationGate(verdict, "ring-centroid");
    expect(gate.decision).toBe("refuse");
    expect(gate.reasonCode).toBe("sample-point-outside-parcel");
  });

  it("FIRES on a tier2-shaped sentinel: a tile centre near, but not in, the parcel", () => {
    // 0.005-degree tile centre for the square parcel's neighbourhood. It is a
    // perfectly valid coordinate and passes every presence-shaped check.
    const tileCentre: [number, number] = [-97.2975, 30.2025];
    const verdict = classifySamplePointContainment(tileCentre, SQUARE_PARCEL);
    expect(verdict.state).toBe("not-contained");
    expect(floodDeterminationGate(verdict, "ring-centroid").decision).toBe(
      "refuse",
    );
  });

  it("FIRES on the classic sentinels: (0,0) and NaN", () => {
    const zero = classifySamplePointContainment([0, 0], SQUARE_PARCEL);
    expect(zero.state).toBe("not-contained");

    const nan = classifySamplePointContainment([Number.NaN, 30.15], SQUARE_PARCEL);
    expect(nan.state).toBe("unmeasurable");
    expect(floodDeterminationGate(nan, "ring-centroid").decision).toBe("refuse");
  });

  it("FIRES when the point lands in a hole", () => {
    const point = geometryCentroid(DONUT_PARCEL);
    const verdict = classifySamplePointContainment(point, DONUT_PARCEL);
    expect(verdict.state).toBe("not-contained");
  });
});

describe("containment: the passing case", () => {
  it("passes a convex parcel whose vertex mean is genuinely inside", () => {
    const point = geometryCentroid(SQUARE_PARCEL);
    const verdict = classifySamplePointContainment(point, SQUARE_PARCEL);
    expect(verdict.state).toBe("contained");
    expect(verdict.partIndex).toBe(0);
    expect(floodDeterminationGate(verdict, "ring-centroid").decision).toBe(
      "emit",
    );
  });

  it("tests EVERY MultiPolygon part, not only the first", () => {
    const inSecondPart: [number, number] = [-97.195, 30.305];
    const verdict = classifySamplePointContainment(inSecondPart, TWO_PART_PARCEL);
    expect(verdict.state).toBe("contained");
    expect(verdict.partIndex).toBe(1);
    expect(verdict.ringsTested).toBe(2);
  });

  it("REFUSES a multi-part parcel whose first-part centroid lands between the parts", () => {
    // geometryCentroid takes the FIRST part only, so a two-part parcel whose
    // parts are far apart is fine; the failure mode is a point derived from one
    // shape and asserted about another. Here the point is deliberately placed
    // in the gap between the parts.
    const inTheGap: [number, number] = [-97.3, 30.2];
    const verdict = classifySamplePointContainment(inTheGap, TWO_PART_PARCEL);
    expect(verdict.state).toBe("not-contained");
    expect(verdict.basis).toContain("outside all 2 MultiPolygon parts");
  });
});

describe("containment: unmeasurable is a third state and never collapses", () => {
  it("returns unmeasurable, not not-contained, when there is no ring at all", () => {
    const verdict = classifySamplePointContainment([-97.35, 30.15], null);
    expect(verdict.state).toBe("unmeasurable");
    expect(verdict.ringsTested).toBe(0);
  });

  it("returns unmeasurable for a degenerate ring with fewer than three vertices", () => {
    const degenerate = {
      type: "Polygon",
      coordinates: [
        [
          [-97.4, 30.1],
          [-97.3, 30.1],
        ],
      ],
    };
    expect(countTestableRings(degenerate)).toBe(0);
    expect(
      classifySamplePointContainment([-97.35, 30.1], degenerate).state,
    ).toBe("unmeasurable");
  });

  it("returns unmeasurable for a ring carrying a non-finite vertex", () => {
    const poisoned = {
      type: "Polygon",
      coordinates: [
        [
          [-97.4, 30.1],
          [Number.NaN, 30.1],
          [-97.3, 30.2],
          [-97.4, 30.1],
        ],
      ],
    };
    expect(countTestableRings(poisoned)).toBe(0);
  });

  it("counts only the MultiPolygon parts that are actually testable", () => {
    const halfBroken = {
      type: "MultiPolygon",
      coordinates: [
        TWO_PART_PARCEL.coordinates[0],
        [[[-97.2, 30.3]]],
      ],
    };
    expect(countTestableRings(halfBroken)).toBe(1);
  });
});

describe("the gate: policy over states, separated from the classifier", () => {
  it("refuses an unmeasurable parcel whose point is a bbox centre", () => {
    const verdict = classifySamplePointContainment([-97.35, 30.15], null);
    const gate = floodDeterminationGate(verdict, "bbox-centre");
    expect(gate.decision).toBe("refuse");
    expect(gate.reasonCode).toBe("sample-point-not-tied-to-parcel");
  });

  it("EMITS an unmeasurable parcel whose point is the source's own Point geometry", () => {
    const verdict = classifySamplePointContainment([-97.35, 30.15], {
      type: "Point",
      coordinates: [-97.35, 30.15],
    });
    const gate = floodDeterminationGate(verdict, "point-geometry");
    expect(verdict.state).toBe("unmeasurable");
    expect(gate.decision).toBe("emit");
    expect(gate.reasonCode).toBe("point-geometry-unmeasurable");
  });

  it("refuses when no point could be derived at all", () => {
    const verdict = classifySamplePointContainment(null, SQUARE_PARCEL);
    const gate = floodDeterminationGate(verdict, "none");
    expect(gate.decision).toBe("refuse");
    expect(gate.reasonCode).toBe("no-sample-point");
  });

  it("never emits a not-contained determination under ANY derivation", () => {
    const verdict = classifySamplePointContainment([0, 0], SQUARE_PARCEL);
    for (const d of [
      "ring-centroid",
      "point-geometry",
      "bbox-centre",
      "none",
    ] as const) {
      expect(floodDeterminationGate(verdict, d).decision).toBe("refuse");
    }
  });
});

describe("sample-point derivation is recorded, not inferred", () => {
  it("names ring-centroid and reproduces the shipping centroid exactly", () => {
    const derived = deriveFloodSamplePoint(
      SQUARE_PARCEL,
      { westLng: -97.4, southLat: 30.1, eastLng: -97.3, northLat: 30.2 },
      geometryCentroid,
    );
    expect(derived.derivation).toBe("ring-centroid");
    expect(derived.point).toEqual(geometryCentroid(SQUARE_PARCEL));
  });

  it("names bbox-centre when the ring is unusable, instead of a silent ?? branch", () => {
    const derived = deriveFloodSamplePoint(
      null,
      { westLng: -97.4, southLat: 30.1, eastLng: -97.3, northLat: 30.2 },
      geometryCentroid,
    );
    expect(derived.derivation).toBe("bbox-centre");
    expect(derived.point![0]).toBeCloseTo(-97.35, 10);
    expect(derived.point![1]).toBeCloseTo(30.15, 10);
    expect(derived.basis).toContain("NOT tied to the parcel shape");
  });

  it("names point-geometry when the source publishes a Point", () => {
    const derived = deriveFloodSamplePoint(
      { type: "Point", coordinates: [-97.35, 30.15] },
      null,
      geometryCentroid,
    );
    expect(derived.derivation).toBe("point-geometry");
  });

  it("names none when neither geometry nor a finite bbox exists", () => {
    const derived = deriveFloodSamplePoint(null, null, geometryCentroid);
    expect(derived.derivation).toBe("none");
    expect(derived.point).toBeNull();
  });
});

describe("tally: classes are measured, never derived by subtraction", () => {
  it("keeps the three states and the two decisions summing to the population", () => {
    const tally = emptyContainmentTally();
    const cases: Array<[unknown, ReturnType<typeof deriveFloodSamplePoint>]> = [
      [SQUARE_PARCEL, deriveFloodSamplePoint(SQUARE_PARCEL, null, geometryCentroid)],
      [C_SHAPED_PARCEL, deriveFloodSamplePoint(C_SHAPED_PARCEL, null, geometryCentroid)],
      [
        null,
        deriveFloodSamplePoint(
          null,
          { westLng: -97.4, southLat: 30.1, eastLng: -97.3, northLat: 30.2 },
          geometryCentroid,
        ),
      ],
    ];
    for (const [geometry, sample] of cases) {
      const verdict = classifySamplePointContainment(sample.point, geometry);
      const gate = floodDeterminationGate(verdict, sample.derivation);
      tallyContainment(tally, verdict, sample.derivation, gate);
    }
    expect(tally.contained).toBe(1);
    expect(tally.notContained).toBe(1);
    expect(tally.unmeasurable).toBe(1);
    expect(tally.contained + tally.notContained + tally.unmeasurable).toBe(3);
    expect(tally.emitted + tally.refused).toBe(3);
    expect(tally.emitted).toBe(1);
    expect(tally.refused).toBe(2);
  });
});
