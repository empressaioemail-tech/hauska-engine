/**
 * Factory 1.5 L2 — pinned outcome statuses (CP1 locked).
 * Never model discovery as boolean found/absent.
 */

export const OUTCOME_STATUSES = [
  "NO-ZONING-AUTHORITY",
  "NO-EUCLIDEAN-REGIME",
  "ORDINANCE-NO-GIS",
  "AUTH-WALLED",
  "HOST-BROKEN",
  "NOT-FOUND-UNKNOWN-WHY",
  "LAYER-FOUND",
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Landed statuses — resume skip set uses these only. */
export const LANDED_OUTCOME_STATUSES = [
  "NO-ZONING-AUTHORITY",
  "NO-EUCLIDEAN-REGIME",
  "ORDINANCE-NO-GIS",
  "AUTH-WALLED",
  "LAYER-FOUND",
] as const satisfies readonly OutcomeStatus[];

/** HOST-BROKEN is landed for resume (positive endpoint determination). */
export const NON_LANDED_REENTER_STATUSES = [
  "NOT-FOUND-UNKNOWN-WHY",
  "HOST-BROKEN",
] as const satisfies readonly OutcomeStatus[];

export function isOutcomeStatus(value: string): value is OutcomeStatus {
  return (OUTCOME_STATUSES as readonly string[]).includes(value);
}

export function isLandedOutcome(status: OutcomeStatus): boolean {
  return status === "HOST-BROKEN" || (LANDED_OUTCOME_STATUSES as readonly string[]).includes(status);
}

export function isReenterOutcome(status: OutcomeStatus): boolean {
  return (NON_LANDED_REENTER_STATUSES as readonly string[]).includes(status);
}

export function assertOutcomeStatus(value: string): OutcomeStatus {
  if (!isOutcomeStatus(value)) {
    throw new Error(`Invalid outcome status: ${value}`);
  }
  return value;
}
