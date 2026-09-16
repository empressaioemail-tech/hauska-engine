/**
 * P-262 fixture gate — the dispatch's falsifiers 1 and 2, run through the REAL
 * pipeline (labelEdgesFromRoads -> warmThenVerify -> checkEnvelopeGroundTruth),
 * not through a hand-rolled inset.
 *
 * WHY THE PIPELINE AND NOT `insetPerEdge` DIRECTLY. Ground truth P2 measures
 * each RAW-ring edge's inset distance to the envelope edge that geometrically
 * corresponds to it. The pipeline's candidate build collapses near-collinear
 * offset notches (`collapseNearCollinearOffsetNotches`) before the envelope is
 * stored, so 48209:97658's two long side lines each come back as ONE envelope
 * edge — which is the shape a raw chord can actually be measured against. A
 * bare `insetPerEdge` call leaves the offset ring's degenerate notch edges in
 * place, each artifact chord finds no parallel envelope edge, and P2 reports
 * "inset 0" for chords no envelope edge spans. That is a property of the
 * measuring frame, not of the labelling under test; the served path is the
 * pipeline, so the pipeline is what this gate asserts (measured: same fixture,
 * bare insetPerEdge -> P2 fails on 4 artifact chords; pipeline -> P2 passes).
 *
 * ROADS ARE REAL. Both fixtures' centerlines were read from the county/OSM
 * services on 2026-09-16 (see fixtures/p262Parcels.ts for the query provenance
 * and the values themselves); nothing here is synthetic.
 */
import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../edgeLabeling.js";
import { groupRingChordsIntoLogicalEdges } from "../ring-logical-edges.js";
import { warmThenVerify } from "../warm-then-verify.js";
import { checkEnvelopeGroundTruth } from "../../geometry/envelope-ground-truth.js";
import type { JurisdictionDescriptor, SetbackTableDescriptor } from "../../property-reasoning/types.js";
import { projectRing, ringAreaSqFt, type Ring } from "../geometry.js";
import type { EdgeLabelDraft, WarmEdgeRole, WarmRoadSource } from "../types.js";
import {
  PARCEL_48209_97658_SAN_MARCOS,
  PARCEL_48453_427599_PFLUGERVILLE,
  ROADS_AROUND_48209_97658,
  ROADS_AROUND_48453_427599,
  SITUS_48209_97658,
  SITUS_48453_427599,
  SETBACKS_SF6_SAN_MARCOS,
} from "../fixtures/p262Parcels.js";
import {
  PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
  PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
  ROADS_AROUND_KNOCKOUT_ROSE,
  SITUS_312_KNOCKOUT_ROSE,
  SITUS_324_KNOCKOUT_ROSE,
} from "../fixtures/p262CurvedFrontage.js";

const DISTRICT = "SF-6";

function sb(value: number) {
  return { value, confidence: 1 };
}

/**
 * The PRE-P-262 labeller's OWN answer for 48209:97658, produced by running
 * origin/main's `edgeLabeling.ts` (commit d88cf65, the lane's declared start
 * commit) against these same fixtures, roads and situs:
 *
 *   git show origin/main:packages/engine-core/src/depth-warm/edgeLabeling.ts \
 *     > <this package>/src/depth-warm/<scratch>.ts      # then label + pipeline it
 *
 * Roles in chord order, front on edge 5 with basis situs-street-match. It is
 * kept here as DATA, not as a second implementation: the test below requires
 * the pipeline's own gates to REFUSE this labelling, so the defect P-262
 * removes is measured — the fix cannot pass by the gates having gone quiet.
 */
const PRE_P262_48209_LABELS: WarmEdgeRole[] = [
  "rear",
  "side",
  "side",
  "side",
  "side_corner",
  "front",
  "side_corner",
  "side",
  "side",
];

/** 48453:427599's pre-P-262 (and post-P-262) roles, in chord order. */
const CONTROL_48453_LABELS: WarmEdgeRole[] = ["side", "front", "side", "rear"];

/**
 * 48453:427599's envelope as drawn by origin/main (d88cf65) through the SAME
 * pipeline call below, in WGS84. The post-P-262 envelope is compared against it
 * at 1e-9 degrees (~0.1 mm) — the control parcel's drawn geometry is not
 * allowed to move at all, which is dispatch falsifier 2.
 */
const CONTROL_48453_ENVELOPE: Ring = [
  [-97.62272851722292, 30.433722669836705],
  [-97.62259812958573, 30.43392948775237],
  [-97.62278229538335, 30.434017145108797],
  [-97.6228945680362, 30.433798445676448],
  [-97.62272851722292, 30.433722669836705],
];

/** The current labeller's labels with the ROLES replaced by a recorded set. */
function withRoles(labels: EdgeLabelDraft[], roles: WarmEdgeRole[]): EdgeLabelDraft[] {
  return labels.map((label, index) => {
    const role = roles[index]!;
    if (role === label.label) return label;
    // A non-front role carries no frontBasis — the vocabulary stays honest.
    const { frontBasis: _frontBasis, ...rest } = label;
    return { ...rest, label: role };
  });
}

async function drawAndGrade(
  parcelRing: Ring,
  roads: ReadonlyArray<WarmRoadSource>,
  situsAddress: string,
  edgeLabels: EdgeLabelDraft[],
) {
  const result = await warmThenVerify({
    parcelNodeId: "fixture",
    district: DISTRICT,
    parcelRing,
    descriptor: descriptor(),
    roads,
    edgeLabels,
    zoningFactAtomDid: "did:hauska:zoning-fact:fixture",
    promote: false,
    situsAddress,
  });
  const groundTruth = result.candidate.insetRing
    ? checkEnvelopeGroundTruth({
        parcelRing,
        envelopeRing: result.candidate.insetRing,
        descriptor: descriptor(),
        district: DISTRICT,
        roads,
        situsAddress,
        miterPointsWgs84: result.candidate.miterPointsWgs84,
      })
    : null;
  return { result, groundTruth };
}

function descriptor(): JurisdictionDescriptor {
  const setbackTable: SetbackTableDescriptor = {
    rows: [
      {
        atom_did: "did:hauska:setback-rule:p262-fixture",
        match_basis: "prefix",
        district_code: DISTRICT,
        front_ft: sb(SETBACKS_SF6_SAN_MARCOS.front_ft),
        side_ft: sb(SETBACKS_SF6_SAN_MARCOS.side_ft),
        rear_ft: sb(SETBACKS_SF6_SAN_MARCOS.rear_ft),
        side_corner_ft: sb(SETBACKS_SF6_SAN_MARCOS.side_corner_ft),
      },
    ],
  };
  return {
    key: "p262-fixture-san-marcos",
    displayName: "P-262 fixture jurisdiction (San Marcos SF-6)",
    jurisdictionTenant: "san-marcos-tx",
    parcelFips: "48209",
    defaultAccessPolicy: "public-free",
    setbackTable,
    sourceAdapter: "p262-fixture-harness",
    sourceUrl: "test://",
  };
}

describe("P-262 — 48209:97658 (nine-edge county ring, SF-6 25/5/20/15)", () => {
  it("labels ONE front, on the situs-named street, and one role per lot line", () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48209_97658_SAN_MARCOS,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: SITUS_48209_97658,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;

    const fronts = labels.edgeLabels.filter((e) => e.label === "front");
    expect(fronts, "falsifier 1: exactly one front").toHaveLength(1);
    // Falsifier: the front comes from the situs-named street matching as-is
    // (609 Sturgeon Dr -> Sturgeon), never from the nearest centerline.
    expect(fronts[0]!.frontBasis).toBe("situs-street-match");
    expect(fronts[0]!.index).toBe(5);

    // Item 2: chords of ONE lot line carry ONE role. The county ring's three
    // collinear runs (2.10+41.98+3.53 m, 3.44+42.11+2.14 m, 5.29+11.50 m) were
    // measured at turns of 0.01-0.03 degrees.
    const roles = labels.edgeLabels.map((e) => e.label);
    expect(roles).toEqual([
      "rear", "rear", // far-end line, 5.29 + 11.50 m
      "side", "side", "side", // north-east side line, 2.10 + 41.98 + 3.53 m
      "front", // Sturgeon frontage, 16.80 m
      "side", "side", "side", // south-west side line, 3.44 + 42.11 + 2.14 m
    ]);
  });

  it("serves a non-empty envelope that passes ground truth P1-P3", async () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48209_97658_SAN_MARCOS,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: SITUS_48209_97658,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;

    const result = await warmThenVerify({
      parcelNodeId: "48209:97658",
      district: DISTRICT,
      parcelRing: PARCEL_48209_97658_SAN_MARCOS,
      descriptor: descriptor(),
      roads: ROADS_AROUND_48209_97658,
      edgeLabels: labels.edgeLabels,
      zoningFactAtomDid: "did:hauska:zoning-fact:48209:97658",
      promote: false,
      situsAddress: SITUS_48209_97658,
    });

    expect(result.candidate.empty, `empty envelope: ${result.candidate.emptyReason}`).toBe(false);
    expect(result.verify.pass, JSON.stringify(result.verify.gates, null, 2)).toBe(true);
    if (result.candidate.empty || !result.candidate.insetRing) return;

    const areaSqFt = ringAreaSqFt(result.candidate.insetRing);
    expect(areaSqFt).toBeGreaterThan(0);
    expect(areaSqFt).toBeLessThan(ringAreaSqFt(PARCEL_48209_97658_SAN_MARCOS));

    const gt = checkEnvelopeGroundTruth({
      parcelRing: PARCEL_48209_97658_SAN_MARCOS,
      envelopeRing: result.candidate.insetRing,
      descriptor: descriptor(),
      district: DISTRICT,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: SITUS_48209_97658,
      miterPointsWgs84: result.candidate.miterPointsWgs84,
    });
    expect(
      gt.pass,
      JSON.stringify(
        {
          failureReason: gt.failureReason,
          p1: gt.p1,
          p2Fails: gt.p2.edges.filter((e) => !e.pass),
          p3: gt.p3,
        },
        null,
        2,
      ),
    ).toBe(true);
  });

  it("the pipeline's own gates REFUSE the pre-P-262 labelling of this parcel", async () => {
    // DEV_PROCESS: a gate is only a gate if it can fire. These are the same two
    // gates the test above now passes, run against the labelling the lane
    // exists to remove — so a future edit that quietly neuters frontOrientation
    // or r32PerEdgeInset fails HERE, and the fix above cannot pass by default.
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48209_97658_SAN_MARCOS,
      roads: ROADS_AROUND_48209_97658,
      situsAddress: SITUS_48209_97658,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;

    const { result, groundTruth } = await drawAndGrade(
      PARCEL_48209_97658_SAN_MARCOS,
      ROADS_AROUND_48209_97658,
      SITUS_48209_97658,
      withRoles(labels.edgeLabels, PRE_P262_48209_LABELS),
    );

    expect(result.candidate.empty).toBe(false);
    expect(result.verify.pass, "the pre-P-262 labelling must NOT verify").toBe(false);
    // The R31 front-orientation gate fires on the per-chord roles (artifact
    // chords reported side_corner, the far rear line split rear/side).
    expect(result.verify.gates.frontOrientation.pass).toBe(false);
    expect(
      result.verify.gates.frontOrientation.reasons.join("\n"),
    ).toMatch(/edge (1|4|6):/);
    // The R32 remeasure fires on the artifact chords: the drawn envelope gives
    // the 2.10 m / 3.44 m chords ~15 ft where their side role calls for 5 ft.
    expect(result.verify.gates.r32PerEdgeInset.pass).toBe(false);
    expect(result.verify.gates.r32PerEdgeInset.reasons.join("\n")).toMatch(/edge (3|7): R32 1[45]\./);

    // And ground truth fails too, on the raw chord frame — the false zero the
    // dispatch names.
    expect(groundTruth, "the pre-P-262 envelope was not even drawn").not.toBeNull();
    expect(groundTruth!.pass).toBe(false);
    expect(groundTruth!.p2.edges.filter((e) => !e.pass).length).toBeGreaterThan(0);
  });
});

describe("P-262 — 48453:427599 (control: four clean corners)", () => {
  it("labels the situs-named front and keeps its own roles", () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48453_427599_PFLUGERVILLE,
      roads: ROADS_AROUND_48453_427599,
      situsAddress: SITUS_48453_427599,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;
    expect(labels.edgeLabels.map((e) => e.label)).toEqual(["side", "front", "side", "rear"]);
  });

  it("serves a non-empty envelope that passes ground truth P1-P3", async () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48453_427599_PFLUGERVILLE,
      roads: ROADS_AROUND_48453_427599,
      situsAddress: SITUS_48453_427599,
    });
    if (!labels.ok) throw new Error(labels.decline);

    const result = await warmThenVerify({
      parcelNodeId: "48453:427599",
      district: DISTRICT,
      parcelRing: PARCEL_48453_427599_PFLUGERVILLE,
      descriptor: descriptor(),
      roads: ROADS_AROUND_48453_427599,
      edgeLabels: labels.edgeLabels,
      zoningFactAtomDid: "did:hauska:zoning-fact:48453:427599",
      promote: false,
      situsAddress: SITUS_48453_427599,
    });
    expect(result.candidate.empty, `empty envelope: ${result.candidate.emptyReason}`).toBe(false);
    expect(result.verify.pass, JSON.stringify(result.verify.gates, null, 2)).toBe(true);
    if (result.candidate.empty || !result.candidate.insetRing) return;

    const gt = checkEnvelopeGroundTruth({
      parcelRing: PARCEL_48453_427599_PFLUGERVILLE,
      envelopeRing: result.candidate.insetRing,
      descriptor: descriptor(),
      district: DISTRICT,
      roads: ROADS_AROUND_48453_427599,
      situsAddress: SITUS_48453_427599,
      miterPointsWgs84: result.candidate.miterPointsWgs84,
    });
    expect(gt.pass, JSON.stringify({ failureReason: gt.failureReason, p2Fails: gt.p2.edges.filter((e) => !e.pass) })).toBe(true);
  });

  it("is BYTE-IDENTICAL before and after P-262 — labels, line grouping and drawn envelope", async () => {
    // Dispatch falsifier 2. Three statements, all pinned:
    //   1. the roles are the pre-P-262 roles;
    //   2. the logical-edge grouping is the IDENTITY on this ring (that is WHY
    //      nothing moves: every internal turn measures 89.4-95.0 degrees, so
    //      there is no artifact run to fuse — a future change that grouped
    //      anything here would break the control, not this test's tolerance);
    //   3. the drawn envelope equals origin/main's envelope to 1e-9 degrees
    //      (~0.1 mm), so P-262's scrub + grouping + front rule touched none of
    //      this parcel's geometry.
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_48453_427599_PFLUGERVILLE,
      roads: ROADS_AROUND_48453_427599,
      situsAddress: SITUS_48453_427599,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;
    expect(labels.edgeLabels.map((e) => e.label)).toEqual(CONTROL_48453_LABELS);
    expect(labels.edgeLabels.findIndex((e) => e.label === "front")).toBe(1);

    const proj = projectRing(PARCEL_48453_427599_PFLUGERVILLE)!;
    const groups = groupRingChordsIntoLogicalEdges(proj);
    expect(groups.map((g) => g.chordIndices)).toEqual([[0], [1], [2], [3]]);
    expect(groups.map((g) => g.lengthM.toFixed(6))).toEqual(
      proj.points.map((_, i) => {
        const a = proj.points[i]!;
        const b = proj.points[(i + 1) % proj.points.length]!;
        return Math.hypot(b.x - a.x, b.y - a.y).toFixed(6);
      }),
    );

    const { result } = await drawAndGrade(
      PARCEL_48453_427599_PFLUGERVILLE,
      ROADS_AROUND_48453_427599,
      SITUS_48453_427599,
      labels.edgeLabels,
    );
    expect(result.verify.pass).toBe(true);
    const drawn = result.candidate.insetRing;
    expect(drawn, `empty envelope: ${result.candidate.emptyReason}`).not.toBeNull();
    expect(drawn!.length).toBe(CONTROL_48453_ENVELOPE.length);
    for (const [i, [lng, lat]] of CONTROL_48453_ENVELOPE.entries()) {
      expect(Math.abs(drawn![i]![0]! - lng)).toBeLessThan(1e-9);
      expect(Math.abs(drawn![i]![1]! - lat)).toBeLessThan(1e-9);
    }
  });
});

describe("P-262 item 3 — curved frontage fixtures (one front over the curve)", () => {
  it("324-knockout-rose: the whole street frontage is ONE front, and the lot is REFUSED rather than served on a straightened curve", async () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
      roads: ROADS_AROUND_KNOCKOUT_ROSE,
      situsAddress: SITUS_324_KNOCKOUT_ROSE,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;
    const fronts = labels.edgeLabels.filter((e) => e.label === "front").map((e) => e.index);
    // Chords 12 and 0-8 are the frontage: one street, one front, one setback.
    expect(fronts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 12]);
    // The back of the lot keeps its own roles (the curve there is not a frontage).
    expect(labels.edgeLabels[9]!.label).toBe("side");
    expect(labels.edgeLabels[10]!.label).toBe("rear");
    expect(labels.edgeLabels[11]!.label).toBe("side");

    // WHAT IS STILL OPEN, measured rather than assumed: the offset core draws
    // this convex frontage as ONE STRAIGHT segment (the chords' chordal line),
    // so the curve's middle chords come out 38.24 ft from their own front
    // boundary instead of 25 ft, R32 refuses, and the parcel serves NOTHING.
    // That is fail-closed and outside this lane (the labeller is the lane's
    // target; the drawing is boundary-primitive's), but it is pinned here so
    // the residual cannot be lost: when the offset core learns a curve, this
    // test's last two assertions flip to the envelope passing P1-P3.
    const { result, groundTruth } = await drawAndGrade(
      PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
      ROADS_AROUND_KNOCKOUT_ROSE,
      SITUS_324_KNOCKOUT_ROSE,
      labels.edgeLabels,
    );
    expect(result.candidate.empty).toBe(false);
    expect(result.verify.gates.frontOrientation.pass, "the front IS resolved (this lane's fix)").toBe(true);
    expect(result.verify.pass, "P-262 leaves the curve's drawn boundary refused by R32").toBe(false);
    expect(result.verify.gates.r32PerEdgeInset.pass).toBe(false);
    expect(result.verify.gates.r32PerEdgeInset.reasons.join("\n")).toMatch(
      /edge 6: R32 38\.24\d*ft != expected 25ft for role front/,
    );
    expect(groundTruth!.pass).toBe(false);
    const overInset = groundTruth!.p2.edges.filter((e) => !e.pass && (e.measuredFt ?? 0) > (e.expectedFt ?? 0));
    expect(overInset.map((e) => e.edgeIndex)).toContain(6);
    // A straight boundary ACROSS the curve (9 chords of 3.42/3.43/0.84 m whose
    // own turning measures 0.99-11.17 degrees) is what leaves the curve's
    // middle chords short: 38.24 ft is 25 ft plus the curve's sagitta.
    expect(groundTruth!.p2.edges.filter((e) => e.collinearFragmentOfLogicalLine).length).toBeGreaterThan(0);
  }, 120_000);

  it("312-knockout-rose: a curve at the BACK is not a frontage — the run stops at the street", async () => {
    const labels = labelEdgesFromRoads({
      parcelRing: PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
      roads: ROADS_AROUND_KNOCKOUT_ROSE,
      situsAddress: SITUS_312_KNOCKOUT_ROSE,
    });
    expect(labels.ok).toBe(true);
    if (!labels.ok) return;
    const roles = labels.edgeLabels.map((e) => e.label);
    // Front on the situs-named chord 0 AND its one-turn neighbour 1 (the same
    // frontage, 16.59 degrees apart); the back curve (3, 4) stays side and the
    // backing run 5 stays rear — 41.8-45.8 m away and behind a 90 degree turn.
    expect(roles).toEqual(["front", "front", "side", "side", "side", "rear", "side"]);

    const { result, groundTruth } = await drawAndGrade(
      PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
      ROADS_AROUND_KNOCKOUT_ROSE,
      SITUS_312_KNOCKOUT_ROSE,
      labels.edgeLabels,
    );
    expect(result.candidate.empty).toBe(false);
    expect(result.verify.pass, JSON.stringify(result.verify.gates, null, 2)).toBe(true);
    expect(groundTruth!.pass, JSON.stringify(groundTruth!.p2.edges.filter((e) => !e.pass))).toBe(true);
  }, 120_000);
});
