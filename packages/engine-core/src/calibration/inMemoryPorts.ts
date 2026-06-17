import type {
  AdjudicationLedgerRow,
  CalibrationRepositoryPort,
  CorpusAtomRecord,
  OutcomeLedgerRow,
  OverlayRowRecord,
  ReasoningAtomRecord,
} from "./ports.js";

function overlayKey(atomId: string, jurisdictionTenant: string): string {
  return `${jurisdictionTenant}\0${atomId}`;
}

/** In-memory calibration port for behavior-parity tests (no Postgres). */
export class InMemoryCalibrationRepository implements CalibrationRepositoryPort {
  readonly overlayRows = new Map<string, OverlayRowRecord>();
  readonly reasoningAtoms = new Map<string, ReasoningAtomRecord>();
  readonly corpusAtoms = new Map<string, CorpusAtomRecord>();
  readonly adjudicationRows: AdjudicationLedgerRow[] = [];
  readonly outcomeRows: OutcomeLedgerRow[] = [];
  readonly findingCitations: Array<{ citations: unknown }> = [];

  async findOverlayRow(
    atomId: string,
    jurisdictionTenant: string,
  ): Promise<OverlayRowRecord | null> {
    return this.overlayRows.get(overlayKey(atomId, jurisdictionTenant)) ?? null;
  }

  async listOverlayRows(): Promise<OverlayRowRecord[]> {
    return [...this.overlayRows.values()];
  }

  async upsertOverlayRow(row: OverlayRowRecord): Promise<void> {
    this.overlayRows.set(overlayKey(row.atomId, row.jurisdictionTenant), {
      ...row,
    });
  }

  async updateOverlayRowsForAtom(
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
  ): Promise<void> {
    const key = overlayKey(atomId, patch.jurisdictionTenant);
    const existing = this.overlayRows.get(key);
    if (!existing) return;
    this.overlayRows.set(key, { ...existing, ...patch });
  }

  async findReasoningAtom(id: string): Promise<ReasoningAtomRecord | null> {
    return this.reasoningAtoms.get(id) ?? null;
  }

  async findReasoningAtoms(ids: string[]): Promise<ReasoningAtomRecord[]> {
    return ids
      .map((id) => this.reasoningAtoms.get(id))
      .filter((r): r is ReasoningAtomRecord => r != null);
  }

  async updateReasoningAtomCalibration(
    id: string,
    patch: {
      calibratedConfidence: string | null;
      calibrationStale: boolean;
      updatedAt: Date;
    },
  ): Promise<void> {
    const existing = this.reasoningAtoms.get(id);
    if (!existing) return;
    this.reasoningAtoms.set(id, { ...existing, ...patch });
  }

  async findCorpusAtom(id: string): Promise<CorpusAtomRecord | null> {
    return this.corpusAtoms.get(id.toLowerCase()) ?? null;
  }

  async loadAdjudicationLedgerRows(): Promise<AdjudicationLedgerRow[]> {
    return [...this.adjudicationRows];
  }

  async loadOutcomeLedgerRows(): Promise<OutcomeLedgerRow[]> {
    return [...this.outcomeRows];
  }

  async loadFindingCitations(): Promise<Array<{ citations: unknown }>> {
    return [...this.findingCitations];
  }
}
