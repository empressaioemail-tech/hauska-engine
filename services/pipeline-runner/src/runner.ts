/**
 * Pipeline-runner core. Walks one job through the state machine.
 *
 * One Cloud Run jobs invocation = one `runJob(jobId)` call. The
 * runner pulls the job, executes each stage, updates state +
 * telemetry, and persists. Retries are governed by `maxAttempts` on
 * the job record; exhausted retries terminal `failed`.
 */

import type {
  CodeReference,
  CodeSourceAdapter,
} from "@hauska-engine/corpus/adapters";
import { atomize } from "@hauska-engine/corpus/atomization";
import {
  buildCodeTree,
  reportExtractionQuality,
} from "@hauska-engine/corpus/extraction";
import { evaluate, type CuratedQuery, type EvalReport } from "@hauska-engine/corpus/eval";
import type { StoragePort } from "@hauska-engine/storage";

import type { JobPort, JobRecord } from "./job-port.js";
import { assertTransition } from "./state-machine.js";

export interface RunnerOptions {
  jobPort: JobPort;
  storage: StoragePort;
  /** Lookup adapter by name (matches adapter.capabilities.name). */
  adapterRegistry: Map<string, CodeSourceAdapter>;
  /** Optional eval queries loader. Returns the query set for a jurisdiction. */
  loadEvalQueries?: (
    jurisdictionTenant: string,
  ) => Promise<ReadonlyArray<CuratedQuery>>;
}

export interface RunJobOutcome {
  jobId: string;
  state: JobRecord["state"];
  attemptCount: number;
  durationMs: number;
  evalReport?: EvalReport;
}

export class PipelineRunner {
  constructor(private readonly opts: RunnerOptions) {}

  async runJob(jobId: string): Promise<RunJobOutcome> {
    const start = Date.now();
    const job = await this.opts.jobPort.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.state !== "queued" && job.state !== "failed") {
      throw new Error(
        `Job ${jobId} is not retriable (state=${job.state}); only queued or failed (re-enqueued) jobs run`,
      );
    }
    if (job.attemptCount >= job.maxAttempts) {
      return {
        jobId,
        state: "failed",
        attemptCount: job.attemptCount,
        durationMs: Date.now() - start,
      };
    }

    const adapter = this.opts.adapterRegistry.get(job.adapter);
    if (!adapter) {
      await this.fail(job, `unknown adapter "${job.adapter}"`);
      return {
        jobId,
        state: "failed",
        attemptCount: job.attemptCount + 1,
        durationMs: Date.now() - start,
      };
    }

    let evalReport: EvalReport | undefined;
    try {
      const reference: CodeReference = {
        sourceId: job.sourceId,
        jurisdictionTenant: job.jurisdictionTenant,
        editionLabel: job.editionLabel,
        sourceUrl: job.sourceUrl,
      };

      // fetching
      await this.transition(job, "queued", "fetching");
      const raw = await adapter.fetch(reference);

      // extracted
      await this.transition(job, "fetching", "extracted");
      const normalized = await adapter.normalize(raw);
      const tree = buildCodeTree(normalized);
      const quality = reportExtractionQuality(tree);
      if (!quality.hasMinimumViableStructure) {
        throw new Error(
          `extraction did not yield minimum-viable structure (sections=${quality.totalSections}, cross-refs=${quality.totalCrossReferences})`,
        );
      }

      // atomized
      await this.transition(job, "extracted", "atomized", {
        telemetry: { blockCount: normalized.blocks.length, sectionCount: quality.totalSections },
      });
      const atomized = atomize(tree);

      // indexed
      await this.transition(job, "atomized", "indexed");
      await this.opts.storage.writeAtoms([
        atomized.jurisdictionCorpus,
        atomized.edition,
        ...atomized.sections,
        ...atomized.definitions,
        ...atomized.crossReferences,
        ...atomized.amendments,
      ]);
      await this.opts.storage.writeAtomLinks(atomized.links);
      await this.opts.storage.upsertJurisdictionStatus({
        jurisdictionTenant: atomized.jurisdictionCorpus.jurisdictionTenant,
        jurisdictionName: atomized.jurisdictionCorpus.jurisdictionName,
        currentEditionDid: `did:hauska:code-edition:${atomized.edition.entityId}`,
        qualityBar: "not-evaluated",
        top3Score: null,
        sectionNumScore: null,
        crossRefScore: null,
        atomCount: atomized.sections.length,
        lastRefreshedAt: atomized.edition.fetchedAt,
        driftStatus: "clean",
      });

      // eval-running
      await this.transition(job, "indexed", "eval-running", {
        telemetry: { atomCount: atomized.sections.length },
      });
      const queries = this.opts.loadEvalQueries
        ? await this.opts.loadEvalQueries(job.jurisdictionTenant)
        : [];
      evalReport = await evaluate({
        storage: this.opts.storage,
        jurisdictionTenant: job.jurisdictionTenant,
        queries,
      });

      await this.opts.storage.upsertJurisdictionStatus({
        jurisdictionTenant: atomized.jurisdictionCorpus.jurisdictionTenant,
        jurisdictionName: atomized.jurisdictionCorpus.jurisdictionName,
        currentEditionDid: `did:hauska:code-edition:${atomized.edition.entityId}`,
        qualityBar: evalReport.passed ? "passing" : "failing",
        top3Score: evalReport.scores.top3Score,
        sectionNumScore: evalReport.scores.sectionNumScore,
        crossRefScore: evalReport.scores.crossRefScore,
        atomCount: atomized.sections.length,
        lastRefreshedAt: atomized.edition.fetchedAt,
        driftStatus: "clean",
      });

      const terminal = evalReport.passed ? "loaded" : "failed";
      await this.transition(job, "eval-running", terminal, {
        telemetry: { evalScores: evalReport.scores },
        ...(terminal === "failed"
          ? { error: "eval quality bar not met" }
          : {}),
      });

      return {
        jobId,
        state: terminal,
        attemptCount: job.attemptCount + 1,
        durationMs: Date.now() - start,
        evalReport,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(job, message);
      return {
        jobId,
        state: "failed",
        attemptCount: job.attemptCount + 1,
        durationMs: Date.now() - start,
        ...(evalReport ? { evalReport } : {}),
      };
    }
  }

  private async transition(
    job: JobRecord,
    from: JobRecord["state"],
    to: JobRecord["state"],
    patch: { telemetry?: JobRecord["telemetry"]; error?: string | null } = {},
  ): Promise<void> {
    assertTransition(from, to);
    await this.opts.jobPort.updateState(job.jobId, to, patch);
  }

  private async fail(job: JobRecord, message: string): Promise<void> {
    await this.opts.jobPort.updateState(job.jobId, "failed", {
      error: message,
    });
  }
}
