import type {
  CalibrationGrain,
  CalibrationPartitionKind,
} from "./dbShim.js";

/** Persisted overlay row shape (cortex Neon `atom_calibration_overlay`). */
export type OverlayRowRecord = {
  atomId: string;
  jurisdictionTenant: string;
  partitionKind: CalibrationPartitionKind;
  accessPolicy: string;
  sharedWithTenants: string[] | null;
  assertedConfidence: string;
  calibratedConfidence: string | null;
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
  calibrationStale: boolean;
  calibrationGrain: CalibrationGrain;
  atomClass: string | null;
  signalCount: number;
  updatedAt?: Date;
};

export type ReasoningAtomRecord = {
  id: string;
  accessPolicy: string;
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
  assertedConfidence: string;
  calibratedConfidence: string | null;
  calibrationStale: boolean;
};

export type CorpusAtomRecord = {
  id: string;
  sectionNumber: string | null;
  edition: string | null;
  sourceType: string | null;
};

export type EngagementTenantFields = {
  cortexJurisdictionKey: string | null;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdiction: string | null;
  address: string | null;
};

export type AdjudicationLedgerRow = EngagementTenantFields & {
  eventType: string;
  citations: unknown;
  confidence: string | null;
};

export type OutcomeLedgerRow = EngagementTenantFields & {
  payload: unknown;
  citations: unknown;
  confidence: string | null;
};

export type AtomAccessContext = {
  atomId: string;
  accessPolicy: string;
  sharedWithTenants: string[] | null;
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
  assertedConfidence: number;
};

/**
 * Repository port for arrow-two calibration overlay I/O.
 *
 * Topology A (recon): implemented against the cortex deployment Neon where
 * migration 0037 `atom_calibration_overlay` and the adjudication ledger live.
 * The spine engine-core never reads the retrieval substrate Neon for overlay rows.
 */
export interface CalibrationRepositoryPort {
  findOverlayRow(
    atomId: string,
    jurisdictionTenant: string,
  ): Promise<OverlayRowRecord | null>;

  listOverlayRows(): Promise<OverlayRowRecord[]>;

  upsertOverlayRow(row: OverlayRowRecord): Promise<void>;

  updateOverlayRowsForAtom(
    atomId: string,
    patch: Partial<
      Pick<
        OverlayRowRecord,
        | "calibrationStale"
        | "calibratedConfidence"
        | "sourceSetVersion"
        | "updatedAt"
      >
    > & { jurisdictionTenant: string },
  ): Promise<void>;

  findReasoningAtom(id: string): Promise<ReasoningAtomRecord | null>;

  findReasoningAtoms(ids: string[]): Promise<ReasoningAtomRecord[]>;

  updateReasoningAtomCalibration(
    id: string,
    patch: {
      calibratedConfidence: string | null;
      calibrationStale: boolean;
      updatedAt: Date;
    },
  ): Promise<void>;

  findCorpusAtom(id: string): Promise<CorpusAtomRecord | null>;

  loadAdjudicationLedgerRows(): Promise<AdjudicationLedgerRow[]>;

  loadOutcomeLedgerRows(): Promise<OutcomeLedgerRow[]>;

  loadFindingCitations(): Promise<Array<{ citations: unknown }>>;
}

export type JurisdictionTenantResolver = (
  engagement: EngagementTenantFields,
) => string | null;
