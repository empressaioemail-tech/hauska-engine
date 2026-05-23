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
import { runPathPdfIngest } from "./path-pdf-ingest.js";
import { buildBastropUdcCuratedQueries } from "./udc-curated-queries.js";
import {
  buildBastropB3CuratedQueries,
  B3_EDITION_LABEL,
} from "./b3-curated-queries.js";
import {
  buildHuttoUdcCuratedQueries,
  HUTTO_UDC_EDITION_LABEL,
  HUTTO_UDC_JURISDICTION,
  HUTTO_UDC_JURISDICTION_NAME,
  HUTTO_UDC_PDF_URL,
} from "./hutto-udc-curated-queries.js";
import {
  buildBastropCountyCuratedQueries,
  BASTROP_COUNTY_SUBDIVISION_REGS_URL,
  BC_EDITION_LABEL,
  BC_JURISDICTION,
} from "./bastrop-county-curated-queries.js";
import {
  buildElginCuratedQueries,
  ELGIN_EDITION_LABEL,
  ELGIN_JURISDICTION,
} from "./elgin-curated-queries.js";
import {
  buildRoundRockCuratedQueries,
  ROUND_ROCK_CHAPTER_FILTER,
  ROUND_ROCK_CLIENT_ID,
  ROUND_ROCK_EDITION_LABEL,
  ROUND_ROCK_JURISDICTION,
  ROUND_ROCK_JURISDICTION_NAME,
  ROUND_ROCK_LIBRARY_SLUG,
} from "./round-rock-curated-queries.js";
import {
  buildTaylorLdcCuratedQueries,
  TAYLOR_LDC_EDITION_LABEL,
  TAYLOR_LDC_JURISDICTION,
  TAYLOR_LDC_JURISDICTION_NAME,
  TAYLOR_LDC_NORMALIZE_OPTIONS,
  TAYLOR_LDC_PDF_URL,
} from "./taylor-ldc-curated-queries.js";
import {
  buildLeanderCuratedQueries,
  LEANDER_CHAPTER_FILTER,
  LEANDER_CLIENT_ID,
  LEANDER_EDITION_LABEL,
  LEANDER_JURISDICTION,
  LEANDER_JURISDICTION_NAME,
  LEANDER_LIBRARY_SLUG,
} from "./leander-curated-queries.js";
import {
  buildGeorgetownUdcCuratedQueries,
  GEORGETOWN_UDC_CHAPTER_FILTER,
  GEORGETOWN_UDC_CLIENT_ID,
  GEORGETOWN_UDC_EDITION_LABEL,
  GEORGETOWN_UDC_JURISDICTION,
  GEORGETOWN_UDC_JURISDICTION_NAME,
  GEORGETOWN_UDC_LIBRARY_CODE_PATH,
  GEORGETOWN_UDC_LIBRARY_SLUG,
  GEORGETOWN_UDC_PRODUCT_FILTER,
} from "./georgetown-udc-curated-queries.js";
import {
  buildNewBraunfelsCuratedQueries,
  NEW_BRAUNFELS_CHAPTER_FILTER,
  NEW_BRAUNFELS_CLIENT_ID,
  NEW_BRAUNFELS_EDITION_LABEL,
  NEW_BRAUNFELS_JURISDICTION,
  NEW_BRAUNFELS_JURISDICTION_NAME,
  NEW_BRAUNFELS_LIBRARY_SLUG,
} from "./new-braunfels-curated-queries.js";
import {
  buildKilleenCuratedQueries,
  KILLEEN_CHAPTER_FILTER,
  KILLEEN_CLIENT_ID,
  KILLEEN_EDITION_LABEL,
  KILLEEN_JURISDICTION,
  KILLEEN_JURISDICTION_NAME,
  KILLEEN_LIBRARY_SLUG,
} from "./killeen-curated-queries.js";
import {
  buildSanAntonioUdcCuratedQueries,
  SAN_ANTONIO_UDC_CHAPTER_FILTER,
  SAN_ANTONIO_UDC_CLIENT_ID,
  SAN_ANTONIO_UDC_EDITION_LABEL,
  SAN_ANTONIO_UDC_JURISDICTION,
  SAN_ANTONIO_UDC_JURISDICTION_NAME,
  SAN_ANTONIO_UDC_LIBRARY_CODE_PATH,
  SAN_ANTONIO_UDC_LIBRARY_SLUG,
  SAN_ANTONIO_UDC_PRODUCT_FILTER,
} from "./san-antonio-udc-curated-queries.js";
import {
  buildSeedCuratedQueries,
  curatedQueriesForJurisdiction,
  curatedQueriesForJurisdictionAndBooks,
} from "./seed-curated-queries.js";
import { buildCorpusSnapshot } from "./build-corpus-snapshot.js";

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
  .option(
    "--show-sections",
    "Also print all section entityIds + sectionNumbers + titles (helpful for curated-query authoring)",
  )
  .action(async (opts: RunOptions & { showSections?: boolean }) => {
    const url = resolveDatabaseUrl(program.opts().databaseUrl);
    const { result } = await runAgainstInMemory(url, opts);
    const output: Record<string, unknown> = { dryRun: result.report };
    if (opts.showSections) {
      output.sections = result.sections.map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
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
    } else if (opts.codeBooks) {
      const books = opts.codeBooks
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      queries = curatedQueriesForJurisdictionAndBooks(opts.jurisdiction, books);
    } else if (opts.codeBook) {
      queries = curatedQueriesForJurisdictionAndBooks(opts.jurisdiction, [
        opts.codeBook,
      ]);
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

const BASTROP_B3_PDF_URL =
  "https://www.cityofbastrop.org/upload/page/0107/docs/B3/B3%20Code%20-%20April%202025.pdf";

program
  .command("path-pdf-probe-extract")
  .description(
    "Diagnostic: fetch a publisher-hosted PDF, run the born-digital extractor, and dump per-page text (or a slice).",
  )
  .option(
    "--pdf-url <url>",
    "PDF URL. Defaults to the Bastrop B3 Code (April 2025) URL.",
    BASTROP_B3_PDF_URL,
  )
  .option(
    "--pages <range>",
    "Page range to print (e.g. '1-5'). Defaults to first 3 pages.",
    "1-3",
  )
  .option(
    "--chars-per-page <n>",
    "Cap printed chars per page (avoids massive stdout). 0 = unlimited.",
    "1200",
  )
  .action(
    async (opts: {
      pdfUrl: string;
      pages: string;
      charsPerPage: string;
    }) => {
      const { RawPdfAdapter, pdfjsTextExtractor } = await import(
        "@hauska-engine/corpus/adapters"
      );
      const adapter = new RawPdfAdapter({
        textExtractor: pdfjsTextExtractor,
        capabilitiesNameOverride: "raw-pdf-probe",
      });
      const reference = {
        sourceId: "probe",
        jurisdictionTenant: "probe",
        editionLabel: "probe",
        sourceUrl: opts.pdfUrl,
      };
      const raw = await adapter.fetch(reference);
      if (!raw.body) {
        console.log(
          JSON.stringify(
            { error: "fetch returned empty body", metadata: raw.metadata },
            null,
            2,
          ),
        );
        return;
      }
      // Re-extract directly so we can slice by page without running
      // the full normalize() walker. The adapter's textExtractor is
      // the source of truth.
      const pages = await pdfjsTextExtractor(raw.body);
      const range = parsePageRange(opts.pages, pages.length);
      const cap = Math.max(0, Number(opts.charsPerPage));
      const slice = pages
        .filter((p) => p.pageNumber >= range.from && p.pageNumber <= range.to)
        .map((p) => ({
          pageNumber: p.pageNumber,
          totalChars: p.text.length,
          text: cap === 0 ? p.text : p.text.slice(0, cap),
        }));
      console.log(
        JSON.stringify(
          {
            url: opts.pdfUrl,
            totalPages: pages.length,
            range,
            pages: slice,
          },
          null,
          2,
        ),
      );
    },
  );

program
  .command("path-pdf-ingest-bastrop-b3")
  .description(
    "Path PDF: ingest the Bastrop Building Block (B3) Code (April 2025) born-digital PDF. Writes to in-memory storage; no Neon dependency.",
  )
  .option("--pdf-url <url>", "Override the B3 PDF URL", BASTROP_B3_PDF_URL)
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles (helpful for curated-query authoring).",
  )
  .action(async (opts: { pdfUrl: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathPdfIngest({
      storage,
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      editionLabel: B3_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
    });
    const output: Record<string, unknown> = { pathPdfIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-pdf-eval")
  .description(
    "Path PDF end-to-end: ingest the Bastrop B3 Code + run the B3 curated-query eval. Sync 4.5 Bastrop UDC fire path.",
  )
  .option("--pdf-url <url>", "Override the B3 PDF URL", BASTROP_B3_PDF_URL)
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the B3 seed set",
  )
  .action(async (opts: { pdfUrl: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      editionLabel: B3_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
    });

    let queries: ReadonlyArray<CuratedQuery>;
    if (opts.queriesFile) {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(opts.queriesFile, "utf8");
      queries = JSON.parse(raw) as CuratedQuery[];
    } else {
      queries = buildBastropB3CuratedQueries();
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: "bastrop_tx",
      queries,
    });

    console.log(
      JSON.stringify(
        {
          pathPdfIngest: ingest.report,
          eval: report,
          syncFourFiveReady: report.passed,
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-b3-queries")
  .description("Print the Bastrop B3 Code curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildBastropB3CuratedQueries(), null, 2));
  });

program
  .command("path-pdf-ingest-bastrop-county")
  .description(
    "Path PDF: ingest the Bastrop County Subdivision Regulations (Revised April 24, 2017) born-digital PDF. Tagged internal-tier per the 2026-05-19 Sync 4.5 dispatch (partnership-pending Sylvia outreach).",
  )
  .option("--pdf-url <url>", "Override the PDF URL", BASTROP_COUNTY_SUBDIVISION_REGS_URL)
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(async (opts: { pdfUrl: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathPdfIngest({
      storage,
      jurisdictionTenant: BC_JURISDICTION,
      jurisdictionName: "Bastrop County, TX",
      editionLabel: BC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathPdfIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-pdf-eval-bastrop-county")
  .description(
    "Path PDF: ingest Bastrop County Subdivision Regulations + run the curated-query eval. Phase C of the 2026-05-19 Sync 4.5 dispatch.",
  )
  .option("--pdf-url <url>", "Override the PDF URL", BASTROP_COUNTY_SUBDIVISION_REGS_URL)
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the BC seed set",
  )
  .action(async (opts: { pdfUrl: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: BC_JURISDICTION,
      jurisdictionName: "Bastrop County, TX",
      editionLabel: BC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
    });

    let queries: ReadonlyArray<CuratedQuery>;
    if (opts.queriesFile) {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(opts.queriesFile, "utf8");
      queries = JSON.parse(raw) as CuratedQuery[];
    } else {
      queries = buildBastropCountyCuratedQueries();
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: BC_JURISDICTION,
      queries,
    });

    console.log(
      JSON.stringify(
        {
          pathPdfIngest: ingest.report,
          eval: report,
          syncFourFiveReady: report.passed,
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-bastrop-county-queries")
  .description("Print the Bastrop County curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildBastropCountyCuratedQueries(), null, 2));
  });

program
  .command("path-pdf-ingest-hutto-udc")
  .description(
    "Path PDF: ingest the City of Hutto Unified Development Code (Chapter 16, Revised March 2024) born-digital PDF via the decimal-numbered B.2 heading convention. Tagged platform-internal per Path A (Hutto partnership-pending per the 2026-05-20 prioritized-ingest decision). Writes to in-memory storage; no Neon dependency.",
  )
  .option("--pdf-url <url>", "Override the Hutto UDC PDF URL", HUTTO_UDC_PDF_URL)
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(async (opts: { pdfUrl: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathPdfIngest({
      storage,
      jurisdictionTenant: HUTTO_UDC_JURISDICTION,
      jurisdictionName: HUTTO_UDC_JURISDICTION_NAME,
      editionLabel: HUTTO_UDC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
      capabilitiesName: "hutto-udc-pdf",
      capabilitiesDisplayName: "Hutto UDC (PDF)",
      normalizeOptions: { headingConvention: "decimal-numbered" },
    });
    const output: Record<string, unknown> = { pathPdfIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-pdf-eval-hutto-udc")
  .description(
    "Path PDF end-to-end: ingest the Hutto UDC + run the curated-query eval. HUTTO.4 fire path against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option("--pdf-url <url>", "Override the Hutto UDC PDF URL", HUTTO_UDC_PDF_URL)
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the Hutto UDC seed set",
  )
  .action(async (opts: { pdfUrl: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: HUTTO_UDC_JURISDICTION,
      jurisdictionName: HUTTO_UDC_JURISDICTION_NAME,
      editionLabel: HUTTO_UDC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
      capabilitiesName: "hutto-udc-pdf",
      capabilitiesDisplayName: "Hutto UDC (PDF)",
      normalizeOptions: { headingConvention: "decimal-numbered" },
    });

    let queries: ReadonlyArray<CuratedQuery>;
    if (opts.queriesFile) {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(opts.queriesFile, "utf8");
      queries = JSON.parse(raw) as CuratedQuery[];
    } else {
      queries = buildHuttoUdcCuratedQueries();
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: HUTTO_UDC_JURISDICTION,
      queries,
    });

    console.log(
      JSON.stringify(
        {
          pathPdfIngest: ingest.report,
          eval: report,
          huttoUdcLoaded: report.passed,
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-hutto-udc-queries")
  .description("Print the Hutto UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildHuttoUdcCuratedQueries(), null, 2));
  });

const ELGIN_DEFAULT_CHAPTER_FILTER = "subdivisions|zoning|site developments";

program
  .command("path-c-eval-elgin")
  .description(
    "Path C end-to-end: live Elgin re-ingest + curated-query eval. Phase E of the 2026-05-19 Sync 4.5 dispatch.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    ELGIN_DEFAULT_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "200")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the Elgin seed set",
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
        jurisdictionTenant: ELGIN_JURISDICTION,
        jurisdictionName: "Elgin, TX",
        editionLabel: ELGIN_EDITION_LABEL,
        clientId: 2076,
        librarySlug: "elgin",
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        const raw = await fs.readFile(opts.queriesFile, "utf8");
        queries = JSON.parse(raw) as CuratedQuery[];
      } else {
        queries = buildElginCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: ELGIN_JURISDICTION,
        queries,
      });

      console.log(
        JSON.stringify(
          {
            pathCIngest: ingest.report,
            eval: report,
            syncFourFiveReady: report.passed,
          },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-elgin-queries")
  .description("Print the Elgin curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildElginCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-elgin")
  .description(
    "Path C: live re-ingest Elgin development chapters (Subdivisions, Zoning, Site Developments) from Municode JSON API. Internal-tier per the 2026-05-19 Sync 4.5 dispatch.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    ELGIN_DEFAULT_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "60")
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: "elgin_tx",
        jurisdictionName: "Elgin, TX",
        editionLabel: "Elgin Code of Ordinances (current supplement)",
        clientId: 2076,
        librarySlug: "elgin",
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

function parsePageRange(
  range: string,
  totalPages: number,
): { from: number; to: number } {
  const m = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return { from: 1, to: Math.min(3, totalPages) };
  const from = Math.max(1, parseInt(m[1] ?? "1", 10));
  const to = m[2]
    ? Math.min(totalPages, parseInt(m[2], 10))
    : Math.min(totalPages, from);
  return { from, to };
}

program
  .command("path-c-ingest-round-rock")
  .description(
    "Sync 5 Tier 1: Path C live re-ingest of Round Rock Part III Zoning and Development Code from the Municode JSON API (clientId 4150). Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    ROUND_ROCK_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "250")
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: ROUND_ROCK_JURISDICTION,
        jurisdictionName: ROUND_ROCK_JURISDICTION_NAME,
        editionLabel: ROUND_ROCK_EDITION_LABEL,
        clientId: ROUND_ROCK_CLIENT_ID,
        librarySlug: ROUND_ROCK_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-round-rock")
  .description(
    "Sync 5 Tier 1: Path C end-to-end — live Round Rock re-ingest + curated-query eval against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    ROUND_ROCK_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "250")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
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
        jurisdictionTenant: ROUND_ROCK_JURISDICTION,
        jurisdictionName: ROUND_ROCK_JURISDICTION_NAME,
        editionLabel: ROUND_ROCK_EDITION_LABEL,
        clientId: ROUND_ROCK_CLIENT_ID,
        librarySlug: ROUND_ROCK_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildRoundRockCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: ROUND_ROCK_JURISDICTION,
        queries,
      });

      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-round-rock-queries")
  .description("Print the Round Rock curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildRoundRockCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-leander")
  .description(
    "Sync 5 Tier 1: Path C live re-ingest of Leander's Subdivision (Chapter 10) and Zoning (Chapter 14) regulations from the Municode JSON API (clientId 2988). Leander embeds both as Exhibit A ordinances with bare-numbered sections; the PR #22 disambiguation re-keys the colliding ones. Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    LEANDER_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: LEANDER_JURISDICTION,
        jurisdictionName: LEANDER_JURISDICTION_NAME,
        editionLabel: LEANDER_EDITION_LABEL,
        clientId: LEANDER_CLIENT_ID,
        librarySlug: LEANDER_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-leander")
  .description(
    "Sync 5 Tier 1: Path C end-to-end — live Leander re-ingest + curated-query eval against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    LEANDER_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
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
        jurisdictionTenant: LEANDER_JURISDICTION,
        jurisdictionName: LEANDER_JURISDICTION_NAME,
        editionLabel: LEANDER_EDITION_LABEL,
        clientId: LEANDER_CLIENT_ID,
        librarySlug: LEANDER_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildLeanderCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: LEANDER_JURISDICTION,
        queries,
      });

      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-leander-queries")
  .description("Print the Leander curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildLeanderCuratedQueries(), null, 2));
  });

program
  .command("path-pdf-ingest-taylor")
  .description(
    "Sync 5 Tier 1: Path PDF ingest of the City of Taylor 'Taylor Made' Land Development Code (Revised September 2024) from the city-hosted born-digital PDF via the chapter-decimal heading convention. Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered). Taylor's Municode Chapter 21 only adopts this LDC by reference, so the substantive code is the external PDF — not a Path C source.",
  )
  .option("--pdf-url <url>", "Override the Taylor LDC PDF URL", TAYLOR_LDC_PDF_URL)
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(async (opts: { pdfUrl: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathPdfIngest({
      storage,
      jurisdictionTenant: TAYLOR_LDC_JURISDICTION,
      jurisdictionName: TAYLOR_LDC_JURISDICTION_NAME,
      editionLabel: TAYLOR_LDC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
      capabilitiesName: "taylor-ldc-pdf",
      capabilitiesDisplayName: "Taylor LDC (PDF)",
      normalizeOptions: TAYLOR_LDC_NORMALIZE_OPTIONS,
    });
    const output: Record<string, unknown> = { pathPdfIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-pdf-eval-taylor")
  .description(
    "Sync 5 Tier 1: Path PDF end-to-end — ingest the Taylor LDC + run the curated-query eval against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option("--pdf-url <url>", "Override the Taylor LDC PDF URL", TAYLOR_LDC_PDF_URL)
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
  )
  .action(async (opts: { pdfUrl: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: TAYLOR_LDC_JURISDICTION,
      jurisdictionName: TAYLOR_LDC_JURISDICTION_NAME,
      editionLabel: TAYLOR_LDC_EDITION_LABEL,
      pdfUrl: opts.pdfUrl,
      accessPolicy: "platform-internal",
      capabilitiesName: "taylor-ldc-pdf",
      capabilitiesDisplayName: "Taylor LDC (PDF)",
      normalizeOptions: TAYLOR_LDC_NORMALIZE_OPTIONS,
    });

    let queries: ReadonlyArray<CuratedQuery>;
    if (opts.queriesFile) {
      const fs = await import("node:fs/promises");
      queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
    } else {
      queries = buildTaylorLdcCuratedQueries();
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: TAYLOR_LDC_JURISDICTION,
      queries,
    });

    console.log(
      JSON.stringify(
        { pathPdfIngest: ingest.report, eval: report, syncFiveReady: report.passed },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-taylor-ldc-queries")
  .description("Print the Taylor LDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildTaylorLdcCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-georgetown")
  .description(
    "Sync 5 Tier 1: Path C live re-ingest of the City of Georgetown Unified Development Code from the Municode JSON API (clientId 12078, product 'Unified Development Code'). Georgetown publishes the UDC as a separate Municode product from its Code of Ordinances, so the ingest selects it via productNameFilter. Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    GEORGETOWN_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: GEORGETOWN_UDC_JURISDICTION,
        jurisdictionName: GEORGETOWN_UDC_JURISDICTION_NAME,
        editionLabel: GEORGETOWN_UDC_EDITION_LABEL,
        clientId: GEORGETOWN_UDC_CLIENT_ID,
        librarySlug: GEORGETOWN_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(GEORGETOWN_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: GEORGETOWN_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-georgetown")
  .description(
    "Sync 5 Tier 1: Path C end-to-end — live Georgetown UDC re-ingest + curated-query eval against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    GEORGETOWN_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
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
        jurisdictionTenant: GEORGETOWN_UDC_JURISDICTION,
        jurisdictionName: GEORGETOWN_UDC_JURISDICTION_NAME,
        editionLabel: GEORGETOWN_UDC_EDITION_LABEL,
        clientId: GEORGETOWN_UDC_CLIENT_ID,
        librarySlug: GEORGETOWN_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(GEORGETOWN_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: GEORGETOWN_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildGeorgetownUdcCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: GEORGETOWN_UDC_JURISDICTION,
        queries,
      });

      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-georgetown-udc-queries")
  .description("Print the Georgetown UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildGeorgetownUdcCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-new-braunfels")
  .description(
    "Sync 5 Tier 2: Path C live re-ingest of the City of New Braunfels land-development chapters (Community Development, Planning, Signs, Subdivision Platting, Zoning) from the Municode JSON API (clientId 3504). Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    NEW_BRAUNFELS_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--show-sections",
    "Also print all ingested section entityIds + section numbers + titles.",
  )
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
        jurisdictionName: NEW_BRAUNFELS_JURISDICTION_NAME,
        editionLabel: NEW_BRAUNFELS_EDITION_LABEL,
        clientId: NEW_BRAUNFELS_CLIENT_ID,
        librarySlug: NEW_BRAUNFELS_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-new-braunfels")
  .description(
    "Sync 5 Tier 2: Path C end-to-end — live New Braunfels re-ingest + curated-query eval against the B.4 quality bar (90% top-3 / 100% section-number / 95% cross-reference).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    NEW_BRAUNFELS_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option(
    "--queries-file <path>",
    "Optional JSON file of curated queries to use instead of the seed set",
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
        jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
        jurisdictionName: NEW_BRAUNFELS_JURISDICTION_NAME,
        editionLabel: NEW_BRAUNFELS_EDITION_LABEL,
        clientId: NEW_BRAUNFELS_CLIENT_ID,
        librarySlug: NEW_BRAUNFELS_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });

      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildNewBraunfelsCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
        queries,
      });

      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-new-braunfels-queries")
  .description("Print the New Braunfels curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildNewBraunfelsCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-killeen")
  .description(
    "Sync 5 Tier 2: Path C live re-ingest of the City of Killeen land-development chapters (Planning and Development, Subdivisions, Zoning, Impact Fees) from the Municode JSON API (clientId 2843). Layer 3 bespoke local code; tagged platform-internal per Path A (non-partnered).",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    KILLEEN_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: KILLEEN_JURISDICTION,
        jurisdictionName: KILLEEN_JURISDICTION_NAME,
        editionLabel: KILLEEN_EDITION_LABEL,
        clientId: KILLEEN_CLIENT_ID,
        librarySlug: KILLEEN_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-killeen")
  .description(
    "Sync 5 Tier 2: Path C end-to-end — live Killeen re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    KILLEEN_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      queriesFile?: string;
    }) => {
      const storage = new InMemoryStorage();
      const ingest = await runPathCIngest({
        storage,
        jurisdictionTenant: KILLEEN_JURISDICTION,
        jurisdictionName: KILLEEN_JURISDICTION_NAME,
        editionLabel: KILLEEN_EDITION_LABEL,
        clientId: KILLEEN_CLIENT_ID,
        librarySlug: KILLEEN_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildKilleenCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: KILLEEN_JURISDICTION,
        queries,
      });
      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-killeen-queries")
  .description("Print the Killeen curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildKilleenCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-san-antonio-udc")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of San Antonio Unified Development Code from the Municode JSON API (clientId 11525, product 'Unified Development Code'). San Antonio publishes the UDC as a separate Municode product from its Code of Ordinances; productNameFilter selects it. Articles I-IX + substantive Appendices. Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SAN_ANTONIO_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "8000")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      showSections?: boolean;
    }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: SAN_ANTONIO_UDC_JURISDICTION,
        jurisdictionName: SAN_ANTONIO_UDC_JURISDICTION_NAME,
        editionLabel: SAN_ANTONIO_UDC_EDITION_LABEL,
        clientId: SAN_ANTONIO_UDC_CLIENT_ID,
        librarySlug: SAN_ANTONIO_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(SAN_ANTONIO_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SAN_ANTONIO_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      const output: Record<string, unknown> = { pathCIngest: result.report };
      if (opts.showSections) {
        output.sections = result.atomization.sections.map((s) => ({
          entityId: s.entityId,
          sectionNumber: s.sectionNumber,
          title: s.title,
        }));
      }
      console.log(JSON.stringify(output, null, 2));
    },
  );

program
  .command("path-c-eval-san-antonio-udc")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live San Antonio UDC re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SAN_ANTONIO_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "8000")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(
    async (opts: {
      chapterFilter: string;
      maxLeafFetches: string;
      queriesFile?: string;
    }) => {
      const storage = new InMemoryStorage();
      const ingest = await runPathCIngest({
        storage,
        jurisdictionTenant: SAN_ANTONIO_UDC_JURISDICTION,
        jurisdictionName: SAN_ANTONIO_UDC_JURISDICTION_NAME,
        editionLabel: SAN_ANTONIO_UDC_EDITION_LABEL,
        clientId: SAN_ANTONIO_UDC_CLIENT_ID,
        librarySlug: SAN_ANTONIO_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(SAN_ANTONIO_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SAN_ANTONIO_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildSanAntonioUdcCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: SAN_ANTONIO_UDC_JURISDICTION,
        queries,
      });
      console.log(
        JSON.stringify(
          { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
          null,
          2,
        ),
      );
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-san-antonio-udc-queries")
  .description("Print the San Antonio UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildSanAntonioUdcCuratedQueries(), null, 2));
  });

program
  .command("build-corpus-snapshot")
  .description(
    "Run every onboarded jurisdiction's live ingest + eval, merge into one corpus, and write a versioned CorpusSnapshot JSON. The retrieval-api Cloud Run service boots from this artifact (Lane E Phase E0).",
  )
  .option(
    "--out <path>",
    "Output path for the snapshot JSON.",
    "services/retrieval-api/corpus/snapshot.json",
  )
  .action(async (opts: { out: string }) => {
    const { snapshot, outcomes } = await buildCorpusSnapshot({
      outPath: opts.out,
    });
    console.log(
      JSON.stringify(
        {
          outPath: opts.out,
          generatedAt: snapshot.generatedAt,
          atomCount: snapshot.atoms.length,
          linkCount: snapshot.links.length,
          jurisdictionCount: snapshot.jurisdictionStatus.length,
          jurisdictions: snapshot.jurisdictionStatus.map((s) => ({
            tenant: s.jurisdictionTenant,
            name: s.jurisdictionName,
            atomCount: s.atomCount,
            qualityBar: s.qualityBar,
            accessPolicy: s.accessPolicy,
          })),
          ingestOutcomes: outcomes.map((o) => ({
            label: o.label,
            ok: o.ok,
            sectionsIngested: o.sectionsIngested,
            evalPassed: o.evalReport?.passed ?? null,
            error: o.error,
          })),
        },
        null,
        2,
      ),
    );
    if (snapshot.jurisdictionStatus.length === 0) {
      console.error(
        "build-corpus-snapshot: no jurisdiction ingested — empty snapshot",
      );
      process.exitCode = 4;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(
    "migrate-legacy-codes error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
