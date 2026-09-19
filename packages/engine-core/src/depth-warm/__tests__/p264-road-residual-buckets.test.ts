/**
 * P-264 — road residual bucket taxonomy.
 *
 * These tests exist to be FALSIFIED, per the dispatch: each one names a way the
 * instrument could lie, and fails if the instrument lies that way. The
 * pre-registered falsifiers are:
 *
 *   F1  an unrecognised failure must land in the unclassified bucket, not be
 *       absorbed into a named class;
 *   F2  a genuine draw (every gate passes) must not increment any failure class;
 *   F3  absent road coverage must not be reported as a road-name or road-class
 *       failure;
 *   F4  a road-NAME failure must be reported as road-name, not as orientation;
 *   F5  a parcel failing road-NAME and road-CLASS must be countable in BOTH.
 *
 * F4 is the regression that motivated this file. The facesAnswer gate is the
 * road-NAME parity gate, but its reason interpolates the resolved street name
 * as a VALUE. A parcel facing "Front Street" therefore put the literal
 * substring "front" into the flattened reason list, and the old prose cascade
 * claimed it as "front-orientation" — a road-name failure silently reported as
 * an orientation failure.
 */
import { describe, expect, it } from "vitest";
import {
  ROAD_NAME_MISMATCH_BUCKET,
  UNCLASSIFIED_VERIFY_FAIL_BUCKET,
  bucketVerifyFailGates,
  bucketVerifyFailReasons,
  verifyFailGateBuckets,
} from "../honest-decline-promote.js";

const R = (reason: string) => ({ reasons: [reason] });
const PASS = { reasons: [] as string[] };

/** Every gate present and passing — the shape of a genuine draw. */
const allPass = {
  geometry: PASS,
  roadClassification: PASS,
  setbackEdgeDistance: PASS,
  frontOrientation: PASS,
  r32PerEdgeInset: PASS,
  facesAnswer: PASS,
};

describe("P-264 road residual buckets", () => {
  it("F2: a genuine draw increments no failure class", () => {
    expect(verifyFailGateBuckets(allPass)).toEqual([]);
  });

  it("F1: an unrecognised failure lands in the unclassified bucket, not a named class", () => {
    // A gate set that carries no reasons at all is the honest shape of "this
    // failure was not attributable" — it must not be absorbed anywhere else.
    expect(bucketVerifyFailGates({})).toBe(UNCLASSIFIED_VERIFY_FAIL_BUCKET);
    // And an unknown-but-nonempty gate is equally unclassified.
    const unknown = { madeUpGate: R("some failure mode this taxonomy has never seen") };
    expect(verifyFailGateBuckets(unknown as never)).toEqual([UNCLASSIFIED_VERIFY_FAIL_BUCKET]);
  });

  it("F3: absent road coverage is not a road-name or road-class failure", () => {
    // No roads resolved means the road gates are honestly non-comparable and
    // produce no reasons (verified in verify-mechanical.ts). Absent input must
    // therefore leave every road bucket untouched.
    const noRoadsComparable = { ...allPass };
    const buckets = verifyFailGateBuckets(noRoadsComparable);
    expect(buckets).not.toContain(ROAD_NAME_MISMATCH_BUCKET);
    expect(buckets).not.toContain("road-classification-mismatch");
    expect(buckets).toEqual([]);
  });

  it("F4: road-NAME failure is road-name, even when the street is named 'Front Street'", () => {
    // The exact reason text emitted at cert-equivalent-gates.ts:151, with a
    // road name that contains the substring "front".
    const faceAnswerReason =
      'facesAnswer: situs "100 MAIN ST" != road "Front Street" ' +
      "(normalized keys 100 main st vs front st)";
    const gates = { ...allPass, facesAnswer: R(faceAnswerReason) };

    expect(bucketVerifyFailGates(gates)).toBe(ROAD_NAME_MISMATCH_BUCKET);
    expect(verifyFailGateBuckets(gates)).toEqual([ROAD_NAME_MISMATCH_BUCKET]);
    expect(bucketVerifyFailGates(gates)).not.toBe("front-orientation");

    // The prose fallback must agree, because its road-name test now runs before
    // its orientation test.
    expect(bucketVerifyFailReasons([faceAnswerReason])).toBe(ROAD_NAME_MISMATCH_BUCKET);
  });

  it("F4b: a genuine orientation failure is still orientation", () => {
    // These are the real frontOrientation reason strings (verify-mechanical.ts).
    // They contain "front" but no road name, and must stay in orientation: the
    // fix must not trade one misclassification for another.
    for (const reason of [
      "fresh front labeling declined: front-orientation-unresolved",
      "fresh labeling produced no front edge",
      "warm candidate has no front edge",
      "front edge index 2 != fresh 0 (basis nearest-road)",
    ]) {
      const gates = { ...allPass, frontOrientation: R(reason) };
      expect(bucketVerifyFailGates(gates), reason).toBe("front-orientation");
    }
  });

  it("F4c: road-NAME wins over orientation when both gates fail", () => {
    const gates = {
      ...allPass,
      frontOrientation: R("fresh labeling produced no front edge"),
      facesAnswer: R('facesAnswer: situs "A" != road "B"'),
    };
    expect(bucketVerifyFailGates(gates)).toBe(ROAD_NAME_MISMATCH_BUCKET);
  });

  it("F5: a parcel failing road-NAME and road-CLASS is counted in both", () => {
    const gates = {
      ...allPass,
      roadClassification: R("edge 1: classification unclassified != OSM tag residential (local)"),
      facesAnswer: R('facesAnswer: situs "100 MAIN ST" != road "Front Street"'),
    };
    const buckets = verifyFailGateBuckets(gates);
    expect(buckets).toContain(ROAD_NAME_MISMATCH_BUCKET);
    expect(buckets).toContain("road-classification-mismatch");
    expect(buckets).toHaveLength(2);
    // The single-bucket convenience prefers road-NAME (table order), but the
    // residual must use the full list or it under-reports road-class.
    expect(bucketVerifyFailGates(gates)).toBe(ROAD_NAME_MISMATCH_BUCKET);
  });

  it("keeps road-name distinct from road-class on the prose path too", () => {
    expect(
      bucketVerifyFailReasons([
        "edge 1: classification unclassified != OSM tag residential (local)",
      ]),
    ).toBe("road-classification-mismatch");
    expect(
      bucketVerifyFailReasons(['facesAnswer: situs "A" != road "B" (normalized keys a vs b)']),
    ).toBe(ROAD_NAME_MISMATCH_BUCKET);
  });

  it("keeps the pre-existing classes mapping where they mapped before", () => {
    expect(bucketVerifyFailReasons(["atom superseded by newer vintage"])).toBe(
      "superseded-prop-id",
    );
    expect(bucketVerifyFailReasons(["inset ring is null"])).toBe("null-inset");
    expect(bucketVerifyFailReasons(["r32 per-edge inset mismatch on edge 2"])).toBe(
      "r32-per-edge-inset",
    );
    expect(bucketVerifyFailReasons(["inset ring is not convex (R5 near-rect gate)"])).toBe(
      "geometry",
    );
    expect(bucketVerifyFailReasons(["no setback row for district SF-1"])).toBe(
      "setback-edge-distance",
    );
  });

  it("documents a real hole in the PROSE path: setback reasons that name no class land unclassified", () => {
    // verify-mechanical.ts:98-99 and :111-112 emit reasons of the form
    //   "edge 3: inset 20ft != expected 10ft for role side"
    //   "edge 3: applied 5ft != labeled 10ft"
    // which contain no "r32", no "setback", no "front", and no "geometry". On the
    // prose path they are unclassifiable and land in the unclassified bucket.
    // This is a pre-existing hole, not one this change introduces, and it is
    // precisely why the batch runner now classifies by GATE: on the gate path the
    // same failure is correctly setback-edge-distance. Asserted so that if anyone
    // later "fixes" the prose by adding another substring, this test forces them
    // to confront the ambiguity rather than paper over it.
    const ambiguous = "edge 3: inset 20ft != expected 10ft for role side";
    expect(bucketVerifyFailReasons([ambiguous])).toBe(UNCLASSIFIED_VERIFY_FAIL_BUCKET);
    // Same reason, correctly attributed once gate identity is available.
    expect(bucketVerifyFailGates({ setbackEdgeDistance: { reasons: [ambiguous] } })).toBe(
      "setback-edge-distance",
    );
  });
});
