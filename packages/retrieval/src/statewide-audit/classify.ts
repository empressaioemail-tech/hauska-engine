// GAP CLASSIFICATION — lane SS-W9, PLAN-ROW P-43.
//
// A gap reported as a percentage tells you nothing about what it costs to
// close. A gap reported as a CLASS tells you exactly one thing: which job to
// scope. That is the whole point of this file.
//
//     unwritten         acquire and ingest        most expensive
//     written-unscored  run a scorer              cheap, but see scorer-absent
//     written-unserved  fix a merge or an adapter cheapest
//     out-of-reach      NOT A GAP
//     not-measured      this instrument did not look; never a zero
//
// Every function here is pure. `classifyCell` is exercised by
// `__tests__/classify.test.ts`, which proves EVERY class can fire and that
// mutating one input moves the class — because a classifier whose zeros have
// never been shown to be reachable is a dead gate, and dead gates are the
// defect class this programme hunts.

import type { GapClass, RailKey } from "./types.js";

/**
 * The parcel fact sheet's field for a rail, or `null` where the sheet has no
 * slot for it AT ALL.
 *
 * This map is load-bearing and it is a FINDING in its own right: seven of the
 * fourteen rails have no field on the served sheet, so no amount of writing or
 * scoring could ever surface them through this surface. `null` here means the
 * remediation is "add a field", not "fix a merge", and the two must not be
 * priced the same.
 *
 * Field keys are the frozen `FieldKey` union in `../serving-sweep/types.ts`.
 */
export const SERVED_FIELD_BY_RAIL: Readonly<Record<RailKey, string | null>> = {
  geometry: "geometry",
  cad: "situsAddress",
  zoning: "zoning",
  roads: "frontage",
  flood: "flood",
  envelope: "envelope",
  landuse: "landUse",
  footprint: null,
  easement: null,
  owner: null,
  "rrc-wells": null,
  "rrc-pipelines": null,
  "rail-corridor": null,
  mud: null,
};

export interface CellInput {
  countyFips: string;
  railKey: RailKey;

  /** Atom rows of this rail's family holding this county's prefix. */
  writtenAtoms: number;

  /**
   * Whether `county_facet_coverage` holds ANY row for (county, facet).
   * FALSE is materially worse than an unsatisfied row: it means no scorer has
   * ever emitted this facet, so recomputing the ledger snapshot cannot move it.
   */
  scoredRowExists: boolean;
  /** The ledger's own display verdict, carried verbatim. */
  ledgerDisplayState: string | null;
  /** When the ledger figure was computed. A ledger figure is a claim about this instant. */
  scoredComputedAt: string | null;
  /** When this county's atoms for this rail were most recently written, where known. */
  writtenAt: string | null;

  /** `null` when the served sweep has not reached this county. */
  servedPresentParcels: number | null;
  servedSweptParcels: number | null;

  /** Counties in which this rail has ANY atom, statewide. */
  railCountiesWritten: number;
  /** The rail's own reachable ceiling in counties, or `null` when unprobed. */
  railCeilingCounties: number | null;
  countiesTotal: number;
}

export interface CellVerdict {
  gapClass: GapClass;
  gapBasis: string;
}

const SATISFIED = new Set(["satisfied-present", "satisfied-absent"]);

/** The ledger cell counts as satisfied only on its own two satisfied states. */
export function isScoredSatisfied(ledgerDisplayState: string | null): boolean {
  return ledgerDisplayState !== null && SATISFIED.has(ledgerDisplayState);
}

/**
 * True when the ledger figure was computed BEFORE the atoms landed, i.e. the
 * ledger is a claim about an instant that predates the work it describes.
 * Returns false whenever either stamp is unknown — an unknown is never
 * upgraded into an accusation.
 */
export function isLedgerStalerThanTheWrite(
  scoredComputedAt: string | null,
  writtenAt: string | null,
): boolean {
  if (!scoredComputedAt || !writtenAt) return false;
  const s = Date.parse(scoredComputedAt);
  const w = Date.parse(writtenAt);
  if (Number.isNaN(s) || Number.isNaN(w)) return false;
  return s < w;
}

/**
 * PRECEDENCE, and it is deliberate:
 *
 *  1. nothing written        -> unwritten, unless the rail is already at its
 *                               own ceiling, in which case out-of-reach
 *  2. written, not scored    -> written-unscored (scorer-absent is the worse
 *                               sub-shape and is named, because a ledger
 *                               RECOMPUTE cannot move it)
 *  3. written, scored, served layer not reached -> not-measured
 *  4. written, scored, no served slot exists    -> written-unserved
 *  5. written, scored, slot exists but empty    -> written-unserved
 *  6. all three present                          -> no-gap
 *
 * Scoring is checked before serving because the ledger is what the operator
 * reads to decide what to work on: a rail nobody can SEE is not scoped, and a
 * rail scoped from a stale cell is scoped wrong.
 *
 * `no-gap` is a PRESENCE verdict for this county, never a depth claim. Depth
 * lives in the counts, which is why the counts are never collapsed into it.
 */
export function classifyCell(input: CellInput): CellVerdict {
  const {
    writtenAtoms,
    scoredRowExists,
    ledgerDisplayState,
    scoredComputedAt,
    writtenAt,
    servedPresentParcels,
    servedSweptParcels,
    railKey,
    railCountiesWritten,
    railCeilingCounties,
    countiesTotal,
  } = input;

  const ceilingBinds =
    railCeilingCounties !== null &&
    railCeilingCounties < countiesTotal &&
    railCountiesWritten <= railCeilingCounties;

  if (writtenAtoms === 0) {
    if (ceilingBinds) {
      return {
        gapClass: "out-of-reach",
        gapBasis: `ceiling-reached: the rail holds atoms in ${railCountiesWritten} counties against its own reachable ceiling of ${railCeilingCounties} of ${countiesTotal}; an empty county here is not a hole this rail's source could fill.`,
      };
    }
    return {
      gapClass: "unwritten",
      gapBasis: `store-empty: zero atoms of this family carry this county's prefix. Remediation is acquisition plus ingestion, the most expensive of the three.`,
    };
  }

  if (!isScoredSatisfied(ledgerDisplayState)) {
    if (!scoredRowExists) {
      return {
        gapClass: "written-unscored",
        gapBasis: `scorer-absent: ${writtenAtoms} atoms are written and county_facet_coverage holds NO row for this facet at all, so the cell reads not-yet by precedence and RECOMPUTING THE LEDGER WOULD NOT MOVE IT. Remediation is building or running a scorer for this facet, not a refresh.`,
      };
    }
    if (isLedgerStalerThanTheWrite(scoredComputedAt, writtenAt)) {
      return {
        gapClass: "written-unscored",
        gapBasis: `ledger-stale: ${writtenAtoms} atoms are written and the ledger row was computed ${scoredComputedAt}, BEFORE the write at ${writtenAt}. Remediation is a scorer run plus a ledger recompute.`,
      };
    }
    return {
      gapClass: "written-unscored",
      gapBasis: `ledger-stale: ${writtenAtoms} atoms are written and the ledger cell reads ${ledgerDisplayState ?? "no row"}. Remediation is a scorer run.`,
    };
  }

  if (SERVED_FIELD_BY_RAIL[railKey] === null) {
    return {
      gapClass: "written-unserved",
      gapBasis: `no-served-slot: written and scored, but the parcel fact sheet carries no field for this rail, so no merge could surface it. Remediation is adding a served field, which is larger than a merge fix and must not be priced as one.`,
    };
  }

  if (servedPresentParcels === null || servedSweptParcels === null) {
    return {
      gapClass: "not-measured",
      gapBasis: `layer-not-measured: written and scored; the served sweep has not reached this county, so its served state is unknown. An absent measurement is not a zero.`,
    };
  }

  if (servedPresentParcels === 0) {
    return {
      gapClass: "written-unserved",
      gapBasis: `served-slot-empty: written and scored, and the served field resolves absent on 0 of ${servedSweptParcels} swept parcels. Remediation is a merge or adapter fix, the cheapest of the three.`,
    };
  }

  return {
    gapClass: "no-gap",
    gapBasis: `all-three-present: ${writtenAtoms} atoms written, ledger ${ledgerDisplayState}, served present on ${servedPresentParcels} of ${servedSweptParcels} swept parcels. Presence on all three layers; this is not a depth claim.`,
  };
}

/** Every class this classifier can emit. Used by the liveness test as its checklist. */
export const ALL_GAP_CLASSES: readonly GapClass[] = [
  "no-gap",
  "unwritten",
  "written-unscored",
  "written-unserved",
  "out-of-reach",
  "not-measured",
];

export function emptyGapCounts(): Record<GapClass, number> {
  return {
    "no-gap": 0,
    unwritten: 0,
    "written-unscored": 0,
    "written-unserved": 0,
    "out-of-reach": 0,
    "not-measured": 0,
  };
}
