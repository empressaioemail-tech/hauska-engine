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
