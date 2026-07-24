/**
 * Permit-outcome adapter types — Master WDLL 3.10 earning-loop fuel.
 *
 * Outcome kind vocabulary matches LDT `findingOutcomeObservation.ts`
 * (`permit-approved` | `variance-granted` | `comment-resolved`) so engine
 * calibration `signals.ts` OUTCOME_POSITIVE accepts the payload without
 * a parallel dialect.
 */

/** LDT `FINDING_OUTCOME_KINDS` — keep in lockstep. */
export const PERMIT_OUTCOME_KINDS = [
  "permit-approved",
  "variance-granted",
  "comment-resolved",
] as const;

export type PermitOutcomeKind = (typeof PERMIT_OUTCOME_KINDS)[number];

/** Stable jurisdiction tenant slugs used on ledger + overlay rows. */
export type PermitOutcomeJurisdiction =
  | "austin_tx"
  | "bastrop_tx"
  | "grand_county_ut"
  | "san_marcos_tx"
  | "san_antonio_tx"
  | "cedar_park_tx"
  | "new_braunfels_tx";

export type PermitOutcomeSourceId =
  | "austin-soda"
  | "bastrop-mygov"
  | "grand-county-ut"
  | "san-marcos-arcgis"
  | "san-antonio-csv"
  | "cedar-park-arcgis"
  | "new-braunfels-arcgis";

/**
 * Normalized finding-outcome shape (LDT-compatible payload fields) plus
 * public-record provenance for the earning-loop ledger.
 */
export interface NormalizedPermitOutcome {
  /** LDT-compatible outcome kind. */
  outcomeKind: PermitOutcomeKind;
  /** ISO-8601 observation time (issue/final/status date). */
  observedAt: string;
  /** Jurisdiction tenant key for ledger partition. */
  jurisdictionTenant: PermitOutcomeJurisdiction;
  /** Adapter source id (austin-soda, …). */
  sourceId: PermitOutcomeSourceId;
  /** Upstream permit / case number. */
  permitNumber: string;
  /** Upstream status string (verbatim). */
  statusCurrent: string;
  /** Situs / location line when present. */
  address: string | null;
  /** Appraisal / parcel hint when present (Austin TCAD geo-format id). */
  parcelHint: string | null;
  /** Public deeplink when present. */
  sourceUrl: string | null;
  /** Free-text notes (adapter + status mapping). */
  notes: string | null;
  /** Raw source dataset / portal id for provenance. */
  sourceDataset: string;
  /** Idempotency key — sha256 hex over (sourceId + permitNumber + status). */
  recordHash: string;
}

export interface PermitOutcomeFetchResult {
  sourceId: PermitOutcomeSourceId;
  jurisdictionTenant: PermitOutcomeJurisdiction;
  /** Rows successfully normalized. */
  outcomes: NormalizedPermitOutcome[];
  /**
   * When the source cannot yield bulk public rows without secrets,
   * grade PARTIAL and carry the reason (never invent rows).
   */
  partialReason: string | null;
  /** Upstream HTTP status when a network call ran. */
  httpStatus: number | null;
  fetchedAt: string;
}

export interface PermitOutcomeFetchOptions {
  /** Max rows to fetch/normalize. */
  limit?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}
