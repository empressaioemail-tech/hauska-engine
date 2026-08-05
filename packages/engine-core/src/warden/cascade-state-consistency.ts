/**
 * Warden v1.1 — decline-code-aware cross-store grading (files-never-fixes).
 *
 * The unzoned-county cert grader (gradeUnzonedParcel) only PASSes parcels
 * carrying warmVerifyDeclineCode === unzoned-no-district-basis. In-city
 * parcels on a mixed county correctly carry no-district-on-record instead —
 * gradeUnzonedParcel reports cascade-missing even though the DB state is
 * coherent. This module classifies those cases so crossStoreConsistency
 * does not false-flag them, while still surfacing genuine cascade gaps under
 * CASCADE-STATE-MISMATCH (distinct from GEOMETRY-DIVERGE).
 */
import {
  UNZONED_CASCADE_DECLINE_CODE,
  type ParcelGradeResult,
} from "../registry/cert-grade-core.js";
import type { WardenDefectClass } from "./types.js";

/** In-city honest-decline code (cascade-unzoned-envelope-decline.ts); duplicated as a string literal to keep this module import-guard clean. */
export const NO_DISTRICT_ON_RECORD_DECLINE_CODE = "no-district-on-record";

/** Decline codes that represent a valid, named honest-absence envelope state. */
export const VALID_CASCADE_DECLINE_CODES: ReadonlySet<string> = new Set([
  UNZONED_CASCADE_DECLINE_CODE,
  NO_DISTRICT_ON_RECORD_DECLINE_CODE,
]);

const CASCADE_STATE_MISMATCH_REASONS: ReadonlySet<string> = new Set([
  "cascade-missing",
  "expected-unzoned-but-district-present",
  "unexpected-setback-rule",
  "cadastral-ring-unresolved",
  "cadastral-query-url-not-configured",
]);

/**
 * True when the latest envelope's warmVerifyDeclineCode is one of the two
 * city/county-aware honest-decline codes minted by the cascade builder.
 */
export function isValidNamedCascadeDecline(observedDeclineCode: string | null | undefined): boolean {
  return typeof observedDeclineCode === "string" && VALID_CASCADE_DECLINE_CODES.has(observedDeclineCode);
}

/**
 * A failed grade is cross-store CONSISTENT (no finding) when the DB already
 * carries a valid named decline on the envelope, even if the unzoned cert
 * grader would not PASS that parcel on the cert lane.
 */
export function isCrossStoreGradeConsistent(
  result: ParcelGradeResult,
  observedDeclineCode: string | null | undefined,
): boolean {
  if (result.pass) return true;
  if (isValidNamedCascadeDecline(observedDeclineCode)) return true;
  return false;
}

/**
 * Maps a failed, non-consistent grade to the honest Warden defect class.
 * Cascade/envelope-state gaps are CASCADE-STATE-MISMATCH; true geometry /
 * warm parity failures stay GEOMETRY-DIVERGE.
 */
export function defectClassForFailedGrade(result: ParcelGradeResult): WardenDefectClass {
  const reason = result.reason ?? "";
  if (CASCADE_STATE_MISMATCH_REASONS.has(reason)) return "CASCADE-STATE-MISMATCH";
  return "GEOMETRY-DIVERGE";
}
