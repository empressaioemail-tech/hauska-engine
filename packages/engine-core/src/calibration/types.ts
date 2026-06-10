import type {
  CalibrationGrain,
  CalibrationPartitionKind,
} from "./dbShim.js";

export type CalibrationStamp = {
  codeRef: string;
  edition: string;
  sourceSetVersion: number;
};

export type CalibrationSignal = {
  atomId: string;
  jurisdictionTenant: string;
  partitionKind: CalibrationPartitionKind;
  accessPolicy: string;
  sharedWithTenants: string[] | null;
  atomClass: string;
  stamp: CalibrationStamp;
  statedConfidence: number;
  /** 1 = positive (accept / permit-approved), 0 = negative (reject). */
  observedSuccess: number;
};

export type OverlayCalibrationRow = {
  atomId: string;
  jurisdictionTenant: string;
  partitionKind: CalibrationPartitionKind;
  accessPolicy: string;
  sharedWithTenants: string[] | null;
  assertedConfidence: number;
  calibratedConfidence: number | null;
  effectiveConfidence: number;
  calibrationGrade: "asserted" | "calibrated" | "stale";
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
  calibrationStale: boolean;
  calibrationGrain: CalibrationGrain;
  atomClass: string | null;
  signalCount: number;
};

export type AttributionCoverageHealth = {
  citationsResolved: number;
  overlayHits: number;
  attributionCoverageRate: number | null;
  misses: Array<{ atomId: string; jurisdictionTenant: string }>;
};
