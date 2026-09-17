/**
 * RE-ACQUISITION SIMULATION — the case the parcel-node writer was never tested
 * against, and the one the consumption contract's C3 FATAL finding is about.
 *
 * Every test here simulates a VINTAGE CHANGE on one county: the same land
 * re-acquired from StratMap with the shapefile order reshuffled, some parcels
 * dropped, some added. The happy path (write a fresh county once) is covered by
 * plan-county-parcel-nodes.test.ts and does not exercise any of this.
 *
 * The three invariants under test:
 *   S1 — a synthetic key must not assert continuity it cannot support.
 *   S2 — what is no longer observed must be retired, not left active.
 *   S3 — no parcel is warmed without a live, resolved, account-keyed anchor.
 */

import { describe, expect, it } from "vitest";

import {
  isSyntheticParcelKey,
  planCountyParcelNodes,
  syntheticParcelKey,
  type CountyKeyPolicy,
  type TxgioParcelRowInput,
} from "../plan-county-parcel-nodes.js";
import {
  assertNoActiveOrphans,
  decideRetiredParcelNodeReactivations,
  reconcileCountyParcelNodes,
  reviewRetiredParcelNodes,
  type StoredParcelNodeRow,
} from "../reconcile-county-parcel-nodes.js";
import {
  assertWarmGateApplied,
  gateWarmCohort,
  parcelNodeWarmEligibility,
  type ParcelNodeAnchorState,
} from "../warm-preflight-gate.js";
import { buildAtomsForPlan } from "../parcel-node-atoms.js";

const COUNTY = "48261";
const V1 = "2024-01-01";
const V2 = "2025-06-01";

const POLICY: CountyKeyPolicy = {
  countyFips: COUNTY,
  keyKind: "prop_id",
  geometrySourceTier: "txgio-stratmap",
};

/** A simple square ring — reducible, so geometry is never the variable here. */
function ring(): unknown {
  return {
    type: "Polygon",
    coordinates: [
      [
        [-97.5, 30.1],
        [-97.4, 30.1],
        [-97.4, 30.2],
        [-97.5, 30.2],
        [-97.5, 30.1],
      ],
    ],
  };
}

function feature(
  featureIndex: number,
  propId: string | null,
  sourceVintage: string,
): TxgioParcelRowInput {
  return {
    featureIndex,
    tileKey: `t-${featureIndex}`,
    propId,
    geoId: null,
    geometry: ring(),
    sourceVintage,
  };
}

/** Turn a plan into the stored-row shape a prior vintage would have left. */
function storedFromPlan(
  rows: ReadonlyArray<TxgioParcelRowInput>,
): StoredParcelNodeRow[] {
  const plan = planCountyParcelNodes(rows, POLICY);
  return plan.planned.map((p) => ({
    parcelNodeId: `${COUNTY}:${p.parcelKey}`,
    status: "active" as const,
    sourceVintage: p.sourceVintage,
  }));
}

// ---------------------------------------------------------------------------
// INVARIANT S1 — synthetic keys assert no cross-vintage continuity
// ---------------------------------------------------------------------------

describe("S1 — synthetic feature keys cannot collide across vintages", () => {
  it("THE DEFECT: a reshuffled feature_index must not produce the same parcelNodeId in two vintages", () => {
    // V1: feature 7 is a no-account polygon (StratMap `prop_id = '0'`).
    const v1 = planCountyParcelNodes([feature(7, "0", V1)], POLICY);
    // V2: StratMap reshuffled; a DIFFERENT no-account polygon is now feature 7.
    const v2 = planCountyParcelNodes([feature(7, "0", V2)], POLICY);

    const v1Key = v1.planned[0]!.parcelKey;
    const v2Key = v2.planned[0]!.parcelKey;

    // Both are synthetic...
    expect(isSyntheticParcelKey(v1Key)).toBe(true);
    expect(isSyntheticParcelKey(v2Key)).toBe(true);

    // ...and they are NOT equal. This is the whole fix: the ids differ, so
    // there is no upsert-on-atom_did that can put V2's land onto V1's row.
    // Before the carve-out both were `_feature-7`.
    expect(v1Key).not.toBe(v2Key);
    expect(v1Key).toBe(syntheticParcelKey(7, V1));
    expect(v2Key).toBe(syntheticParcelKey(7, V2));
  });

  it("derives DISTINCT atom DIDs for the same feature index under two vintages", () => {
    const prov = {
      sourceAdapter: "txgio-stratmap-bulk-v1",
      sourceCitation: "test",
      sourceUrl: "https://example.invalid/",
      observedAt: "2026-08-08T00:00:00.000Z",
      jurisdictionTenant: `tx_${COUNTY}`,
      verificationStatus: "machine" as const,
    };
    const a1 = buildAtomsForPlan(
      planCountyParcelNodes([feature(7, "0", V1)], POLICY),
      "txgio-stratmap",
      prov,
    );
    const a2 = buildAtomsForPlan(
      planCountyParcelNodes([feature(7, "0", V2)], POLICY),
      "txgio-stratmap",
      prov,
    );

    // atom_did is derived from parcelNodeId and the store upserts on it. Two
    // different DIDs means two different rows means no silent identity theft.
    expect(a1[0]!.atomDid).not.toBe(a2[0]!.atomDid);
    expect(a1[0]!.parcelNodeId).not.toBe(a2[0]!.parcelNodeId);
  });

  it("is IDEMPOTENT within one vintage — a re-run produces the identical key", () => {
    const first = planCountyParcelNodes([feature(7, "0", V1)], POLICY);
    const second = planCountyParcelNodes([feature(7, "0", V1)], POLICY);
    expect(first.planned[0]!.parcelKey).toBe(second.planned[0]!.parcelKey);
  });

  it("keeps the synthetic key contract-legal even when the vintage carries illegal characters", () => {
    const plan = planCountyParcelNodes(
      [feature(3, "0", "StratMap 2024/Q1 (rev 2)")],
      POLICY,
    );
    const key = plan.planned[0]!.parcelKey;
    // PARCEL_NODE_ID_PATTERN second token alphabet.
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(isSyntheticParcelKey(key)).toBe(true);
  });

  it("recognizes the LEGACY bare `_feature-N` form as synthetic so old rows stay refused", () => {
    expect(isSyntheticParcelKey("_feature-7")).toBe(true);
    expect(isSyntheticParcelKey(`${COUNTY}:_feature-7`)).toBe(true);
    // ...and a real account key is never mistaken for one.
    expect(isSyntheticParcelKey("15271")).toBe(false);
    expect(isSyntheticParcelKey(`${COUNTY}:15271`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT S2 — orphan retirement
// ---------------------------------------------------------------------------

describe("S2 — re-acquisition retires what the source no longer publishes", () => {
  /**
   * The full simulation the deliverable asks for: same county, vintage change,
   * feature indexes shuffled, some parcels dropped, some added.
   */
  const v1Rows = [
    feature(10, "100", V1), // survives, reshuffled to index 51 in V2
    feature(11, "101", V1), // survives, reshuffled to index 10 in V2
    feature(12, "102", V1), // DROPPED in V2
    feature(13, "0", V1), // keyless; V2 reuses index 13 for different land
  ];

  const v2Rows = [
    feature(51, "100", V2), // same account, different feature index
    feature(10, "101", V2), // same account, took over V1's index 10
    feature(52, "900", V2), // NEW account
    feature(13, "0", V2), // keyless, index reused — the Case B trap
  ];

  it("retires dropped accounts and keyless rows, keeps real accounts as survivors", () => {
    const prior = storedFromPlan(v1Rows);
    const v2Plan = planCountyParcelNodes(v2Rows, POLICY);
    const rec = reconcileCountyParcelNodes(prior, v2Plan, V2);

    // Accounts 100 and 101 survived despite their feature indexes changing —
    // account identity is prop_id, not shapefile order.
    const survivorIds = rec.survivors.map((s) => s.parcelNodeId).sort();
    expect(survivorIds).toEqual([`${COUNTY}:100`, `${COUNTY}:101`]);
    expect(rec.counts.accountContinuity).toBe(2);
    expect(rec.counts.syntheticSurvivors).toBe(0);

    // Account 102 vanished, and V1's keyless feature 13 did too (its key is
    // vintage-scoped, so V2's feature 13 is a DIFFERENT id).
    const orphanIds = rec.orphans.map((o) => o.parcelNodeId).sort();
    expect(orphanIds).toEqual([
      `${COUNTY}:102`,
      `${COUNTY}:${syntheticParcelKey(13, V1)}`,
    ]);
    expect(rec.counts.orphans).toBe(2);
    expect(rec.counts.syntheticOrphans).toBe(1);

    // New land: account 900 and V2's keyless feature 13.
    expect(rec.newIds.sort()).toEqual(
      [`${COUNTY}:900`, `${COUNTY}:${syntheticParcelKey(13, V2)}`].sort(),
    );
  });

  it("NO FALSE CONTINUITY: the reused keyless index appears as retire+mint, never as a survivor", () => {
    const prior = storedFromPlan(v1Rows);
    const v2Plan = planCountyParcelNodes(v2Rows, POLICY);
    const rec = reconcileCountyParcelNodes(prior, v2Plan, V2);

    // The pre-fix behaviour would have shown `48261:_feature-13` on BOTH sides
    // and reported it as one parcel continuing. Instead:
    const v1Synthetic = `${COUNTY}:${syntheticParcelKey(13, V1)}`;
    const v2Synthetic = `${COUNTY}:${syntheticParcelKey(13, V2)}`;
    expect(v1Synthetic).not.toBe(v2Synthetic);
    expect(rec.orphans.map((o) => o.parcelNodeId)).toContain(v1Synthetic);
    expect(rec.newIds).toContain(v2Synthetic);
    // And NO synthetic key is ever reported as a continuing account.
    expect(rec.survivors.every((s) => !s.syntheticKey)).toBe(true);
    expect(rec.survivors.every((s) => s.accountContinuity)).toBe(true);
  });

  it("carries a concrete reason on every orphan, never a generic 'not found'", () => {
    const prior = storedFromPlan(v1Rows);
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes(v2Rows, POLICY),
      V2,
    );
    for (const orphan of rec.orphans) {
      expect(orphan.reason.length).toBeGreaterThan(40);
      expect(orphan.reason).toContain(COUNTY);
      expect(orphan.reason).not.toMatch(/^not found$/i);
    }
    const synthetic = rec.orphans.find((o) => o.synthetic)!;
    expect(synthetic.reason).toMatch(/within-vintage only/);
    expect(synthetic.priorVintage).toBe(V1);
  });

  it("even if the SAME synthetic key somehow survives, it is never account continuity", () => {
    // Force the pathological case: identical vintage on both sides, so the
    // synthetic id genuinely repeats. It is a re-run of one observation, not a
    // parcel continuing, and the reconcile says exactly that.
    const prior = storedFromPlan([feature(7, "0", V1)]);
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes([feature(7, "0", V1)], POLICY),
      V1,
    );
    expect(rec.counts.survivors).toBe(1);
    expect(rec.survivors[0]!.syntheticKey).toBe(true);
    expect(rec.survivors[0]!.accountContinuity).toBe(false);
    expect(rec.counts.accountContinuity).toBe(0);
  });

  it("already-retired rows are not re-reported as orphans", () => {
    const prior: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:102`, status: "retired", sourceVintage: V1 },
      { parcelNodeId: `${COUNTY}:100`, status: "active", sourceVintage: V1 },
    ];
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes([feature(51, "100", V2)], POLICY),
      V2,
    );
    expect(rec.counts.orphans).toBe(0);
    expect(rec.priorActive).toBe(1);
  });

  it("FAIL-CLOSED: assertNoActiveOrphans rejects a store that still has an unretired orphan", () => {
    const prior = storedFromPlan(v1Rows);
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes(v2Rows, POLICY),
      V2,
    );

    // Store state where the retire pass silently did nothing for `102`.
    const stillActive = [
      `${COUNTY}:100`,
      `${COUNTY}:101`,
      `${COUNTY}:900`,
      `${COUNTY}:${syntheticParcelKey(13, V2)}`,
      `${COUNTY}:102`, // <- the orphan that should have been retired
    ];
    const verdict = assertNoActiveOrphans(rec, stillActive);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.stillActive).toEqual([`${COUNTY}:102`]);
      expect(verdict.problem).toMatch(/would read as current/);
    }
  });

  it("FAIL-CLOSED: passes once every orphan is actually retired in the store", () => {
    const prior = storedFromPlan(v1Rows);
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes(v2Rows, POLICY),
      V2,
    );
    const stillActive = [
      `${COUNTY}:100`,
      `${COUNTY}:101`,
      `${COUNTY}:900`,
      `${COUNTY}:${syntheticParcelKey(13, V2)}`,
    ];
    expect(assertNoActiveOrphans(rec, stillActive)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// P-212 — retired-row review: a bad plan's retirements outlive the bad plan
// ---------------------------------------------------------------------------

describe("P-212: reconcileCountyParcelNodes cannot recover a false retirement on re-run", () => {
  // The real shape found in production (48021/Bastrop, 2026-09-15): a SAME-VINTAGE
  // reconcile ran once against an under-resolved plan (only account 100 resolved)
  // and retired every other real, still-live account under that identical vintage.
  const fullRows = [
    feature(10, "100", V1),
    feature(11, "101", V1),
    feature(12, "102", V1),
    feature(13, "103", V1), // stands in for the negative control (`77293`): genuinely gone at the live source
  ];
  const badPlanRows = [feature(10, "100", V1)]; // the historical run only resolved one account

  it("THE DEFECT: reconcile-and-retire against an under-resolved same-vintage plan retires real, still-current accounts", () => {
    const priorFromFullLoad = storedFromPlan(fullRows); // what was actually written when the county first loaded, all active
    const badPlan = planCountyParcelNodes(badPlanRows, POLICY);
    const rec = reconcileCountyParcelNodes(priorFromFullLoad, badPlan, V1);

    // 101, 102, 103 all vanish from a plan that never actually stopped observing them.
    expect(rec.orphans.map((o) => o.parcelNodeId).sort()).toEqual([
      `${COUNTY}:101`,
      `${COUNTY}:102`,
      `${COUNTY}:103`,
    ]);
    // And the reason text is indistinguishable from a genuine disappearance —
    // this is exactly why the stored Bastrop rows all carry the same templated
    // reason naming the SAME vintage on both sides.
    for (const o of rec.orphans) {
      expect(o.reason).toContain(`previously observed under vintage ${V1}`);
      expect(o.reason).toContain(`absent from the ${V1} plan`);
    }
  });

  it("THE GAP: re-running reconcileCountyParcelNodes against the CORRECT plan does nothing for rows already retired", () => {
    // Simulate: after the bad run above, the store now holds 100 active and
    // 101/102/103 retired. A later, CORRECT, fully-resolved plan for the same
    // vintage runs (the equivalent of simply re-invoking write-parcel-node-county
    // once txgio_parcel is complete) ...
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:100`, status: "active", sourceVintage: V1 },
      {
        parcelNodeId: `${COUNTY}:101`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: `parcel is absent from the ${V1} plan for county ${COUNTY} (previously observed under vintage ${V1}); the source no longer publishes this account and no successor evidence exists`,
      },
      {
        parcelNodeId: `${COUNTY}:102`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: `parcel is absent from the ${V1} plan for county ${COUNTY} (previously observed under vintage ${V1}); the source no longer publishes this account and no successor evidence exists`,
      },
      {
        parcelNodeId: `${COUNTY}:103`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: `parcel is absent from the ${V1} plan for county ${COUNTY} (previously observed under vintage ${V1}); the source no longer publishes this account and no successor evidence exists`,
      },
    ];
    const correctPlan = planCountyParcelNodes(fullRows, POLICY);
    const rec = reconcileCountyParcelNodes(afterBadRun, correctPlan, V1);

    // reconcileCountyParcelNodes only ever examines rows CURRENTLY active
    // (`active = priorRows.filter(r => r.status === "active")`). It reports zero
    // new orphans (correct) but it ALSO does nothing to recover 101/102/103 — a
    // wrongly retired row is invisible to this function forever, however
    // complete a later plan is. THIS is the gap `reviewRetiredParcelNodes` fixes.
    expect(rec.counts.orphans).toBe(0);
    expect(rec.priorActive).toBe(1); // only sees the one row that was never retired
  });

  it("THE FIX: reviewRetiredParcelNodes surfaces exactly the rows the correct plan predicts again", () => {
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:100`, status: "active", sourceVintage: V1 },
      {
        parcelNodeId: `${COUNTY}:101`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: "orphan-by-bad-plan",
      },
      {
        parcelNodeId: `${COUNTY}:102`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: "orphan-by-bad-plan",
      },
      {
        parcelNodeId: `${COUNTY}:103`,
        status: "retired",
        sourceVintage: V1,
        retiredAt: "2026-08-11T12:14:06.746Z",
        retiredReason: "orphan-by-bad-plan",
      },
      // A GENUINE orphan: retired before, and still absent from the correct plan too.
      { parcelNodeId: `${COUNTY}:999`, status: "retired", sourceVintage: V1, retiredReason: "actually gone" },
    ];
    const correctPlan = planCountyParcelNodes(fullRows, POLICY);
    const review = reviewRetiredParcelNodes(afterBadRun, correctPlan);

    expect(review.priorRetired).toBe(4);
    expect(review.candidates.map((c) => c.parcelNodeId).sort()).toEqual([
      `${COUNTY}:101`,
      `${COUNTY}:102`,
      `${COUNTY}:103`,
    ]);
    // The genuine orphan is never surfaced as a candidate.
    expect(review.stillAbsent).toBe(1);
  });

  it("THE GUARD (`77293`): a candidate the plan re-predicts is NOT reactivated without live corroboration", () => {
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:100`, status: "active", sourceVintage: V1 },
      { parcelNodeId: `${COUNTY}:101`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
      { parcelNodeId: `${COUNTY}:102`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
      // `103` mirrors `77293`: present in the internal plan, but the live
      // county source does not confirm it. It must stay retired.
      { parcelNodeId: `${COUNTY}:103`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
    ];
    const correctPlan = planCountyParcelNodes(fullRows, POLICY);
    const review = reviewRetiredParcelNodes(afterBadRun, correctPlan);

    const liveCurrency = new Map([
      [`${COUNTY}:101`, true],
      [`${COUNTY}:102`, true],
      [`${COUNTY}:103`, false], // the county's own live source says: not found
    ]);
    const verdict = decideRetiredParcelNodeReactivations(review, liveCurrency);

    expect(verdict.reactivate.map((r) => r.parcelNodeId).sort()).toEqual([
      `${COUNTY}:101`,
      `${COUNTY}:102`,
    ]);
    expect(verdict.stillRetired.map((r) => r.parcelNodeId)).toEqual([`${COUNTY}:103`]);
    expect(verdict.confirmedAbsent.map((r) => r.parcelNodeId)).toEqual([`${COUNTY}:103`]);
    expect(verdict.unmeasured).toEqual([]);

    // FALSIFIER: a fix that reactivates every candidate regardless of live
    // corroboration is "admitting everything rather than fixing the comparison."
    expect(verdict.reactivate.some((r) => r.parcelNodeId === `${COUNTY}:103`)).toBe(false);
  });

  it("FALSIFIER (P-275): an empty live-currency map (no corroboration attempted) reactivates nothing", () => {
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:101`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
    ];
    const correctPlan = planCountyParcelNodes([feature(11, "101", V1)], POLICY);
    const review = reviewRetiredParcelNodes(afterBadRun, correctPlan);
    const verdict = decideRetiredParcelNodeReactivations(review, new Map());
    expect(verdict.reactivate).toEqual([]);
    // P-275: an empty map is the ABSENCE OF A MEASUREMENT, not a measurement of absence.
    // The candidate lands in `unmeasured` -- never in `confirmedAbsent`, and never in a
    // report that reads like the county said "not there".
    expect(verdict.confirmedAbsent).toEqual([]);
    expect(verdict.unmeasured).toEqual([
      {
        parcelNodeId: `${COUNTY}:101`,
        reason: expect.stringContaining("UNMEASURED"),
      },
    ]);
    expect(verdict.unmeasured[0]!.reason).toContain("NOT a");
    expect(verdict.stillRetired.map((r) => r.parcelNodeId)).toEqual([`${COUNTY}:101`]);
  });

  it("P-275 FALSIFIER: an unreachable source reports UNMEASURED, never zero candidates", () => {
    // The dispatch's falsifier verbatim: "a county whose live source is unreachable
    // reports UNMEASURED, never zero candidates". The caller (the review script) turns a
    // transport failure into an `unmeasured` reading for EVERY candidate rather than an
    // empty map -- both spellings are asserted here so the module cannot drift.
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:101`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
      { parcelNodeId: `${COUNTY}:102`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
    ];
    const correctPlan = planCountyParcelNodes(
      [feature(11, "101", V1), feature(12, "102", V1)],
      POLICY,
    );
    const review = reviewRetiredParcelNodes(afterBadRun, correctPlan);

    for (const liveCurrency of [
      // (a) explicit unmeasured readings, the shape the CLI produces on a throw
      new Map(review.candidates.map((c) => [
        c.parcelNodeId,
        { reading: "unmeasured" as const, reason: "ENOTFOUND gis.example.invalid" },
      ])),
      // (b) an empty map -- the naive spelling of "the source did not answer"
      new Map(),
    ]) {
      const verdict = decideRetiredParcelNodeReactivations(review, liveCurrency);
      expect(verdict.reactivate).toEqual([]);
      expect(verdict.confirmedAbsent).toEqual([]);
      expect(verdict.unmeasured).toHaveLength(2);
      expect(verdict.stillRetired).toHaveLength(2);
    }
  });

  it("P-275: an absent reading and an unmeasured reading are never the same report line", () => {
    const afterBadRun: StoredParcelNodeRow[] = [
      { parcelNodeId: `${COUNTY}:101`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
      { parcelNodeId: `${COUNTY}:102`, status: "retired", sourceVintage: V1, retiredAt: "t", retiredReason: "r" },
    ];
    const correctPlan = planCountyParcelNodes(
      [feature(11, "101", V1), feature(12, "102", V1)],
      POLICY,
    );
    const review = reviewRetiredParcelNodes(afterBadRun, correctPlan);
    const verdict = decideRetiredParcelNodeReactivations(
      review,
      new Map([
        [`${COUNTY}:101`, "absent" as const],
        // `102` deliberately has no entry -- a source that answered for one id and not
        // the other. They must not be reported as the same kind of result.
        [`${COUNTY}:102`, "unmeasured" as const],
      ]),
    );
    expect(verdict.confirmedAbsent.map((r) => r.parcelNodeId)).toEqual([`${COUNTY}:101`]);
    expect(verdict.unmeasured.map((r) => r.parcelNodeId)).toEqual([`${COUNTY}:102`]);
    expect(verdict.confirmedAbsent[0]!.reason).toContain("measured absent");
    expect(verdict.unmeasured[0]!.reason).toContain("UNMEASURED");
  });
});

// ---------------------------------------------------------------------------
// INVARIANT S3 — the warm preflight gate
// ---------------------------------------------------------------------------

function anchor(
  over: Partial<ParcelNodeAnchorState> & { parcelNodeId: string },
): ParcelNodeAnchorState {
  const id = over.parcelNodeId;
  const [fips, key] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  return {
    status: "active",
    geometryLoaded: true,
    keyKind: "prop_id",
    geometryStoreRef: { countyFips: fips, propId: key },
    ...over,
  };
}

describe("S3 — warm preflight refuses parcels whose preconditions are unmet", () => {
  it("admits a live, resolved, account-keyed anchor", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:100`,
      anchor({ parcelNodeId: `${COUNTY}:100` }),
    );
    expect(v.eligible).toBe(true);
  });

  it("refuses a parcel with NO anchor — zoning-fact alone cannot promote", () => {
    const v = parcelNodeWarmEligibility(`${COUNTY}:100`, null);
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.declineCode).toBe("no-parcel-node-anchor");
      expect(v.reason).toMatch(/would have no subject/);
    }
  });

  it("refuses a RETIRED anchor — the re-acquisition orphan case", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:102`,
      anchor({ parcelNodeId: `${COUNTY}:102`, status: "retired" }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.declineCode).toBe("parcel-node-retired");
  });

  it("refuses a synthetic key on the REQUEST, whatever row exists for it", () => {
    const id = `${COUNTY}:${syntheticParcelKey(13, V2)}`;
    // Even handed a fully "healthy"-looking anchor, the gate refuses.
    const v = parcelNodeWarmEligibility(id, anchor({ parcelNodeId: id }));
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.declineCode).toBe("parcel-node-key-unresolved");
      expect(v.reason).toMatch(/never anchor a jurisdiction claim/);
    }
    // Legacy bare form refused identically.
    expect(
      parcelNodeWarmEligibility(`${COUNTY}:_feature-13`, null).eligible,
    ).toBe(false);
  });

  it("refuses a geometry-incomplete absence anchor", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:103`,
      anchor({
        parcelNodeId: `${COUNTY}:103`,
        geometryLoaded: false,
        absenceKind: "geometry-incomplete",
        geometryStoreRef: null,
      }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.declineCode).toBe("parcel-node-geometry-incomplete");
  });

  it("refuses a no-parcel-geometry absence anchor", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:104`,
      anchor({
        parcelNodeId: `${COUNTY}:104`,
        geometryLoaded: false,
        absenceKind: "no-parcel-geometry",
        geometryStoreRef: null,
      }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.declineCode).toBe("parcel-node-absence");
  });

  it("refuses an anchor whose pointer names a different parcel", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:100`,
      anchor({
        parcelNodeId: `${COUNTY}:100`,
        geometryStoreRef: { countyFips: COUNTY, propId: "999" },
      }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.declineCode).toBe("parcel-node-pointer-mismatch");
      expect(v.reason).toMatch(/different parcel's ring/);
    }
  });

  it("refuses an anchor claiming geometryLoaded with no pointer at all", () => {
    const v = parcelNodeWarmEligibility(
      `${COUNTY}:100`,
      anchor({ parcelNodeId: `${COUNTY}:100`, geometryStoreRef: null }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.declineCode).toBe("parcel-node-pointer-mismatch");
  });

  it("gates a whole cohort: the warm set is the INTERSECTION, not the recipe roster", () => {
    // A realistic post-re-acquisition cohort sized the old way (from
    // zoning-fact presence): five parcels the recipe thinks are warmable.
    const recipeCohort = [
      `${COUNTY}:100`, // healthy
      `${COUNTY}:101`, // healthy
      `${COUNTY}:102`, // retired orphan from the re-acquire
      `${COUNTY}:${syntheticParcelKey(13, V2)}`, // synthetic
      `${COUNTY}:777`, // zoning-fact exists but no parcel-node was ever written
    ];
    const anchors = new Map<string, ParcelNodeAnchorState>([
      [`${COUNTY}:100`, anchor({ parcelNodeId: `${COUNTY}:100` })],
      [`${COUNTY}:101`, anchor({ parcelNodeId: `${COUNTY}:101` })],
      [
        `${COUNTY}:102`,
        anchor({ parcelNodeId: `${COUNTY}:102`, status: "retired" }),
      ],
    ]);

    const gated = gateWarmCohort(recipeCohort, anchors);

    expect(gated.eligible).toEqual([`${COUNTY}:100`, `${COUNTY}:101`]);
    expect(gated.tally.passed).toBe(2);
    expect(gated.tally.declined).toBe(3);
    expect(gated.tally.byCode["parcel-node-retired"]).toBe(1);
    expect(gated.tally.byCode["parcel-node-key-unresolved"]).toBe(1);
    expect(gated.tally.byCode["no-parcel-node-anchor"]).toBe(1);

    // Every refusal is named and counted — none silently dropped.
    expect(gated.declined).toHaveLength(3);
    for (const d of gated.declined) expect(d.declineCode).toBeTruthy();

    // And the arithmetic reconciles: nothing bypassed the gate.
    expect(assertWarmGateApplied(recipeCohort.length, gated.tally)).toEqual({
      ok: true,
    });
  });

  it("FAIL-CLOSED: a cohort larger than the gate accounted for is a bypass", () => {
    const gated = gateWarmCohort([`${COUNTY}:100`], new Map());
    const verdict = assertWarmGateApplied(5, gated.tally);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toMatch(/reached compute without a parcel-node verdict/);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END: the three invariants composed over one re-acquisition
// ---------------------------------------------------------------------------

describe("end-to-end re-acquisition: plan -> reconcile -> retire -> warm gate", () => {
  it("a parcel dropped by the re-acquire is retired and then refused for warm", () => {
    const v1 = [feature(10, "100", V1), feature(12, "102", V1)];
    const v2 = [feature(10, "100", V2)]; // 102 gone

    const prior = storedFromPlan(v1);
    const rec = reconcileCountyParcelNodes(
      prior,
      planCountyParcelNodes(v2, POLICY),
      V2,
    );

    // 1. It is identified as an orphan.
    expect(rec.orphans.map((o) => o.parcelNodeId)).toEqual([`${COUNTY}:102`]);

    // 2. Retiring it satisfies the fail-closed post-condition.
    expect(assertNoActiveOrphans(rec, [`${COUNTY}:100`])).toEqual({ ok: true });

    // 3. The jurisdiction factory then refuses to warm it, so no claim is
    //    computed about land the source no longer publishes.
    const afterRetire = anchor({
      parcelNodeId: `${COUNTY}:102`,
      status: "retired",
    });
    const v = parcelNodeWarmEligibility(`${COUNTY}:102`, afterRetire);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.declineCode).toBe("parcel-node-retired");

    // 4. And the surviving account is still warmable — the gate is not a
    //    blanket refusal after a re-acquire.
    expect(
      parcelNodeWarmEligibility(
        `${COUNTY}:100`,
        anchor({ parcelNodeId: `${COUNTY}:100` }),
      ).eligible,
    ).toBe(true);
  });
});
