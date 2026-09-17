/**
 * Re-acquisition reconciliation for `parcel-node` — the half of the statewide
 * writer that handles what a plan does NOT contain.
 *
 * The writer before this module was upsert-only. It answered "what should
 * exist now?" and wrote exactly that. It never asked "what used to exist and
 * no longer does?", so a county re-acquire left every vanished parcel sitting
 * in the store as `status: "active"` with a `geometryStoreRef` pointing at a
 * `prop_id` that had just been deleted from `txgio_parcel`. Those rows read as
 * current to every consumer. That is a stale claim presented as a live one,
 * and it is the defect class this module makes unrepresentable.
 *
 * ---------------------------------------------------------------------------
 * INVARIANT S2 — WHAT IS NO LONGER OBSERVED MUST BE RETIRED, NOT LEFT ACTIVE.
 *
 * After a county's geometry is replaced, the set of active `parcel-node` atoms
 * for that county must equal the set the new plan predicts. Any active atom
 * whose `parcelNodeId` is absent from the new plan is an ORPHAN: the source no
 * longer publishes it. It is flipped to `status: "retired"` with a `retiredAt`
 * stamp and a concrete reason naming the vintage transition.
 *
 * ENFORCING MECHANISM: {@link reconcileCountyParcelNodes} computes the orphan
 * set as a SET DIFFERENCE against the plan, and {@link assertNoActiveOrphans}
 * is a fail-closed post-condition the CLI runs after applying. A run that
 * cannot retire its orphans fails rather than reporting success, so "the
 * writer completed" and "no stale active rows remain" cannot come apart.
 *
 * WHY A STATUS TRANSITION AND NOT A NEW ABSENCE KIND. The three absence kinds
 * (`no-parcel-geometry`, `geometry-incomplete`, `parcel-key-unresolved`) all
 * answer "what does the source say about this parcel?" Retirement answers a
 * different question: "is this row still current?" They are orthogonal — a
 * RESOLVED atom can be retired, and it has no absence kind to carry. Overloading
 * the absence union would force every consumer that switches on absence kind to
 * also treat one member as a lifecycle flag. `status`/`retiredAt` already exist
 * on `EnginePropertyPersistence` and `flipPropertyAtomRetired` already
 * implements the flip; this reuses them rather than inventing a parallel notion
 * of currency.
 *
 * WHY NOT AN `atom_links` EDGE. `atom_links` carries SUCCESSION
 * (`supersedes`), and succession requires evidence that parcel A became parcel
 * B. For a plain disappearance no such evidence exists, and the consumption
 * contract is explicit that inventing one is forbidden (`retire without
 * successor only` until a succession matcher is decided). Retirement is
 * therefore recorded on the row itself; a `supersedes` edge is an ADDITIONAL
 * fact to be written later, by a matcher that has evidence, and its absence
 * must not block retirement.
 *
 * ---------------------------------------------------------------------------
 * SYNTHETIC KEYS AND CONTINUITY (invariant S1, enforced here at the consumer).
 *
 * Same-key continuity across a vintage bump is only meaningful for ACCOUNT
 * keys. A synthetic `_feature-*` key is a shapefile sequence number and carries
 * no account identity, so this module classifies survivors and never reports a
 * synthetic key as a continued account. Because {@link syntheticParcelKey}
 * embeds the vintage, a keyless feature from the previous vintage cannot even
 * appear in the new plan's id set — it falls into the orphan set by
 * construction and is retired. The carve-out is structural, not a special case
 * bolted onto the reconcile.
 */

import {
  isSyntheticParcelKey,
  type CountyParcelNodePlan,
} from "./plan-county-parcel-nodes.js";

/** One `parcel-node` row as read back from the atom store before reconcile. */
export interface StoredParcelNodeRow {
  parcelNodeId: string;
  /** Store status. Only `active` rows can become orphans. */
  status: "active" | "retired";
  /** Vintage recorded on the stored atom, when it carried one. */
  sourceVintage?: string | null;
  /** Retire reason recorded on the stored atom, when it carried one. */
  retiredReason?: string | null;
  /** Retire timestamp recorded on the stored atom, when it carried one. */
  retiredAt?: string | null;
}

/** An active stored atom the new plan does not predict. */
export interface ParcelNodeOrphan {
  parcelNodeId: string;
  /** True when the id is a synthetic feature key rather than an account key. */
  synthetic: boolean;
  priorVintage: string | null;
  /** Concrete, never a generic "not found". Persisted as the retire reason. */
  reason: string;
}

/** An id present in BOTH the prior active set and the new plan. */
export interface ParcelNodeSurvivor {
  parcelNodeId: string;
  /**
   * Whether this survivor may be read as ONE ACCOUNT CONTINUING across the
   * vintage bump. True only for account keys. A synthetic key that somehow
   * appears on both sides (same vintage re-run) is a re-run of the same
   * observation, not a continuation, and is reported as such.
   */
  accountContinuity: boolean;
  syntheticKey: boolean;
}

export interface CountyReconcilePlan {
  countyFips: string;
  /** Active rows read from the store before this reconcile. */
  priorActive: number;
  /** Ids the new plan predicts. */
  plannedIds: number;
  /** Active-and-still-planned. */
  survivors: ReadonlyArray<ParcelNodeSurvivor>;
  /** Active-and-not-planned. These MUST be retired before the run can pass. */
  orphans: ReadonlyArray<ParcelNodeOrphan>;
  /** Planned ids with no prior active row — new land or a new vintage's keyless features. */
  newIds: ReadonlyArray<string>;
  counts: {
    survivors: number;
    /** Survivors eligible to be read as account continuity. */
    accountContinuity: number;
    /** Survivors that are synthetic keys (never account continuity). */
    syntheticSurvivors: number;
    orphans: number;
    syntheticOrphans: number;
    newIds: number;
  };
}

/**
 * Compare the store's current active set for a county against the new plan.
 *
 * Pure: no database access, so the re-acquisition rules are unit-testable
 * against fixtures rather than against a live store — the same discipline
 * {@link planCountyParcelNodes} follows, and for the same reason.
 */
export function reconcileCountyParcelNodes(
  priorRows: ReadonlyArray<StoredParcelNodeRow>,
  plan: CountyParcelNodePlan,
  newVintage: string | null = null,
): CountyReconcilePlan {
  const plannedIds = new Set(
    plan.planned.map((p) => `${plan.countyFips}:${p.parcelKey}`),
  );

  const active = priorRows.filter((r) => r.status === "active");

  const survivors: ParcelNodeSurvivor[] = [];
  const orphans: ParcelNodeOrphan[] = [];

  for (const row of active) {
    const synthetic = isSyntheticParcelKey(row.parcelNodeId);
    if (plannedIds.has(row.parcelNodeId)) {
      survivors.push({
        parcelNodeId: row.parcelNodeId,
        // Invariant S1 at the consumer: a synthetic key NEVER carries account
        // continuity, whatever else is true of it.
        accountContinuity: !synthetic,
        syntheticKey: synthetic,
      });
      continue;
    }
    const priorVintage = row.sourceVintage ?? null;
    orphans.push({
      parcelNodeId: row.parcelNodeId,
      synthetic,
      priorVintage,
      reason: synthetic
        ? `synthetic feature key from vintage ${priorVintage ?? "unknown"} is not present in the ` +
          `${newVintage ?? "current"} plan for county ${plan.countyFips}; a feature-index key is ` +
          "within-vintage only and is never carried across a re-acquisition"
        : `parcel is absent from the ${newVintage ?? "current"} plan for county ${plan.countyFips} ` +
          `(previously observed under vintage ${priorVintage ?? "unknown"}); the source no longer ` +
          "publishes this account and no successor evidence exists",
    });
  }

  const priorActiveIds = new Set(active.map((r) => r.parcelNodeId));
  const newIds = [...plannedIds].filter((id) => !priorActiveIds.has(id)).sort();

  return {
    countyFips: plan.countyFips,
    priorActive: active.length,
    plannedIds: plannedIds.size,
    survivors,
    orphans,
    newIds,
    counts: {
      survivors: survivors.length,
      accountContinuity: survivors.filter((s) => s.accountContinuity).length,
      syntheticSurvivors: survivors.filter((s) => s.syntheticKey).length,
      orphans: orphans.length,
      syntheticOrphans: orphans.filter((o) => o.synthetic).length,
      newIds: newIds.length,
    },
  };
}

export type OrphanRetirementVerdict =
  | { ok: true }
  | { ok: false; problem: string; stillActive: ReadonlyArray<string> };

/**
 * Fail-closed post-condition for invariant S2.
 *
 * `remainingActive` must be the set of active `parcel-node` ids read back from
 * the store AFTER the retire pass — never the in-memory expectation. Gating on
 * what was intended rather than on what the store now holds is the same defect
 * (verify the write, not the plan) that write-then-verify exists to kill.
 */
export function assertNoActiveOrphans(
  reconcile: CountyReconcilePlan,
  remainingActive: ReadonlyArray<string>,
): OrphanRetirementVerdict {
  const plannedIds = new Set([
    ...reconcile.survivors.map((s) => s.parcelNodeId),
    ...reconcile.newIds,
  ]);
  const stillActive = remainingActive.filter((id) => !plannedIds.has(id));
  if (stillActive.length === 0) return { ok: true };
  return {
    ok: false,
    problem:
      `${stillActive.length} active parcel-node atom(s) for county ${reconcile.countyFips} are ` +
      "absent from the current plan and were not retired; they would read as current while " +
      "pointing at geometry the store no longer holds",
    stillActive: stillActive.slice(0, 20),
  };
}

/**
 * RETIRED-ROW REVIEW (P-212) — the companion direction {@link reconcileCountyParcelNodes}
 * does not cover.
 *
 * P-212: 57,704 of Bastrop's 62,394 `parcel-node` atoms carry `status: "retired"`, all
 * stamped with the SAME `retiredAt` (2026-08-11T12:14:06.746Z) and the SAME templated
 * reason, naming the SAME `sourceVintage` on both sides of "previously observed under
 * vintage X, absent from the X plan" — i.e. one historical run compared the county's
 * active set against a `plan` that resolved far fewer parcels than the county actually
 * has, and everything outside that undersized plan was retired in one pass. Direct
 * verification against the live Bastrop cadastral FeatureServer confirms 19 of a 20-id
 * sample are still real, present accounts today — the comparator's KEY CONSTRUCTION was
 * never the defect (`normalizeParcelKeyToken` and the stored `parcelNodeId`s agree
 * exactly, digit-for-digit, for every sampled id); the defect is that {@link
 * reconcileCountyParcelNodes} retires on ONE run's plan with no way to reconsider a
 * retirement once made, because it only ever examines rows CURRENTLY `active`
 * (see `active = priorRows.filter(r => r.status === "active")` above) — a bad plan's
 * retirements are permanent even after a later, complete plan would show the parcel
 * again.
 *
 * This is intentionally NOT a symmetric mirror of `reconcileCountyParcelNodes` that
 * auto-reactivates. A retired row whose key the current plan predicts again is only a
 * CANDIDATE: `77293` is retired AND present in the current TxGIO plan AND absent when
 * queried live at the county today, so "present in the plan" cannot be the sole
 * reactivation test or every retirement decision would be reduced to trusting the same
 * kind of snapshot that caused this. The caller must corroborate each candidate against
 * a live, per-parcel source before writing any reactivation — this function only narrows
 * "62,394 retired rows" down to "these are worth asking a live source about."
 */
export interface RetiredParcelNodeReviewCandidate {
  parcelNodeId: string;
  priorRetiredAt: string | null;
  priorRetiredReason: string | null;
}

export interface RetiredParcelNodeReview {
  countyFips: string;
  /** Retired rows read from the store before this review. */
  priorRetired: number;
  /** Retired rows whose key the CURRENT plan predicts again — reactivation candidates. */
  candidates: ReadonlyArray<RetiredParcelNodeReviewCandidate>;
  /** Retired rows the current plan still does not predict — left untouched, not a finding. */
  stillAbsent: number;
}

/**
 * Pure: no database access, no live-source access. Computes only the set-membership
 * question the plan can answer honestly. Never write a retired row back to active on
 * this function's output alone — see the module doc above.
 */
export function reviewRetiredParcelNodes(
  storedRows: ReadonlyArray<StoredParcelNodeRow>,
  plan: CountyParcelNodePlan,
): RetiredParcelNodeReview {
  const plannedIds = new Set(
    plan.planned.map((p) => `${plan.countyFips}:${p.parcelKey}`),
  );
  const retired = storedRows.filter((r) => r.status === "retired");
  const candidates: RetiredParcelNodeReviewCandidate[] = [];
  let stillAbsent = 0;
  for (const row of retired) {
    if (plannedIds.has(row.parcelNodeId)) {
      candidates.push({
        parcelNodeId: row.parcelNodeId,
        priorRetiredAt: row.retiredAt ?? null,
        priorRetiredReason: row.retiredReason ?? null,
      });
    } else {
      stillAbsent += 1;
    }
  }
  return {
    countyFips: plan.countyFips,
    priorRetired: retired.length,
    candidates,
    stillAbsent,
  };
}

export interface RetiredParcelNodeReactivation {
  parcelNodeId: string;
  reactivatedReason: string;
}

export interface RetiredParcelNodeStillRetired {
  parcelNodeId: string;
  reason: string;
}

/**
 * P-275: a candidate NOBODY obtained a reading for.
 *
 * This is not a weaker "absent" — it is the absence of a measurement. The distinction is
 * the whole point of the tri-state reading: a county whose source is unreachable, or is
 * not registered at all, must report that its candidates are UNMEASURED, never that they
 * were found missing. Collapsing the two is how a broken source silently becomes a
 * confident "not there" for every parcel in a county, and how "0 candidates" reads as a
 * clean result when nothing was actually asked.
 */
export interface RetiredParcelNodeUnmeasured {
  parcelNodeId: string;
  reason: string;
}

/** One candidate's reading from a county's own live cadastral source. */
export interface LiveCurrencyMeasurement {
  reading: "live" | "absent" | "unmeasured";
  /** Why. Required in spirit for `unmeasured`; the caller supplies the transport reason. */
  reason?: string;
}

/**
 * A candidate's live-currency reading.
 *
 * A bare `boolean` is accepted for back-compat (`true` -> `live`, `false` -> `absent`).
 * An id ABSENT from the map is `unmeasured`, NOT `absent`: an empty result is not an
 * absence claim, it is the absence of a claim.
 */
export type LiveCurrencyReading =
  | boolean
  | "live"
  | "absent"
  | "unmeasured"
  | LiveCurrencyMeasurement;

export type LiveCurrencyReadings = ReadonlyMap<string, LiveCurrencyReading>;

const UNMEASURED_NO_READING =
  "no live-currency reading was taken for this parcel: the county's own cadastral source " +
  "did not answer for it, or no source is registered for the county";

function readLiveCurrency(value: LiveCurrencyReading | undefined): {
  reading: "live" | "absent" | "unmeasured";
  reason: string | null;
} {
  if (value === undefined) {
    return { reading: "unmeasured", reason: UNMEASURED_NO_READING };
  }
  if (value === true || value === "live") return { reading: "live", reason: null };
  if (value === false || value === "absent") return { reading: "absent", reason: null };
  if (value === "unmeasured") {
    return {
      reading: "unmeasured",
      reason: "the county's live-currency source reported no reading for this parcel",
    };
  }
  return { reading: value.reading, reason: value.reason ?? null };
}

export interface RetiredParcelNodeReviewVerdict {
  countyFips: string;
  /** Candidates a live source corroborated. The only rows a caller may reactivate. */
  reactivate: ReadonlyArray<RetiredParcelNodeReactivation>;
  /** Candidates the plan predicted again and the county's own source reports NOT PRESENT. */
  confirmedAbsent: ReadonlyArray<RetiredParcelNodeStillRetired>;
  /** Candidates nobody obtained a reading for. NOT an absence claim — do not report as one. */
  unmeasured: ReadonlyArray<RetiredParcelNodeUnmeasured>;
  /**
   * `confirmedAbsent` followed by `unmeasured`. Retained so existing consumers keep
   * working; a consumer that reports these as one number is reporting two different
   * facts as one, and should read `confirmedAbsent`/`unmeasured` directly instead.
   */
  stillRetired: ReadonlyArray<RetiredParcelNodeStillRetired>;
}

/**
 * Apply live corroboration to {@link reviewRetiredParcelNodes}'s candidates.
 *
 * Pure and synchronous on purpose: the live fetch (BCAD, or whatever per-county source
 * exists) happens once in the caller and is handed in as a plain reading map, so THIS
 * decision — which candidates actually get reactivated — is unit-testable against
 * fixtures instead of against a live endpoint. This is the `77293` guard: a candidate
 * the source did not corroborate stays retired, however confidently the internal plan
 * re-predicted it.
 *
 * P-275: the reading is tri-state. Only `live` reactivates. `absent` and `unmeasured`
 * both keep the row retired, but they are reported apart — `absent` is a measurement
 * the county's own source made, `unmeasured` is the absence of one (unreachable source,
 * unregistered county, transport failure, or an id the source simply was not asked about).
 */
export function decideRetiredParcelNodeReactivations(
  review: RetiredParcelNodeReview,
  liveCurrency: LiveCurrencyReadings,
): RetiredParcelNodeReviewVerdict {
  const reactivate: RetiredParcelNodeReactivation[] = [];
  const confirmedAbsent: RetiredParcelNodeStillRetired[] = [];
  const unmeasured: RetiredParcelNodeUnmeasured[] = [];
  for (const candidate of review.candidates) {
    const { reading, reason } = readLiveCurrency(
      liveCurrency.get(candidate.parcelNodeId),
    );
    if (reading === "live") {
      reactivate.push({
        parcelNodeId: candidate.parcelNodeId,
        reactivatedReason:
          `P-212 repair: parcel is present in the current plan for county ${review.countyFips} and ` +
          "confirmed live at the county's own cadastral source; the prior retirement " +
          `(${candidate.priorRetiredAt ?? "unknown time"}, reason: ${candidate.priorRetiredReason ?? "unknown"}) is reversed`,
      });
    } else if (reading === "absent") {
      confirmedAbsent.push({
        parcelNodeId: candidate.parcelNodeId,
        reason:
          `P-212 review: present in the current plan for county ${review.countyFips} but the ` +
          "county's own live cadastral source reports it NOT PRESENT (measured absent); " +
          "retirement stands pending stronger evidence",
      });
    } else {
      unmeasured.push({
        parcelNodeId: candidate.parcelNodeId,
        reason:
          `P-275 UNMEASURED: present in the current plan for county ${review.countyFips}, but ` +
          `${reason ?? UNMEASURED_NO_READING}; the retirement stands and this is NOT a ` +
          "finding that the parcel is gone",
      });
    }
  }
  return {
    countyFips: review.countyFips,
    reactivate,
    confirmedAbsent,
    unmeasured,
    stillRetired: [...confirmedAbsent, ...unmeasured],
  };
}
