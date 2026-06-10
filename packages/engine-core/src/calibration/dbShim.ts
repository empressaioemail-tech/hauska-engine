/**
 * Calibration partition types — lifted from @workspace/db for spine-local
 * engine-core. Full overlay I/O ports land in a follow-on PR.
 */

export const PUBLIC_CALIBRATION_TENANT = "__public__";

export type CalibrationPartitionKind =
  | "tenant-private"
  | "tenant-shared"
  | "public";

export type CalibrationGrain = "atom" | "overlay";
