/**
 * Per-jurisdiction cost tracking — Stream 1D.
 *
 * Operationalizes commitment #3: **under $200 compute + 1 hour human
 * review per new jurisdiction; hard kill at three counties if not
 * achievable.** Per CLAUDE.md "Cost per jurisdiction rule": "Flag any
 * onboarding exceeding the target for engineering review."
 *
 * Cost lines:
 *   - LLM tokens (atomization OCR + curated-query generation)
 *   - OCR spend (Claude vision / Tesseract fallback)
 *   - Embedding compute (vector index population)
 *   - Infrastructure attributable (Cloud Run job runtime)
 *   - Human-review-hours (operator CLI records review-start / review-finish)
 *
 * Hard-kill checkpoint enforced in code: after first three counties,
 * if the average exceeds the target, halt batch ingest and surface
 * to Nick.
 */

export const TARGET_COMPUTE_DOLLARS = 200;
export const TARGET_HUMAN_REVIEW_MINUTES = 60;
export const HARD_KILL_CHECKPOINT_COUNTIES = 3;

export interface CostRecord {
  recordId: string;
  jurisdictionTenant: string;
  runDate: string;
  llmTokensCostCents: number;
  ocrCostCents: number;
  embeddingCostCents: number;
  infrastructureCostCents: number;
  humanReviewMinutes: number;
  notes: string | null;
  flaggedOverTarget: boolean;
  createdAt: string;
}

export interface CostBreakdown {
  totalComputeCents: number;
  totalHumanReviewMinutes: number;
  overTarget: boolean;
}

export function summarizeCost(record: CostRecord): CostBreakdown {
  const totalComputeCents =
    record.llmTokensCostCents +
    record.ocrCostCents +
    record.embeddingCostCents +
    record.infrastructureCostCents;
  const overTarget =
    totalComputeCents > TARGET_COMPUTE_DOLLARS * 100 ||
    record.humanReviewMinutes > TARGET_HUMAN_REVIEW_MINUTES;
  return {
    totalComputeCents,
    totalHumanReviewMinutes: record.humanReviewMinutes,
    overTarget,
  };
}

export interface CostPort {
  upsert(record: CostRecord): Promise<void>;
  /** Per-jurisdiction aggregate. Sum across all runs for a jurisdiction. */
  aggregate(jurisdictionTenant: string): Promise<CostBreakdown>;
  /** Lists all jurisdictions tracked so far with aggregate breakdowns. */
  listAggregates(): Promise<ReadonlyArray<{ jurisdictionTenant: string; breakdown: CostBreakdown }>>;
}

export class InMemoryCostPort implements CostPort {
  private readonly records = new Map<string, CostRecord>();

  async upsert(record: CostRecord): Promise<void> {
    this.records.set(record.recordId, record);
  }

  async aggregate(jurisdictionTenant: string): Promise<CostBreakdown> {
    let totalComputeCents = 0;
    let totalHumanReviewMinutes = 0;
    for (const r of this.records.values()) {
      if (r.jurisdictionTenant !== jurisdictionTenant) continue;
      const s = summarizeCost(r);
      totalComputeCents += s.totalComputeCents;
      totalHumanReviewMinutes += s.totalHumanReviewMinutes;
    }
    return {
      totalComputeCents,
      totalHumanReviewMinutes,
      overTarget:
        totalComputeCents > TARGET_COMPUTE_DOLLARS * 100 ||
        totalHumanReviewMinutes > TARGET_HUMAN_REVIEW_MINUTES,
    };
  }

  async listAggregates(): Promise<
    ReadonlyArray<{ jurisdictionTenant: string; breakdown: CostBreakdown }>
  > {
    const byJurisdiction = new Map<string, CostBreakdown>();
    for (const r of this.records.values()) {
      const existing = byJurisdiction.get(r.jurisdictionTenant);
      const s = summarizeCost(r);
      if (!existing) {
        byJurisdiction.set(r.jurisdictionTenant, s);
      } else {
        byJurisdiction.set(r.jurisdictionTenant, {
          totalComputeCents: existing.totalComputeCents + s.totalComputeCents,
          totalHumanReviewMinutes:
            existing.totalHumanReviewMinutes + s.totalHumanReviewMinutes,
          overTarget:
            existing.totalComputeCents + s.totalComputeCents >
              TARGET_COMPUTE_DOLLARS * 100 ||
            existing.totalHumanReviewMinutes + s.totalHumanReviewMinutes >
              TARGET_HUMAN_REVIEW_MINUTES,
        });
      }
    }
    return Array.from(byJurisdiction.entries()).map(
      ([jurisdictionTenant, breakdown]) => ({ jurisdictionTenant, breakdown }),
    );
  }
}

export interface HardKillReport {
  triggered: boolean;
  countiesEvaluated: number;
  overTargetCount: number;
  message: string;
}

/**
 * Hard-kill checkpoint per commitment #3.
 *
 * If at least HARD_KILL_CHECKPOINT_COUNTIES jurisdictions have been
 * evaluated and the average compute exceeds the target, the
 * checkpoint trips. Batch ingest must halt and surface to Nick.
 *
 * The checkpoint deliberately fires when the AVERAGE exceeds target —
 * not when a single county exceeds. Per-county overruns flag for
 * engineering review (separate non-blocking signal); the hard-kill
 * triggers only when the trend says the structural commitment is not
 * achievable.
 */
export async function evaluateHardKill(port: CostPort): Promise<HardKillReport> {
  const aggregates = await port.listAggregates();
  if (aggregates.length < HARD_KILL_CHECKPOINT_COUNTIES) {
    return {
      triggered: false,
      countiesEvaluated: aggregates.length,
      overTargetCount: 0,
      message: `Hard-kill checkpoint requires ${HARD_KILL_CHECKPOINT_COUNTIES} counties; have ${aggregates.length}.`,
    };
  }
  const overTargetCount = aggregates.filter((a) => a.breakdown.overTarget).length;
  const averageCents =
    aggregates.reduce((sum, a) => sum + a.breakdown.totalComputeCents, 0) /
    aggregates.length;
  const averageMinutes =
    aggregates.reduce((sum, a) => sum + a.breakdown.totalHumanReviewMinutes, 0) /
    aggregates.length;
  const averageOverTarget =
    averageCents > TARGET_COMPUTE_DOLLARS * 100 ||
    averageMinutes > TARGET_HUMAN_REVIEW_MINUTES;

  return {
    triggered: averageOverTarget,
    countiesEvaluated: aggregates.length,
    overTargetCount,
    message: averageOverTarget
      ? `HARD-KILL: average cost per jurisdiction ($${(averageCents / 100).toFixed(2)} compute, ${averageMinutes.toFixed(0)} review-min) exceeds target ($${TARGET_COMPUTE_DOLLARS} + ${TARGET_HUMAN_REVIEW_MINUTES}min). Halt batch ingest and surface to Nick per CLAUDE.md commitment #3.`
      : `OK: average cost per jurisdiction ($${(averageCents / 100).toFixed(2)} compute, ${averageMinutes.toFixed(0)} review-min) within target.`,
  };
}
