// The STATEWIDE THREE-LAYER AUDIT record — extended 2026-08-19 by lane SS-W9
// under OPS-16 amendment A-019.
//
// `serving-sweep.ts` (frozen 2026-08-18) answers ONE question: what does Smart
// Site SERVE a human. The operator's L26 screenshots showed that question is a
// third of the problem. Three layers exist and all three disagree, each in its
// own amount:
//
//     WRITTEN   atoms actually in the store
//     SCORED    the county_facet_coverage ledger cells
//     SERVED    what Smart Site actually shows a human
//
// The worked case, CORRECTED 2026-08-19 against the store. The planner's
// original claim here was that the ledger reports `footprint` as not-yet on all
// 254 cells BECAUSE it was materialized 67 hours before the work landed. That
// causal claim is wrong and the correction is the whole point of this record:
//
//   building-footprint atoms landed in 174 of 254 counties (3,495,678 rows,
//   2,829,513 parcels), closing 2026-08-17 12:43Z. The ledger does report
//   `footprint` as not-yet on all 254 cells, and it IS 4.8 days stale. But
//   staleness is not the mechanism. There is NO `footprint` row in
//   `county_facet_coverage` AT ALL, so the grid resolves `rail_state IS NULL`
//   to not-yet by display precedence and A RECOMPUTE WOULD MOVE ZERO OF THE 254
//   CELLS. Six of fourteen rails are in that position. The remediation is a
//   scorer that does not exist, not a refresh.
//
// Separately, flood is written for millions of parcels and reaches no user at
// all: `mergeBakedBaseFacts` never copies `tier2` into the served payload, and
// the live wire body carries no `tier2` key.
//
// THE ORDER OF THOSE THREE LAYERS IS THE COST OF THE FIX. Written-but-unscored
// is a scorer run. Written-but-unserved is a merge fix. Only genuinely
// unwritten is a re-ingest. A gap reported without its class invites somebody
// to scope a re-ingest for a merge bug, which is the mistake this record
// exists to make impossible.
//
// THIS FILE IS ADDITIVE. `StatewideServingSweep` is unchanged and remains the
// contract lane SS-W7's `GET /api/serving-sweep` serves. The three-layer audit
// rides as a new TOP-LEVEL field on the same document, the same way
// `manifestCells` rode onto the county ledger without disturbing `counties[]`.

import type { CountyServingSweep, StatewideServingSweep } from "../serving-sweep/types.js";

/** The fourteen ruled county rails. Ordinals per the 2026-08-09 R1 split. */
export type RailKey =
  | "geometry"
  | "cad"
  | "zoning"
  | "roads"
  | "flood"
  | "envelope"
  | "landuse"
  | "footprint"
  | "easement"
  | "owner"
  | "rrc-wells"
  | "rrc-pipelines"
  | "rail-corridor"
  | "mud";

/**
 * ONE layer's measurement of ONE rail in ONE county.
 *
 * `count` without `denominator` is not a result (DEV_PROCESS 1.3), and
 * `countingRule` exists because the whole P-43 programme started from two
 * true numbers that counted different things. A layer is never expressed as
 * a difference from another layer: subtracting one measurement from another
 * fabricates a third that nobody measured.
 */
export interface LayerMeasure {
  count: number;
  denominator: number;
  /** What ONE unit of `count` is, in words. Never omitted, never inferred. */
  countingRule: string;
  /**
   * When this figure was computed. A ledger figure is a claim about its
   * timestamp and NEVER about now — the live ledger has been staler than the
   * work it describes. `null` only where the layer was not measured.
   */
  computedAt: string | null;
  /** Where the number came from, precisely enough to re-run at source. */
  basis: string;
}

/**
 * Why a cell is short, expressed as THE REMEDIATION IT IMPLIES rather than as
 * a percentage. These are three different jobs with wildly different costs.
 */
export type GapClass =
  /** All three layers agree the rail is there. */
  | "no-gap"
  /** No atoms in the store. Remediation: ACQUISITION plus INGESTION. Most expensive. */
  | "unwritten"
  /** Atoms exist; the ledger carries no satisfied cell. Remediation: A SCORER RUN. */
  | "written-unscored"
  /** Atoms exist and are scored; the served sheet does not show it. Remediation: A MERGE OR ADAPTER FIX. Cheapest. */
  | "written-unserved"
  /**
   * Above the rail's own reachable ceiling. NOT a gap and must never be
   * counted as one: the RRC wells source is a Harris-only mirror, so scoring
   * it against 254 manufactures 253 holes that do not exist.
   */
  | "out-of-reach"
  /**
   * This instrument did not measure this layer for this cell. Stated, never
   * inferred as a zero. An empty result is not an absence.
   */
  | "not-measured";

/**
 * A rail's reachable ceiling, read live rather than assumed. Scoring a rail
 * against 254 when its source can only ever reach 1 county is the defect this
 * field closes.
 */
export interface RailCeiling {
  maxCountiesReachable: number | null;
  reachPct: number | null;
  sourceBasis: string;
  limitation: string | null;
  /** Where the ceiling was read, and when. */
  readFrom: string;
  readAt: string;
}

/** One rail in one county, measured on all three layers independently. */
export interface RailThreeLayerCell {
  countyFips: string;
  railKey: RailKey;

  written: LayerMeasure;
  scored: LayerMeasure;
  /** `null` means NOT MEASURED — the served sweep has not reached this county. */
  served: LayerMeasure | null;

  /**
   * The ledger's own display verdict for this cell, carried verbatim so the
   * audit never has to be trusted about what the console shows.
   */
  ledgerDisplayState: string | null;

  gapClass: GapClass;
  /**
   * One sentence naming the evidence for that class, so nobody re-derives it.
   * It ALWAYS opens with a stable token followed by ": ", because the two
   * sub-shapes of `written-unserved` cost very different amounts:
   *
   *   no-served-slot            the parcel fact sheet has no field for this
   *                             rail at all, so no merge could surface it
   *   served-slot-empty         the field exists and resolves absent
   *   scorer-absent             no ledger row exists for this facet at all,
   *                             so a RECOMPUTE would not move it either
   *   ledger-stale              a row exists but predates the write
   *   store-empty               no atoms
   *   ceiling-reached           above the rail's own reachable ceiling
   *   all-three-present         no gap
   *   layer-not-measured        this instrument did not reach it
   */
  gapBasis: string;
}

/** Statewide roll-up for one rail. Every count carries its denominator. */
export interface RailThreeLayerRollup {
  railKey: RailKey;
  atomEntityTypes: string[];
  ceiling: RailCeiling;

  /** Counties holding at least one atom of this family. PRESENCE, not depth. */
  countiesWritten: number;
  /** Atom ROWS, which is not the same as parcels for every family — see `atomsArePerParcel`. */
  atomsWritten: number;
  /** True only where the entity_id key proves one atom per parcel. */
  atomsArePerParcel: boolean;
  atomKeyShape: string;

  /** Counties whose ledger cell is satisfied-present or satisfied-absent. */
  countiesScoredSatisfied: number;
  countiesScoredNotYet: number;
  /** The ledger's materialization stamp. Every scored figure is a claim about this instant. */
  scoredComputedAt: string | null;

  /** Counties the served sweep has actually reached. */
  countiesServed: number;
  /** Parcels served with this field PRESENT, over parcels swept. */
  parcelsServedPresent: number | null;
  parcelsSwept: number | null;

  countiesTotal: number;
  gapCounts: Record<GapClass, number>;
}

/**
 * The address ladder, carried forward from SS-W5 exactly. Each rung counted
 * the next class of non-address as an address. There is no proof it has only
 * four rungs, and any figure that does not name its rung is not a result.
 */
export interface AddressLadder {
  denominatorParcels: number;
  denominatorCounties: number;
  measuredAt: string;
  rungs: Array<{
    rung: "non-null" | "non-blank" | "carries-a-street" | "carries-a-city";
    rule: string;
    parcels: number;
    pct: number;
    /** The sentinel this rung is known to let through, where one is known. */
    knownPassingSentinel: string | null;
  }>;
}

export interface StatewideThreeLayerAudit {
  auditedAt: string;
  /** Bump on any change that could move a number. */
  auditVersion: string;

  countiesTotal: number;
  /** Counties with a loaded parcel roster. The state has 254; 253 are loaded. */
  countiesLoaded: number;

  writtenComputedAt: string;
  scoredComputedAt: string | null;
  servedComputedAt: string | null;

  rails: RailThreeLayerRollup[];
  cells: RailThreeLayerCell[];
  addressLadder: AddressLadder;

  /**
   * Claims this audit could NOT establish, named so an absent measurement is
   * never read as a measured zero.
   */
  notMeasured: string[];
  /**
   * Two numbers that should agree and do not. Reconciled or named; never
   * rounded off.
   */
  contradictions: Array<{ id: string; claim: string; evidence: string }>;
}

/**
 * The published document. `StatewideServingSweep` is UNCHANGED — lane SS-W7's
 * `GET /api/serving-sweep` keeps working against the frozen shape — and the
 * audit rides as one additive top-level field.
 */
export interface StatewideSweepDocument extends StatewideServingSweep {
  threeLayer: StatewideThreeLayerAudit;
}

export type { CountyServingSweep, StatewideServingSweep };
