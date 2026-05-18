/**
 * Job queue port.
 *
 * Postgres `ingest_jobs` table is the production backing; the
 * in-memory implementation here covers tests and local dev.
 */

import type { JobState } from "./state-machine.js";

export interface JobTelemetry {
  blockCount?: number;
  sectionCount?: number;
  atomCount?: number;
  evalScores?: {
    top3Score: number;
    sectionNumScore: number;
    crossRefScore: number;
  };
  /** Per-stage cost capture (cents). Aggregated into cost_records on terminal. */
  llmTokensCostCents?: number;
  ocrCostCents?: number;
  embeddingCostCents?: number;
  infrastructureCostCents?: number;
}

export interface JobRecord {
  jobId: string;
  adapter: string;
  sourceId: string;
  jurisdictionTenant: string;
  editionLabel: string;
  sourceUrl: string;
  state: JobState;
  attemptCount: number;
  maxAttempts: number;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  telemetry: JobTelemetry;
}

export interface JobPort {
  enqueue(
    record: Omit<
      JobRecord,
      "state" | "attemptCount" | "queuedAt" | "startedAt" | "finishedAt" | "telemetry" | "error"
    >,
  ): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  list(filter?: { state?: JobState; jurisdictionTenant?: string }): Promise<ReadonlyArray<JobRecord>>;
  updateState(
    jobId: string,
    state: JobState,
    patch?: { error?: string | null; telemetry?: JobTelemetry },
  ): Promise<JobRecord>;
}

export class InMemoryJobPort implements JobPort {
  private readonly store = new Map<string, JobRecord>();

  async enqueue(
    record: Omit<
      JobRecord,
      "state" | "attemptCount" | "queuedAt" | "startedAt" | "finishedAt" | "telemetry" | "error"
    >,
  ): Promise<JobRecord> {
    const full: JobRecord = {
      ...record,
      state: "queued",
      attemptCount: 0,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      telemetry: {},
      error: null,
    };
    this.store.set(record.jobId, full);
    return full;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    return this.store.get(jobId) ?? null;
  }

  async list(filter?: {
    state?: JobState;
    jurisdictionTenant?: string;
  }): Promise<ReadonlyArray<JobRecord>> {
    return Array.from(this.store.values()).filter((r) => {
      if (filter?.state && r.state !== filter.state) return false;
      if (
        filter?.jurisdictionTenant &&
        r.jurisdictionTenant !== filter.jurisdictionTenant
      )
        return false;
      return true;
    });
  }

  async updateState(
    jobId: string,
    state: JobState,
    patch: { error?: string | null; telemetry?: JobTelemetry } = {},
  ): Promise<JobRecord> {
    const record = this.store.get(jobId);
    if (!record) throw new Error(`Job ${jobId} not found`);
    const nowIso = new Date().toISOString();
    const next: JobRecord = {
      ...record,
      state,
      error: patch.error !== undefined ? patch.error : record.error,
      telemetry: { ...record.telemetry, ...(patch.telemetry ?? {}) },
      startedAt: record.startedAt ?? (state !== "queued" ? nowIso : null),
      finishedAt: state === "loaded" || state === "failed" ? nowIso : record.finishedAt,
    };
    this.store.set(jobId, next);
    return next;
  }
}
