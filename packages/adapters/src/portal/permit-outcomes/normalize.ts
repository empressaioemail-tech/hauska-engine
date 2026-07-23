import { createHash } from "node:crypto";
import {
  PERMIT_OUTCOME_KINDS,
  type NormalizedPermitOutcome,
  type PermitOutcomeKind,
  type PermitOutcomeJurisdiction,
  type PermitOutcomeSourceId,
} from "./types";

/**
 * Map a raw municipal status string onto LDT outcome kinds.
 * Issued / active / final / approved → permit-approved.
 * Variance vocabulary → variance-granted when explicit.
 * Everything else with a clear deny → still emits permit-approved=false
 * path by omitting (caller filters); we only emit positive kinds that
 * calibration OUTCOME_POSITIVE understands, matching LDT Phase-2 capture.
 */
export function mapStatusToOutcomeKind(
  statusRaw: string | null | undefined,
): PermitOutcomeKind | null {
  if (!statusRaw) return null;
  const s = statusRaw.trim().toLowerCase();
  if (!s) return null;

  if (
    /\b(denied|rejected|void|cancelled|canceled|withdrawn|expired)\b/.test(s)
  ) {
    return null;
  }
  if (/\bvariance\b/.test(s) && /\b(granted|approved|final)\b/.test(s)) {
    return "variance-granted";
  }
  if (
    /\b(issued|active|final|finaled|approved|complete|closed|certificate of occupancy|co issued)\b/.test(
      s,
    )
  ) {
    return "permit-approved";
  }
  // Austin "Active" after issue_date is the common happy path.
  if (s === "active" || s === "issued") return "permit-approved";
  return null;
}

export function isPermitOutcomeKind(v: unknown): v is PermitOutcomeKind {
  return (
    typeof v === "string" &&
    (PERMIT_OUTCOME_KINDS as readonly string[]).includes(v)
  );
}

export function permitOutcomeRecordHash(args: {
  sourceId: PermitOutcomeSourceId;
  permitNumber: string;
  statusCurrent: string;
  observedAt: string;
}): string {
  return createHash("sha256")
    .update(
      [
        args.sourceId,
        args.permitNumber,
        args.statusCurrent,
        args.observedAt,
      ].join("\0"),
    )
    .digest("hex");
}

export function buildNormalizedOutcome(args: {
  outcomeKind: PermitOutcomeKind;
  observedAt: string;
  jurisdictionTenant: PermitOutcomeJurisdiction;
  sourceId: PermitOutcomeSourceId;
  permitNumber: string;
  statusCurrent: string;
  address?: string | null;
  parcelHint?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
  sourceDataset: string;
}): NormalizedPermitOutcome {
  const observedAt = args.observedAt;
  return {
    outcomeKind: args.outcomeKind,
    observedAt,
    jurisdictionTenant: args.jurisdictionTenant,
    sourceId: args.sourceId,
    permitNumber: args.permitNumber,
    statusCurrent: args.statusCurrent,
    address: args.address ?? null,
    parcelHint: args.parcelHint ?? null,
    sourceUrl: args.sourceUrl ?? null,
    notes: args.notes ?? null,
    sourceDataset: args.sourceDataset,
    recordHash: permitOutcomeRecordHash({
      sourceId: args.sourceId,
      permitNumber: args.permitNumber,
      statusCurrent: args.statusCurrent,
      observedAt,
    }),
  };
}

/** LDT-compatible atom_events payload (finding.outcome.recorded). */
export function toFindingOutcomePayload(
  outcome: NormalizedPermitOutcome,
): Record<string, unknown> {
  return {
    outcomeKind: outcome.outcomeKind,
    jurisdictionTenant: outcome.jurisdictionTenant,
    findingAtomId: permitOutcomeEntityId(outcome),
    observedAt: outcome.observedAt,
    notes: outcome.notes,
    // Adapter provenance (extra fields; LDT parser ignores unknowns).
    provenance: "backtest",
    sourceId: outcome.sourceId,
    sourceDataset: outcome.sourceDataset,
    permitNumber: outcome.permitNumber,
    statusCurrent: outcome.statusCurrent,
    address: outcome.address,
    parcelHint: outcome.parcelHint,
    sourceUrl: outcome.sourceUrl,
    recordHash: outcome.recordHash,
  };
}

/** Stable entity id for the outcome ledger row. */
export function permitOutcomeEntityId(outcome: NormalizedPermitOutcome): string {
  return `permit-outcome:${outcome.jurisdictionTenant}:${outcome.permitNumber}`;
}
