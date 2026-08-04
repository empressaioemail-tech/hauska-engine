/**
 * The Warden — OPS-9 S5 post-onboarding sweep types. Files-never-fixes: the
 * Warden reads state and reports findings, it never writes/mints atoms. See
 * scripts/warden-sweep.mjs for the CLI and ledger-write.ts for the
 * findings-artifact / ledger-post seam.
 *
 * defectClass reuses the OPS-8 DefectClass string values
 * (registry/onboard-preflight.ts) where a Warden finding names the same
 * underlying gap an onboarding decline would have named (e.g.
 * SERVE-PATH-UNHEALTHY), plus one Warden-only addition —
 * "MIXED-VINTAGE-NEIGHBOR" — for the neighbor-consistency check's
 * patchy-absence/roster-drift finding shape, which has no OPS-8 preflight
 * analog (OPS-8 grades one row in isolation; the Warden's neighbor check
 * reasons over a whole cohort's adjacency). WardenDefectClass is a SEPARATE
 * union from onboard-preflight.ts's DefectClass — this file does not import
 * or modify that module's union.
 */

/** OPS-8 DefectClass string values, reused verbatim where a Warden finding names the same gap. */
export type OpsEightDefectClass =
  | "ADAPTER-NEEDED"
  | "PARCEL-LAYER-UNWIRED"
  | "GEOMETRY-DIVERGE"
  | "SUPERSEDED-GT3PCT"
  | "MEASURE-EMPTY-COHORT"
  | "SERVE-PATH-UNHEALTHY"
  | "COST-GATE"
  | "MIXED-VINTAGE";

/**
 * Warden's own defect-class union: every OPS-8 DefectClass value, plus
 * "MIXED-VINTAGE-NEIGHBOR" (new — a Warden-only class for neighbor-cohort
 * roster drift / patchy-absence findings, distinct from OPS-8's row-level
 * "MIXED-VINTAGE" residue-scan class).
 */
export type WardenDefectClass = OpsEightDefectClass | "MIXED-VINTAGE-NEIGHBOR";

/** The four v1 Warden sweep checks (files-never-fixes: each check READS and reports, never writes). */
export type WardenCheckId =
  | "neighborConsistency"
  | "servePathTruth"
  | "crossStoreConsistency"
  | "certFreshness";

export type WardenFindingSeverity = "info" | "flag";

/**
 * One finding emitted by a sweep check. A clean sweep still emits exactly one
 * severity:"info" event per run (see ledger-write.ts) so "swept and clean" is
 * provable, not merely the absence of output.
 */
export interface WardenFindingEvent {
  readonly ts: string;
  readonly sweepId: string;
  readonly rowId: string;
  readonly fips: string;
  /** Null when the finding is not scoped to a single parcel (e.g. the whole-sweep clean marker). */
  readonly parcelNodeId: string | null;
  readonly checkId: WardenCheckId;
  readonly defectClass: WardenDefectClass;
  readonly evidence: Record<string, unknown>;
  readonly severity: WardenFindingSeverity;
  readonly artifactRef: string;
}

/** One sweep's full report — the JSON artifact shape written by ledger-write.ts. */
export interface WardenSweepReport {
  readonly sweepId: string;
  readonly rowId: string;
  readonly fips: string;
  readonly ts: string;
  readonly checksRun: readonly WardenCheckId[];
  readonly findings: readonly WardenFindingEvent[];
  /** True when findings contains no severity:"flag" event. */
  readonly clean: boolean;
}
