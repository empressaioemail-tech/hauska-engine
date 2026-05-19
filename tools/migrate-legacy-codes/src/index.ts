#!/usr/bin/env node
/**
 * tools/migrate-legacy-codes — one-shot migration CLI.
 *
 * Per the 2026-05-19 dispatches. Path B (Nick 2026-05-19): read legacy
 * code_atoms rows, synthesize Bump 1 atom instances, write to a
 * StoragePort. Path C (Nick 2026-05-19): live re-ingestion of Bastrop
 * UDC via Stream 1A MunicodeHtmlAdapter (JSON mode) into the same
 * StoragePort.
 *
 * Subcommands:
 *   coverage-report           → answers dispatch Check 1
 *   probe-bastrop-udc         → focused UDC presence check (tightened)
 *   dry-run [--jurisdiction]  → Path B transform + synthesize against in-memory storage
 *   write [--jurisdiction]    → Path B writes atoms (--target=in-memory only for now)
 *   eval [--jurisdiction]     → Path B migrate + run eval-harness seed queries
 *   path-c-ingest-bastrop-udc → Path C live Municode re-ingestion + atomization
 *   path-c-eval               → Path C + UDC curated-query eval (Sync 4 / B.6 fire path)
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
import { runPathCIngest } from "./path-c-ingest.js";
import { buildBastropUdcCuratedQueries } from "./udc-curated-queries.js";
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
  codeBooks?: string;
}

async function runAgainstInMemory(
  url: string,
  opts: RunOptions,
): Promise<{ storage: StoragePort; result: Awaited<ReturnType<typeof runMigration>> }> {
  const legacy = new LegacyClient({ databaseUrl: url });
  const storage = new InMemoryStorage();
  try {
    const codeBooksList = opts.codeBooks
      ? opts.codeBooks.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const result = await runMigration({
      legacy,
      storage,
      filter: {
        ...(opts.jurisdiction ? { jurisdictionKey: opts.jurisdiction } : {}),
        ...(opts.codeBook ? { codeBook: opts.codeBook } : {}),
        ...(codeBooksList ? { codeBooks: codeBooksList } : {}),
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
  .option("--code-books <books>", "Comma-separated allow-list of code books (e.g. IRC_R301_2_1,IWUIC)")
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
  .option("--code-books <books>", "Comma-separated allow-list of code books (e.g. IRC_R301_2_1,IWUIC)")
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
  .option("--code-book <book>", "Filter to one code book")
  .option("--code-books <books>", "Comma-separated allow-list of code books")
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

program
  .command("path-c-probe-section")
  .description("Diagnostic: dump body content of one Municode Doc for inspection.")
  .requiredOption("--node-id <id>", "Municode TOC node id")
  .action(async (opts: { nodeId: string }) => {
    const { MunicodeJsonClient } = await import("@hauska-engine/corpus/adapters");
    const client = new MunicodeJsonClient();
    const clientContent = await client.getClientContent(1169);
    const product = clientContent?.codes?.[0];
    if (!product) return console.log("{}");
    const job = await client.getLatestJob(product.productId);
    if (!job) return console.log("{}");
    const env = await client.getCodesContent(job.Id, job.ProductId, opts.nodeId);
    console.log(
      JSON.stringify(
        {
          docs: env?.Docs.map((d) => ({
            Id: d.Id,
            Title: d.Title,
            NodeDepth: d.NodeDepth,
            ContentChars: d.Content?.length ?? 0,
            ContentPreview: d.Content?.slice(0, 800) ?? null,
          })),
        },
        null,
        2,
      ),
    );
  });

program
  .command("path-c-probe-toc")
  .description(
    "Diagnostic: hit Municode JSON API and print top-level TOC headings for Bastrop. Used to dial in the chapter-filter regex.",
  )
  .action(async () => {
    const { MunicodeJsonClient } = await import("@hauska-engine/corpus/adapters");
    const client = new MunicodeJsonClient();
    const clientContent = await client.getClientContent(1169);
    const product = clientContent?.codes?.[0];
    if (!product) {
      console.log(JSON.stringify({ error: "No product found for clientId=1169" }));
      return;
    }
    const job = await client.getLatestJob(product.productId);
    if (!job) {
      console.log(JSON.stringify({ error: "No latest job for product" }));
      return;
    }
    const top = await client.getTocChildren(job.Id, job.ProductId);
    console.log(
      JSON.stringify(
        {
          product: { productName: product.productName, productId: product.productId },
          job: { Id: job.Id, Name: job.Name, ProductId: job.ProductId },
          topLevel: top.map((n) => ({
            Id: n.Id,
            Heading: n.Heading,
            HasChildren: n.HasChildren,
            NodeDepth: n.NodeDepth,
          })),
        },
        null,
        2,
      ),
    );
  });

program
  .command("path-c-ingest-bastrop-udc")
  .description(
    "Path C: live re-ingest Bastrop UDC chapters from Municode JSON API. Writes to in-memory storage; no Neon dependency.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive). Defaults to 'unified.*development|development code|zoning'.",
    "unified.*development|development code|zoning",
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "30")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      editionLabel: "Bastrop UDC (current supplement)",
      clientId: 1169,
      librarySlug: "bastrop",
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
    });
    console.log(JSON.stringify({ pathCIngest: result.report }, null, 2));
  });

program
  .command("path-c-eval")
  .description(
    "Path C end-to-end: live Bastrop UDC re-ingest + UDC curated-query eval. Sync 4 / B.6 fire path.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex",
    "unified.*development|development code|zoning",
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "30")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the UDC seed set",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      queriesFile?: string;
    }) => {
      const storage = new InMemoryStorage();
      const ingest = await runPathCIngest({
        storage,
        jurisdictionTenant: "bastrop_tx",
        jurisdictionName: "Bastrop, TX",
        editionLabel: "Bastrop UDC (current supplement)",
        clientId: 1169,
        librarySlug: "bastrop",
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        const raw = await fs.readFile(opts.queriesFile, "utf8");
        queries = JSON.parse(raw) as CuratedQuery[];
      } else {
        queries = buildBastropUdcCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: "bastrop_tx",
        queries,
      });

      console.log(
        JSON.stringify(
          {
            pathCIngest: ingest.report,
            eval: report,
            syncFourReady: report.passed,
          },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-udc-queries")
  .description("Print the Bastrop UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildBastropUdcCuratedQueries(), null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(
    "migrate-legacy-codes error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
