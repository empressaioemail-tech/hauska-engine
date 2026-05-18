#!/usr/bin/env node
/**
 * tools/ingest-cli — Stream 1D operator CLI.
 *
 * Surfaces operator actions against the ingest pipeline:
 *
 *   enqueue <adapter> <sourceId> <jurisdictionTenant> <editionLabel> <sourceUrl>
 *   list [--state=...] [--jurisdiction=...]
 *   view <jobId>
 *   run <jobId>
 *   eval <jurisdiction>
 *   review-start <jurisdiction>
 *   review-end <jurisdiction>
 *   cost-record <jurisdiction> --llm=<cents> --ocr=<cents> --embed=<cents> --infra=<cents>
 *   cost-report [--jurisdiction=...]
 *   evaluate-hard-kill
 *   discover [--region=TX] [--adapter=municode-html]
 *
 * State backing: the CLI currently uses in-memory ports per run; the
 * Postgres + IPFS production wiring lands in a follow-on (job table
 * migration sprint). The surface shape is the contract; the back-end
 * swap is non-breaking.
 */

import { randomUUID } from "node:crypto";

import { Command } from "commander";

import { MunicodeHtmlAdapter } from "@hauska-engine/corpus/adapters";
import { ECode360Adapter } from "@hauska-engine/corpus/adapters";
import { RawPdfAdapter } from "@hauska-engine/corpus/adapters";
import type { CodeSourceAdapter } from "@hauska-engine/corpus/adapters";
import {
  evaluateHardKill,
  InMemoryCostPort,
  TARGET_COMPUTE_DOLLARS,
  TARGET_HUMAN_REVIEW_MINUTES,
} from "@hauska-engine/corpus/cost-tracking";

interface RuntimeState {
  jurisdictionReviewStart: Map<string, number>;
  costPort: InMemoryCostPort;
  adapters: Map<string, CodeSourceAdapter>;
}

function buildRuntime(): RuntimeState {
  const adapters = new Map<string, CodeSourceAdapter>();
  const municode = new MunicodeHtmlAdapter();
  const ecode = new ECode360Adapter();
  const rawPdf = new RawPdfAdapter();
  adapters.set(municode.capabilities.name, municode);
  adapters.set(ecode.capabilities.name, ecode);
  adapters.set(rawPdf.capabilities.name, rawPdf);
  return {
    jurisdictionReviewStart: new Map(),
    costPort: new InMemoryCostPort(),
    adapters,
  };
}

const runtime = buildRuntime();

const program = new Command();
program
  .name("ingest-cli")
  .description("Hauska Engine ingest pipeline operator CLI")
  .version("0.0.0");

program
  .command("discover")
  .description("Discover available code editions from an adapter")
  .option("--region <region>", "Region filter (e.g. TX)", "TX")
  .option("--adapter <adapter>", "Adapter name", "municode-html")
  .action(async (opts: { region: string; adapter: string }) => {
    const adapter = runtime.adapters.get(opts.adapter);
    if (!adapter) {
      console.error(`Unknown adapter "${opts.adapter}"`);
      process.exitCode = 1;
      return;
    }
    const refs = await adapter.discover({ region: opts.region });
    console.log(JSON.stringify({ adapter: opts.adapter, references: refs }, null, 2));
  });

program
  .command("review-start <jurisdiction>")
  .description("Mark the start of a human-review session for a jurisdiction")
  .action((jurisdiction: string) => {
    runtime.jurisdictionReviewStart.set(jurisdiction, Date.now());
    console.log(
      JSON.stringify({ jurisdiction, reviewStartedAt: new Date().toISOString() }),
    );
  });

program
  .command("review-end <jurisdiction>")
  .description(
    "Mark the end of a human-review session; records minutes against cost target",
  )
  .action(async (jurisdiction: string) => {
    const startedAt = runtime.jurisdictionReviewStart.get(jurisdiction);
    if (!startedAt) {
      console.error(
        `No review-start recorded for ${jurisdiction}. Run \`ingest-cli review-start ${jurisdiction}\` first.`,
      );
      process.exitCode = 1;
      return;
    }
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    runtime.jurisdictionReviewStart.delete(jurisdiction);
    await runtime.costPort.upsert({
      recordId: randomUUID(),
      jurisdictionTenant: jurisdiction,
      runDate: new Date().toISOString().slice(0, 10),
      llmTokensCostCents: 0,
      ocrCostCents: 0,
      embeddingCostCents: 0,
      infrastructureCostCents: 0,
      humanReviewMinutes: minutes,
      notes: "review-end CLI",
      flaggedOverTarget: minutes > TARGET_HUMAN_REVIEW_MINUTES,
      createdAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({ jurisdiction, minutes, target: TARGET_HUMAN_REVIEW_MINUTES }),
    );
  });

program
  .command("cost-record <jurisdiction>")
  .description("Record per-jurisdiction compute cost (cents)")
  .option("--llm <cents>", "LLM token cost (cents)", "0")
  .option("--ocr <cents>", "OCR spend (cents)", "0")
  .option("--embed <cents>", "Embedding compute (cents)", "0")
  .option("--infra <cents>", "Infrastructure attributable (cents)", "0")
  .option("--notes <text>", "Free-form notes", "")
  .action(
    async (
      jurisdiction: string,
      opts: { llm: string; ocr: string; embed: string; infra: string; notes: string },
    ) => {
      const totalCents =
        Number(opts.llm) +
        Number(opts.ocr) +
        Number(opts.embed) +
        Number(opts.infra);
      await runtime.costPort.upsert({
        recordId: randomUUID(),
        jurisdictionTenant: jurisdiction,
        runDate: new Date().toISOString().slice(0, 10),
        llmTokensCostCents: Number(opts.llm),
        ocrCostCents: Number(opts.ocr),
        embeddingCostCents: Number(opts.embed),
        infrastructureCostCents: Number(opts.infra),
        humanReviewMinutes: 0,
        notes: opts.notes || null,
        flaggedOverTarget: totalCents > TARGET_COMPUTE_DOLLARS * 100,
        createdAt: new Date().toISOString(),
      });
      console.log(
        JSON.stringify({
          jurisdiction,
          totalCents,
          targetCents: TARGET_COMPUTE_DOLLARS * 100,
          flagged: totalCents > TARGET_COMPUTE_DOLLARS * 100,
        }),
      );
    },
  );

program
  .command("cost-report")
  .description("Report per-jurisdiction cost breakdown against the structural-commitment target")
  .option("--jurisdiction <jurisdiction>", "Filter to one jurisdiction")
  .action(async (opts: { jurisdiction?: string }) => {
    const aggregates = await runtime.costPort.listAggregates();
    const filtered = opts.jurisdiction
      ? aggregates.filter((a) => a.jurisdictionTenant === opts.jurisdiction)
      : aggregates;
    console.log(
      JSON.stringify(
        {
          targetComputeDollars: TARGET_COMPUTE_DOLLARS,
          targetHumanReviewMinutes: TARGET_HUMAN_REVIEW_MINUTES,
          aggregates: filtered.map((a) => ({
            jurisdictionTenant: a.jurisdictionTenant,
            totalComputeDollars: a.breakdown.totalComputeCents / 100,
            totalHumanReviewMinutes: a.breakdown.totalHumanReviewMinutes,
            overTarget: a.breakdown.overTarget,
          })),
        },
        null,
        2,
      ),
    );
  });

program
  .command("evaluate-hard-kill")
  .description("Run the 3-county hard-kill checkpoint per CLAUDE.md commitment #3")
  .action(async () => {
    const report = await evaluateHardKill(runtime.costPort);
    console.log(JSON.stringify(report, null, 2));
    if (report.triggered) {
      console.error("\nHARD-KILL CHECKPOINT TRIPPED. Halt batch ingest and surface to Nick.");
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("ingest-cli error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
