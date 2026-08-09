/**
 * C1/C5 WARM PREFLIGHT GATE — the seam check between the two factories.
 *
 * The statewide factory PRODUCES `parcel-node` atoms. The jurisdiction factory
 * CONSUMES them to warm claims (zoning, setbacks, envelope) about a parcel.
 * Nothing checked that ordering. `depth-warm-*-batch.mjs` sizes its cohort from
 * `zoning-fact` presence and never reads a `parcel-node` at all, so a parcel
 * with no anchor — or with an anchor that is a typed ABSENCE, or a synthetic
 * non-account key, or a retired row pointing at deleted geometry — could be
 * warmed and promoted as if its geometry were established.
 *
 * ---------------------------------------------------------------------------
 * INVARIANT S3 — NO PARCEL IS WARMED WITHOUT A LIVE, RESOLVED, ACCOUNT-KEYED
 * PARCEL-NODE ANCHOR.
 *
 * Recipe eligibility (a `zoning-fact` exists, a setback row exists) says which
 * CLAIM could be computed. It says nothing about whether the parcel the claim
 * is about is established. The warm set is the INTERSECTION of recipe
 * eligibility and parcel-node eligibility, never recipe eligibility alone.
 *
 * ENFORCING MECHANISM: {@link parcelNodeWarmEligibility} is a total function
 * over the anchor state — every input shape returns either `eligible` or a
 * NAMED decline code; there is no path that returns undefined or throws and
 * gets skipped past. The batch entry calls it before compute and records the
 * decline, so a parcel that fails the gate is COUNTED as refused rather than
 * silently absent from the output. `assertWarmGateApplied` is the fail-closed
 * companion: a run whose processed count does not reconcile against
 * gate-passed plus gate-declined has bypassed the gate somewhere, and that
 * fails the run rather than being reported as success.
 *
 * The decline codes are contract-visible strings, not engine-only fields that
 * die at the MCP boundary. A refusal a customer cannot see is a silent drop.
 */

import { isSyntheticParcelKey } from "./plan-county-parcel-nodes.js";

/** Named refusals. Every non-eligible outcome is one of these — no `other`. */
export type WarmDeclineCode =
  /** No `parcel-node` atom exists for this id at all. */
  | "no-parcel-node-anchor"
  /** The anchor exists but is a typed absence (`geometryLoaded: false`). */
  | "parcel-node-absence"
  /** The anchor's key is synthetic (`_feature-*`), not an account. */
  | "parcel-node-key-unresolved"
  /** The anchor was retired (re-acquisition orphan); its geometry is gone. */
  | "parcel-node-retired"
  /** The anchor points at geometry the serving path cannot reduce to one ring. */
  | "parcel-node-geometry-incomplete"
  /** The anchor's pointer names a different parcel than the atom claims. */
  | "parcel-node-pointer-mismatch";

/**
 * The anchor as read from the atom store. `null` for "no row found" — the
 * caller must pass null rather than omitting the parcel, so the absence is
 * gated and counted instead of falling out of a loop.
 */
export interface ParcelNodeAnchorState {
  parcelNodeId: string;
  status: "active" | "retired";
  geometryLoaded: boolean;
  absenceKind?: string | null;
  keyKind?: string | null;
  geometryStoreRef?: {
    countyFips: string;
    propId: string;
  } | null;
}

export type WarmEligibility =
  | { eligible: true; parcelNodeId: string }
  | { eligible: false; parcelNodeId: string; declineCode: WarmDeclineCode; reason: string };

/**
 * Decide whether one parcel may enter warm/promote.
 *
 * TOTAL over the input domain: `null` anchor, retired anchor, absence anchor,
 * synthetic key, missing/mismatched pointer, and the resolved case all return
 * an explicit verdict. There is deliberately no fallthrough that returns
 * eligible by default — a state this function does not recognize must not be
 * warmable, so the resolved branch is reached only by passing every check.
 */
export function parcelNodeWarmEligibility(
  parcelNodeId: string,
  anchor: ParcelNodeAnchorState | null,
): WarmEligibility {
  // Invariant S1 at the consumer: a synthetic feature key carries no account
  // identity, so nothing may be claimed ABOUT it. Checked on the requested id
  // before the anchor is even consulted, so a synthetic key is refused even if
  // some row happens to exist for it.
  if (isSyntheticParcelKey(parcelNodeId)) {
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "parcel-node-key-unresolved",
      reason:
        "parcelNodeId is a synthetic feature-index key, not a CAD account; it is an absence " +
        "finding about an unidentifiable source feature and can never anchor a jurisdiction claim",
    };
  }

  if (anchor === null) {
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "no-parcel-node-anchor",
      reason:
        "no parcel-node atom exists for this parcel; the statewide factory has not established " +
        "that this parcel exists, so a jurisdiction claim about it would have no subject",
    };
  }

  if (anchor.status === "retired") {
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "parcel-node-retired",
      reason:
        "parcel-node anchor is retired — the source no longer publishes this parcel, so its " +
        "geometry pointer does not resolve and any claim about it would be stale",
    };
  }

  if (!anchor.geometryLoaded) {
    const kind = anchor.absenceKind ?? "unspecified";
    if (kind === "geometry-incomplete") {
      return {
        eligible: false,
        parcelNodeId,
        declineCode: "parcel-node-geometry-incomplete",
        reason:
          "parcel-node anchor reports geometry-incomplete: the ring is in the store but the " +
          "single-ring serving path declines it (MULTI_PART_GEOMETRY_UNSUPPORTED), so no " +
          "servable ring backs a warm result",
      };
    }
    if (kind === "parcel-key-unresolved") {
      return {
        eligible: false,
        parcelNodeId,
        declineCode: "parcel-node-key-unresolved",
        reason:
          "parcel-node anchor reports parcel-key-unresolved: no account key was established for " +
          "this source feature",
      };
    }
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "parcel-node-absence",
      reason: `parcel-node anchor is a typed absence (${kind}); absence is a finding, not a warm anchor`,
    };
  }

  const ref = anchor.geometryStoreRef;
  if (!ref) {
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "parcel-node-pointer-mismatch",
      reason:
        "parcel-node anchor claims geometryLoaded but carries no geometryStoreRef; there is no " +
        "pointer to follow to a ring",
    };
  }
  if (`${ref.countyFips}:${ref.propId}` !== anchor.parcelNodeId) {
    return {
      eligible: false,
      parcelNodeId,
      declineCode: "parcel-node-pointer-mismatch",
      reason:
        `parcel-node geometryStoreRef points at ${ref.countyFips}:${ref.propId} but the anchor is ` +
        `${anchor.parcelNodeId}; following the pointer would resolve a different parcel's ring`,
    };
  }

  return { eligible: true, parcelNodeId };
}

export interface WarmGateTally {
  passed: number;
  declined: number;
  byCode: Record<WarmDeclineCode, number>;
}

export function emptyWarmGateTally(): WarmGateTally {
  return {
    passed: 0,
    declined: 0,
    byCode: {
      "no-parcel-node-anchor": 0,
      "parcel-node-absence": 0,
      "parcel-node-key-unresolved": 0,
      "parcel-node-retired": 0,
      "parcel-node-geometry-incomplete": 0,
      "parcel-node-pointer-mismatch": 0,
    },
  };
}

export function tallyWarmEligibility(
  tally: WarmGateTally,
  verdict: WarmEligibility,
): WarmGateTally {
  if (verdict.eligible) {
    tally.passed += 1;
  } else {
    tally.declined += 1;
    tally.byCode[verdict.declineCode] += 1;
  }
  return tally;
}

/**
 * Gate the WHOLE COHORT and report the intersection.
 *
 * `anchorsById` must be the anchors actually read from the store. A parcel with
 * no entry is passed to the gate as `null`, so "we did not find an anchor" is
 * a counted decline rather than a parcel that quietly never appears.
 */
export function gateWarmCohort(
  candidateParcelNodeIds: ReadonlyArray<string>,
  anchorsById: ReadonlyMap<string, ParcelNodeAnchorState>,
): {
  eligible: ReadonlyArray<string>;
  declined: ReadonlyArray<WarmEligibility & { eligible: false }>;
  tally: WarmGateTally;
} {
  const eligible: string[] = [];
  const declined: Array<WarmEligibility & { eligible: false }> = [];
  const tally = emptyWarmGateTally();

  for (const id of candidateParcelNodeIds) {
    const verdict = parcelNodeWarmEligibility(id, anchorsById.get(id) ?? null);
    tallyWarmEligibility(tally, verdict);
    if (verdict.eligible) eligible.push(id);
    else declined.push(verdict);
  }

  return { eligible, declined, tally };
}

export type WarmGateVerdict =
  | { ok: true }
  | { ok: false; problem: string };

/**
 * Fail-closed reconciliation for invariant S3.
 *
 * A batch that processed more parcels than the gate accounted for has a path
 * into compute that skipped the gate. That is exactly how "recipe eligibility
 * alone can promote" survives a gate being added, so the arithmetic is checked
 * rather than assumed.
 */
export function assertWarmGateApplied(
  cohortSize: number,
  tally: WarmGateTally,
): WarmGateVerdict {
  const accounted = tally.passed + tally.declined;
  if (accounted !== cohortSize) {
    return {
      ok: false,
      problem:
        `warm gate accounted for ${accounted} parcels but the cohort was ${cohortSize}; ` +
        `${cohortSize - accounted} parcel(s) reached compute without a parcel-node verdict`,
    };
  }
  return { ok: true };
}
