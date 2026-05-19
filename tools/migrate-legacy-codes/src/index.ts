#!/usr/bin/env node
/**
 * tools/migrate-legacy-codes — one-shot migration CLI.
 *
 * Per the 2026-05-19 dispatch (Path B greenlit). Reads legacy
 * code_atoms rows, synthesizes Bump 1 atom instances, writes to a
 * StoragePort (in-memory for dry-run + eval; Postgres for production
 * write once that landing finishes).
 *
 * Subcommands:
 *   coverage-report          → answers dispatch Check 1
 *   probe-bastrop-udc        → focused presence check for UDC chapters
 *   dry-run [--jurisdiction] → transform + synthesize against in-memory storage
 *   write [--jurisdiction] [--target=in-memory|postgres] → writes atoms
 *   eval [--jurisdiction]    → migrate + run eval-harness seed queries
 *
 * Production-write target Postgres landing is a separate sprint; until
 * then `--target=postgres` errors politely.
 */

import { Command } from "commander";

import {
  evaluate,
  type CuratedQuery,
} from "@hauska-engine/corpus/eval";
import { InMemoryStorage, type StoragePort } from "@hauska-engine/storage";

import { LegacyClient } from "./legacy-client.js";
import { runMigration } from "./migrate.js";
import { curatedQueriesForJurisdiction, buildSeedCuratedQueries } from "./seed-curated-queries.js";

function resolveDatabaseUrl(explicit: string | undefined): string {
  const url = explicit || process.env.LEGACY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "ERROR: legacy DATABASE_URL not provided. Set LEGACY_DATABASE_URL or DATABASE_URL, or pass --database-url=<url>.",
    );
    process.exit(2);
  }
  return url;
}

const program = new Command();
program
  .name("migrate-legacy-codes")
  .description(
    "One-shot migration of legacy-design-tools code_atoms into Bump 1 atom instances",
  )
  .version("0.0.0")
  .option(
    "--database-url <url>",
    "Legacy Neon DATABASE_URL (falls back to env LEGACY_DATABASE_URL or DATABASE_URL)",
  );

program
  .command("coverage-report")
  .description(
    "Print per-(jurisdiction, codeBook) atom counts + sample section numbers. Answers dispatch Check 1.",
  )
  .action(async () => {
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const legacy = new LegacyClient({ databaseUrl: url });
    try {
      const coverage = await legacy.coverageReport();
      const out = {
        generatedAt: new Date().toISOString(),
        perBook: coverage.map((c) => ({
          jurisdictionKey: c.jurisdictionKey,
          codeBook: c.codeBook,
          edition: c.edition,
          sourceName: c.sourceName,
          atomCount: c.atomCount,
          withBody: c.withBody,
          withBodyHtml: c.withBodyHtml,
          withEmbedding: c.withEmbedding,
          earliestFetchedAt: c.earliestFetchedAt?.toISOString() ?? null,
          latestFetchedAt: c.latestFetchedAt?.toISOString() ?? null,
          sampleSectionNumbers: c.sampleSectionNumbers,
        })),
      };
      console.log(JSON.stringify(out, null, 2));
    } finally {
      await legacy.close();
    }
  });

program
  .command("probe-bastrop-udc")
  .description(
    "Probe legacy code_atoms for Bastrop UDC presence (Chapter 14 zoning indicators). Answers dispatch Check 1 with explicit UDC verdict.",
  )
  .action(async () => {
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const legacy = new LegacyClient({ databaseUrl: url });
    try {
      const probe = await legacy.probeBastropUdc();
      const verdict =
        probe.udcCandidateCount > 0
          ? "UDC_PRESENT"
          : "UDC_ABSENT";
      console.log(
        JSON.stringify(
          {
            verdict,
            totalBastropAtoms: probe.totalBastropAtoms,
            udcCandidateCount: probe.udcCandidateCount,
            candidateSections: probe.candidateSections,
            dispatchAnswer:
              verdict === "UDC_PRESENT"
                ? "UDC sections present in legacy code_atoms; Path B covers full Bastrop corpus."
                : "UDC sections absent; Path B migrates non-UDC sections, Path C re-ingest needed for UDC subset specifically — fold into the same migration tool with a re-ingest subcommand for that subset.",
          },
          null,
          2,
        ),
      );
    } finally {
      await legacy.close();
    }
  });

interface RunOptions {
  jurisdiction?: string;
  codeBook?: string;
}

async function runAgainstInMemory(
  url: string,
  opts: RunOptions,
): Promise<{ storage: StoragePort; result: Awaited<ReturnType<typeof runMigration>> }> {
  const legacy = new LegacyClient({ databaseUrl: url });
  const storage = new InMemoryStorage();
  try {
    const result = await runMigration({
      legacy,
      storage,
      filter: {
        ...(opts.jurisdiction ? { jurisdictionKey: opts.jurisdiction } : {}),
        ...(opts.codeBook ? { codeBook: opts.codeBook } : {}),
      },
    });
    return { storage, result };
  } finally {
    await legacy.close();
  }
}

program
  .command("dry-run")
  .description("Transform + synthesize + write into an in-memory StoragePort; print report only.")
  .option("--jurisdiction <key>", "Filter to one jurisdiction")
  .option("--code-book <book>", "Filter to one code book within the jurisdiction")
  .action(async (opts: RunOptions) => {
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const { result } = await runAgainstInMemory(url, opts);
    console.log(JSON.stringify({ dryRun: result.report }, null, 2));
  });

program
  .command("write")
  .description(
    "Run the migration end-to-end into the chosen target. --target=in-memory is allowed for verification; --target=postgres gates on the Postgres-backed StoragePort landing.",
  )
  .option("--jurisdiction <key>", "Filter to one jurisdiction")
  .option("--code-book <book>", "Filter to one code book within the jurisdiction")
  .option("--target <target>", "in-memory | postgres", "in-memory")
  .action(async (opts: RunOptions & { target: string }) => {
    if (opts.target === "postgres") {
      console.error(
        "ERROR: --target=postgres not yet wired. Postgres-backed StoragePort lands in a separate sprint; run with --target=in-memory for now.",
      );
      process.exit(3);
    }
    if (opts.target !== "in-memory") {
      console.error(`ERROR: unknown --target "${opts.target}". Use in-memory or postgres.`);
      process.exit(2);
    }
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const { result } = await runAgainstInMemory(url, opts);
    console.log(JSON.stringify({ write: result.report }, null, 2));
  });

program
  .command("eval")
  .description(
    "Migrate into an in-memory StoragePort and run the eval harness against the seed curated queries.",
  )
  .option("--jurisdiction <key>", "Filter to one jurisdiction (required for eval)")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
  )
  .action(async (opts: RunOptions & { queriesFile?: string }) => {
    if (!opts.jurisdiction) {
      console.error("ERROR: --jurisdiction is required for eval.");
      process.exit(2);
    }
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const { storage, result } = await runAgainstInMemory(url, opts);

    let queries: ReadonlyArray<CuratedQuery>;
    if (opts.queriesFile) {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(opts.queriesFile, "utf8");
      queries = JSON.parse(raw) as CuratedQuery[];
    } else {
      queries = curatedQueriesForJurisdiction(opts.jurisdiction);
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: opts.jurisdiction,
      queries,
    });

    console.log(
      JSON.stringify(
        {
          migration: result.report,
          eval: report,
          syncFourReady:
            report.passed &&
            (opts.jurisdiction === "bastrop_tx" ||
              opts.jurisdiction === "grand_county_ut"),
        },
        null,
        2,
      ),
    );
    if (!report.passed) {
      process.exitCode = 4;
    }
  });

program
  .command("export-seed-queries")
  .description(
    "Print the seed curated-query JSON to stdout. Useful for piping into the curated-queries port for human review.",
  )
  .action(() => {
    console.log(JSON.stringify(buildSeedCuratedQueries(), null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(
    "migrate-legacy-codes error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
