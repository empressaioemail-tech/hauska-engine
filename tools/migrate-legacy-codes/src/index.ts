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
  buildCopperasCoveCuratedQueries,
  COPPERAS_COVE_CHAPTER_FILTER,
  COPPERAS_COVE_CLIENT_ID,
  COPPERAS_COVE_EDITION_LABEL,
  COPPERAS_COVE_JURISDICTION,
  COPPERAS_COVE_JURISDICTION_NAME,
  COPPERAS_COVE_LIBRARY_SLUG,
} from "./copperas-cove-curated-queries.js";
import {
  buildAustinLdcCuratedQueries,
  AUSTIN_LDC_CHAPTER_FILTER,
  AUSTIN_LDC_CLIENT_ID,
  AUSTIN_LDC_EDITION_LABEL,
  AUSTIN_LDC_JURISDICTION,
  AUSTIN_LDC_JURISDICTION_NAME,
  AUSTIN_LDC_LIBRARY_CODE_PATH,
  AUSTIN_LDC_LIBRARY_SLUG,
  AUSTIN_LDC_PRODUCT_FILTER,
} from "./austin-ldc-curated-queries.js";

import {
  buildManorCuratedQueries,
  MANOR_CHAPTER_FILTER,
  MANOR_CLIENT_ID,
  MANOR_EDITION_LABEL,
  MANOR_JURISDICTION,
  MANOR_JURISDICTION_NAME,
  MANOR_LIBRARY_SLUG,
} from "./manor-curated-queries.js";

import {
  buildLockhartCuratedQueries,
  LOCKHART_CHAPTER_FILTER,
  LOCKHART_CLIENT_ID,
  LOCKHART_EDITION_LABEL,
  LOCKHART_JURISDICTION,
  LOCKHART_JURISDICTION_NAME,
  LOCKHART_LIBRARY_SLUG,
} from "./lockhart-curated-queries.js";

import {
  buildLagoVistaCuratedQueries,
  LAGO_VISTA_CHAPTER_FILTER,
  LAGO_VISTA_CLIENT_ID,
  LAGO_VISTA_EDITION_LABEL,
  LAGO_VISTA_JURISDICTION,
  LAGO_VISTA_JURISDICTION_NAME,
  LAGO_VISTA_LIBRARY_SLUG,
} from "./lago-vista-curated-queries.js";

import {
  buildDrippingSpringsCuratedQueries,
  DRIPPING_SPRINGS_CHAPTER_FILTER,
  DRIPPING_SPRINGS_CLIENT_ID,
  DRIPPING_SPRINGS_EDITION_LABEL,
  DRIPPING_SPRINGS_JURISDICTION,
  DRIPPING_SPRINGS_JURISDICTION_NAME,
  DRIPPING_SPRINGS_LIBRARY_SLUG,
} from "./dripping-springs-curated-queries.js";

import {
  buildWimberleyCuratedQueries,
  WIMBERLEY_CHAPTER_FILTER,
  WIMBERLEY_CLIENT_ID,
  WIMBERLEY_EDITION_LABEL,
  WIMBERLEY_JURISDICTION,
  WIMBERLEY_JURISDICTION_NAME,
  WIMBERLEY_LIBRARY_SLUG,
} from "./wimberley-curated-queries.js";

import {
  buildRollingwoodCuratedQueries,
  ROLLINGWOOD_CHAPTER_FILTER,
  ROLLINGWOOD_CLIENT_ID,
  ROLLINGWOOD_EDITION_LABEL,
  ROLLINGWOOD_JURISDICTION,
  ROLLINGWOOD_JURISDICTION_NAME,
  ROLLINGWOOD_LIBRARY_SLUG,
} from "./rollingwood-curated-queries.js";

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
  buildBoerneUdcCuratedQueries,
  BOERNE_UDC_CHAPTER_FILTER,
  BOERNE_UDC_CLIENT_ID,
  BOERNE_UDC_EDITION_LABEL,
  BOERNE_UDC_JURISDICTION,
  BOERNE_UDC_JURISDICTION_NAME,
  BOERNE_UDC_LIBRARY_CODE_PATH,
  BOERNE_UDC_LIBRARY_SLUG,
  BOERNE_UDC_PRODUCT_FILTER,
} from "./boerne-udc-curated-queries.js";

import {
  buildBrownsvilleCuratedQueries,
  BROWNSVILLE_CHAPTER_FILTER,
  BROWNSVILLE_CLIENT_ID,
  BROWNSVILLE_EDITION_LABEL,
  BROWNSVILLE_JURISDICTION,
  BROWNSVILLE_JURISDICTION_NAME,
  BROWNSVILLE_LIBRARY_SLUG,
} from "./brownsville-curated-queries.js";

import {
  buildMissionCuratedQueries,
  MISSION_CHAPTER_FILTER,
  MISSION_CLIENT_ID,
  MISSION_EDITION_LABEL,
  MISSION_JURISDICTION,
  MISSION_JURISDICTION_NAME,
  MISSION_LIBRARY_SLUG,
} from "./mission-curated-queries.js";

import {
  buildSchertzUdcCuratedQueries,
  SCHERTZ_UDC_CHAPTER_FILTER,
  SCHERTZ_UDC_CLIENT_ID,
  SCHERTZ_UDC_EDITION_LABEL,
  SCHERTZ_UDC_JURISDICTION,
  SCHERTZ_UDC_JURISDICTION_NAME,
  SCHERTZ_UDC_LIBRARY_CODE_PATH,
  SCHERTZ_UDC_LIBRARY_SLUG,
  SCHERTZ_UDC_PRODUCT_FILTER,
} from "./schertz-udc-curated-queries.js";

import {
  buildSaginawCuratedQueries,
  SAGINAW_CHAPTER_FILTER,
  SAGINAW_CLIENT_ID,
  SAGINAW_EDITION_LABEL,
  SAGINAW_JURISDICTION,
  SAGINAW_JURISDICTION_NAME,
  SAGINAW_LIBRARY_SLUG,
} from "./saginaw-curated-queries.js";

import {
  buildLiveOakCuratedQueries,
  LIVE_OAK_CHAPTER_FILTER,
  LIVE_OAK_CLIENT_ID,
  LIVE_OAK_EDITION_LABEL,
  LIVE_OAK_JURISDICTION,
  LIVE_OAK_JURISDICTION_NAME,
  LIVE_OAK_LIBRARY_SLUG,
} from "./live-oak-curated-queries.js";

import {
  buildKellerCuratedQueries,
  KELLER_CHAPTER_FILTER,
  KELLER_CLIENT_ID,
  KELLER_EDITION_LABEL,
  KELLER_JURISDICTION,
  KELLER_JURISDICTION_NAME,
  KELLER_LIBRARY_SLUG,
} from "./keller-curated-queries.js";

import {
  buildCrowleyCuratedQueries,
  CROWLEY_CHAPTER_FILTER,
  CROWLEY_CLIENT_ID,
  CROWLEY_EDITION_LABEL,
  CROWLEY_JURISDICTION,
  CROWLEY_JURISDICTION_NAME,
  CROWLEY_LIBRARY_SLUG,
} from "./crowley-curated-queries.js";

import {
  buildConverseCuratedQueries,
  CONVERSE_CHAPTER_FILTER,
  CONVERSE_CLIENT_ID,
  CONVERSE_EDITION_LABEL,
  CONVERSE_JURISDICTION,
  CONVERSE_JURISDICTION_NAME,
  CONVERSE_LIBRARY_SLUG,
} from "./converse-curated-queries.js";

import {
  buildCedarHillCuratedQueries,
  CEDAR_HILL_CHAPTER_FILTER,
  CEDAR_HILL_CLIENT_ID,
  CEDAR_HILL_EDITION_LABEL,
  CEDAR_HILL_JURISDICTION,
  CEDAR_HILL_JURISDICTION_NAME,
  CEDAR_HILL_LIBRARY_SLUG,
} from "./cedar-hill-curated-queries.js";

import {
  buildPharrCuratedQueries,
  PHARR_CHAPTER_FILTER,
  PHARR_CLIENT_ID,
  PHARR_EDITION_LABEL,
  PHARR_JURISDICTION,
  PHARR_JURISDICTION_NAME,
  PHARR_LIBRARY_SLUG,
} from "./pharr-curated-queries.js";

import {
  buildCiboloCuratedQueries,
  CIBOLO_CHAPTER_FILTER,
  CIBOLO_CLIENT_ID,
  CIBOLO_EDITION_LABEL,
  CIBOLO_JURISDICTION,
  CIBOLO_JURISDICTION_NAME,
  CIBOLO_LIBRARY_SLUG,
} from "./cibolo-curated-queries.js";

import {
  buildSelmaCuratedQueries,
  SELMA_CHAPTER_FILTER,
  SELMA_CLIENT_ID,
  SELMA_EDITION_LABEL,
  SELMA_JURISDICTION,
  SELMA_JURISDICTION_NAME,
  SELMA_LIBRARY_SLUG,
} from "./selma-curated-queries.js";

import {
  buildUniversalCityCuratedQueries,
  UNIVERSAL_CITY_CHAPTER_FILTER,
  UNIVERSAL_CITY_CLIENT_ID,
  UNIVERSAL_CITY_EDITION_LABEL,
  UNIVERSAL_CITY_JURISDICTION,
  UNIVERSAL_CITY_JURISDICTION_NAME,
  UNIVERSAL_CITY_LIBRARY_SLUG,
} from "./universal-city-curated-queries.js";

import {
  buildLeonValleyCuratedQueries,
  LEON_VALLEY_CHAPTER_FILTER,
  LEON_VALLEY_CLIENT_ID,
  LEON_VALLEY_EDITION_LABEL,
  LEON_VALLEY_JURISDICTION,
  LEON_VALLEY_JURISDICTION_NAME,
  LEON_VALLEY_LIBRARY_SLUG,
} from "./leon-valley-curated-queries.js";

import {
  buildAnthonyCuratedQueries,
  ANTHONY_CHAPTER_FILTER,
  ANTHONY_CLIENT_ID,
  ANTHONY_EDITION_LABEL,
  ANTHONY_JURISDICTION,
  ANTHONY_JURISDICTION_NAME,
  ANTHONY_LIBRARY_SLUG,
} from "./anthony-curated-queries.js";

import {
  buildSocorroCuratedQueries,
  SOCORRO_CHAPTER_FILTER,
  SOCORRO_CLIENT_ID,
  SOCORRO_EDITION_LABEL,
  SOCORRO_JURISDICTION,
  SOCORRO_JURISDICTION_NAME,
  SOCORRO_LIBRARY_SLUG,
} from "./socorro-curated-queries.js";

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
  .command("path-c-ingest-copperas-cove")
  .description(
    "Sync 5 Tier 2: Path C live re-ingest of the City of Copperas Cove land-development chapters (Sign Regulations Ch 16.5, Subdivisions Ch 17.5, Zoning Ch 20) from the Municode JSON API (clientId 1761). Tagged platform-internal.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    COPPERAS_COVE_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
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
        jurisdictionTenant: COPPERAS_COVE_JURISDICTION,
        jurisdictionName: COPPERAS_COVE_JURISDICTION_NAME,
        editionLabel: COPPERAS_COVE_EDITION_LABEL,
        clientId: COPPERAS_COVE_CLIENT_ID,
        librarySlug: COPPERAS_COVE_LIBRARY_SLUG,
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
  .command("path-c-eval-copperas-cove")
  .description("Sync 5 Tier 2: Copperas Cove re-ingest + curated-query eval.")
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    COPPERAS_COVE_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
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
        jurisdictionTenant: COPPERAS_COVE_JURISDICTION,
        jurisdictionName: COPPERAS_COVE_JURISDICTION_NAME,
        editionLabel: COPPERAS_COVE_EDITION_LABEL,
        clientId: COPPERAS_COVE_CLIENT_ID,
        librarySlug: COPPERAS_COVE_LIBRARY_SLUG,
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
        queries = buildCopperasCoveCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: COPPERAS_COVE_JURISDICTION,
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
  .command("export-copperas-cove-queries")
  .description("Print the Copperas Cove curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildCopperasCoveCuratedQueries(), null, 2));
  });

program
  .command("path-c-ingest-austin-ldc")
  .description(
    "Sync 5 Tier 2: Path C live re-ingest of the City of Austin Land Development Code from the Municode JSON API (clientId 1113, product 'Land Development Code'). Austin publishes the LDC as a separate Municode product from its Code of Ordinances; productNameFilter selects it. Title 25 (Land Development) + Title 30 (Austin/Travis County Subdivision Regulations). Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    AUSTIN_LDC_CHAPTER_FILTER,
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
        jurisdictionTenant: AUSTIN_LDC_JURISDICTION,
        jurisdictionName: AUSTIN_LDC_JURISDICTION_NAME,
        editionLabel: AUSTIN_LDC_EDITION_LABEL,
        clientId: AUSTIN_LDC_CLIENT_ID,
        librarySlug: AUSTIN_LDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(AUSTIN_LDC_PRODUCT_FILTER, "i"),
        libraryCodePath: AUSTIN_LDC_LIBRARY_CODE_PATH,
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
  .command("path-c-eval-austin-ldc")
  .description(
    "Sync 5 Tier 2: Path C end-to-end — live Austin LDC re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    AUSTIN_LDC_CHAPTER_FILTER,
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
        jurisdictionTenant: AUSTIN_LDC_JURISDICTION,
        jurisdictionName: AUSTIN_LDC_JURISDICTION_NAME,
        editionLabel: AUSTIN_LDC_EDITION_LABEL,
        clientId: AUSTIN_LDC_CLIENT_ID,
        librarySlug: AUSTIN_LDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(AUSTIN_LDC_PRODUCT_FILTER, "i"),
        libraryCodePath: AUSTIN_LDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildAustinLdcCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: AUSTIN_LDC_JURISDICTION,
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
  .command("export-austin-ldc-queries")
  .description("Print the Austin LDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildAustinLdcCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-manor")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Manor land-development chapters (Subdivision Regulation Ch 10, Zoning Ch 14, Site Development Ch 15) from the Municode JSON API (clientId 15968). Exhibit-ordinance pattern (Leander-style). Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", MANOR_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(
    async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
      const storage = new InMemoryStorage();
      const result = await runPathCIngest({
        storage,
        jurisdictionTenant: MANOR_JURISDICTION,
        jurisdictionName: MANOR_JURISDICTION_NAME,
        editionLabel: MANOR_EDITION_LABEL,
        clientId: MANOR_CLIENT_ID,
        librarySlug: MANOR_LIBRARY_SLUG,
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
  .command("path-c-eval-manor")
  .description("Sync 5 Tier 2: Manor re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", MANOR_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(
    async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
      const storage = new InMemoryStorage();
      const ingest = await runPathCIngest({
        storage,
        jurisdictionTenant: MANOR_JURISDICTION,
        jurisdictionName: MANOR_JURISDICTION_NAME,
        editionLabel: MANOR_EDITION_LABEL,
        clientId: MANOR_CLIENT_ID,
        librarySlug: MANOR_LIBRARY_SLUG,
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
        queries = buildManorCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: MANOR_JURISDICTION,
        queries,
      });
      console.log(JSON.stringify(
        { pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed },
        null, 2,
      ));
      if (!report.passed) process.exitCode = 4;
    },
  );

program
  .command("export-manor-queries")
  .description("Print the Manor curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildManorCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-lockhart")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Lockhart land-development chapters (Signs Ch 46, Subdivision Regulations Ch 52, Zoning Ch 64) from the Municode JSON API (clientId 3055). Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", LOCKHART_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: LOCKHART_JURISDICTION,
      jurisdictionName: LOCKHART_JURISDICTION_NAME,
      editionLabel: LOCKHART_EDITION_LABEL,
      clientId: LOCKHART_CLIENT_ID,
      librarySlug: LOCKHART_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-lockhart")
  .description("Sync 5 Tier 2: Lockhart re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", LOCKHART_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: LOCKHART_JURISDICTION,
      jurisdictionName: LOCKHART_JURISDICTION_NAME,
      editionLabel: LOCKHART_EDITION_LABEL,
      clientId: LOCKHART_CLIENT_ID,
      librarySlug: LOCKHART_LIBRARY_SLUG,
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
      queries = buildLockhartCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: LOCKHART_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-lockhart-queries")
  .description("Print the Lockhart curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildLockhartCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-lago-vista")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Lago Vista land-development chapters (Site Development Ch 3.5, Signs Ch 5, Subdivision Regulation Ch 10, Zoning Ch 14, Growth Management Ch 15) from the Municode JSON API (clientId 2904). Exhibit-ordinance pattern in Ch 10/14. Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", LAGO_VISTA_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: LAGO_VISTA_JURISDICTION,
      jurisdictionName: LAGO_VISTA_JURISDICTION_NAME,
      editionLabel: LAGO_VISTA_EDITION_LABEL,
      clientId: LAGO_VISTA_CLIENT_ID,
      librarySlug: LAGO_VISTA_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-lago-vista")
  .description("Sync 5 Tier 2: Lago Vista re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", LAGO_VISTA_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: LAGO_VISTA_JURISDICTION,
      jurisdictionName: LAGO_VISTA_JURISDICTION_NAME,
      editionLabel: LAGO_VISTA_EDITION_LABEL,
      clientId: LAGO_VISTA_CLIENT_ID,
      librarySlug: LAGO_VISTA_LIBRARY_SLUG,
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
      queries = buildLagoVistaCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: LAGO_VISTA_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-lago-vista-queries")
  .description("Print the Lago Vista curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildLagoVistaCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-dripping-springs")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Dripping Springs land-development chapters (Signs Ch 26, Subdivisions+Site Dev Ch 28, Zoning Ch 30) from the Municode JSON API (clientId 15829). Exhibit pattern in Ch 28/30. Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", DRIPPING_SPRINGS_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: DRIPPING_SPRINGS_JURISDICTION,
      jurisdictionName: DRIPPING_SPRINGS_JURISDICTION_NAME,
      editionLabel: DRIPPING_SPRINGS_EDITION_LABEL,
      clientId: DRIPPING_SPRINGS_CLIENT_ID,
      librarySlug: DRIPPING_SPRINGS_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-dripping-springs")
  .description("Sync 5 Tier 2: Dripping Springs re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", DRIPPING_SPRINGS_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "800")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: DRIPPING_SPRINGS_JURISDICTION,
      jurisdictionName: DRIPPING_SPRINGS_JURISDICTION_NAME,
      editionLabel: DRIPPING_SPRINGS_EDITION_LABEL,
      clientId: DRIPPING_SPRINGS_CLIENT_ID,
      librarySlug: DRIPPING_SPRINGS_LIBRARY_SLUG,
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
      queries = buildDrippingSpringsCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: DRIPPING_SPRINGS_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-dripping-springs-queries")
  .description("Print the Dripping Springs curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildDrippingSpringsCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-wimberley")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Wimberley Chapter 9 Planning and Development Regulations (Municode clientId 16024). Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", WIMBERLEY_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: WIMBERLEY_JURISDICTION,
      jurisdictionName: WIMBERLEY_JURISDICTION_NAME,
      editionLabel: WIMBERLEY_EDITION_LABEL,
      clientId: WIMBERLEY_CLIENT_ID,
      librarySlug: WIMBERLEY_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-wimberley")
  .description("Sync 5 Tier 2: Wimberley re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", WIMBERLEY_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: WIMBERLEY_JURISDICTION,
      jurisdictionName: WIMBERLEY_JURISDICTION_NAME,
      editionLabel: WIMBERLEY_EDITION_LABEL,
      clientId: WIMBERLEY_CLIENT_ID,
      librarySlug: WIMBERLEY_LIBRARY_SLUG,
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
      queries = buildWimberleyCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: WIMBERLEY_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-wimberley-queries")
  .description("Print the Wimberley curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildWimberleyCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-rollingwood")
  .description("Sync 5 Tier 2: Path C live re-ingest of the City of Rollingwood Part II Land Development Code (Municode clientId 12936). Tagged platform-internal.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", ROLLINGWOOD_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: ROLLINGWOOD_JURISDICTION,
      jurisdictionName: ROLLINGWOOD_JURISDICTION_NAME,
      editionLabel: ROLLINGWOOD_EDITION_LABEL,
      clientId: ROLLINGWOOD_CLIENT_ID,
      librarySlug: ROLLINGWOOD_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({
        entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title,
      }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-rollingwood")
  .description("Sync 5 Tier 2: Rollingwood re-ingest + curated-query eval.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex.", ROLLINGWOOD_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "400")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: ROLLINGWOOD_JURISDICTION,
      jurisdictionName: ROLLINGWOOD_JURISDICTION_NAME,
      editionLabel: ROLLINGWOOD_EDITION_LABEL,
      clientId: ROLLINGWOOD_CLIENT_ID,
      librarySlug: ROLLINGWOOD_LIBRARY_SLUG,
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
      queries = buildRollingwoodCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: ROLLINGWOOD_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-rollingwood-queries")
  .description("Print the Rollingwood curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildRollingwoodCuratedQueries(), null, 2)); });


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
  .command("path-c-ingest-boerne-udc")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of Boerne Unified Development Code from the Municode JSON API (clientId 1332, product 'Unified Development Code'). Boerne publishes its UDC as a separate Municode product from its Code of Ordinances; productNameFilter selects it. Nine UDC chapters (1-9). Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    BOERNE_UDC_CHAPTER_FILTER,
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
        jurisdictionTenant: BOERNE_UDC_JURISDICTION,
        jurisdictionName: BOERNE_UDC_JURISDICTION_NAME,
        editionLabel: BOERNE_UDC_EDITION_LABEL,
        clientId: BOERNE_UDC_CLIENT_ID,
        librarySlug: BOERNE_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(BOERNE_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: BOERNE_UDC_LIBRARY_CODE_PATH,
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
  .command("path-c-eval-boerne-udc")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live Boerne UDC re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    BOERNE_UDC_CHAPTER_FILTER,
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
        jurisdictionTenant: BOERNE_UDC_JURISDICTION,
        jurisdictionName: BOERNE_UDC_JURISDICTION_NAME,
        editionLabel: BOERNE_UDC_EDITION_LABEL,
        clientId: BOERNE_UDC_CLIENT_ID,
        librarySlug: BOERNE_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(BOERNE_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: BOERNE_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildBoerneUdcCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: BOERNE_UDC_JURISDICTION,
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
  .command("export-boerne-udc-queries")
  .description("Print the Boerne UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildBoerneUdcCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-brownsville")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of Brownsville development regulations from the Municode JSON API (clientId 1440). Mixed-shape dev surface: chapter-style CoO chapters (18, 46, 86, 102, 308, 314, 328) + UDO-style ARTICLE 1-5 (General Provisions, Administration and Review Procedures, Subdivision Regulations, Zoning Regulations, Supplemental Regulations). Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    BROWNSVILLE_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
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
        jurisdictionTenant: BROWNSVILLE_JURISDICTION,
        jurisdictionName: BROWNSVILLE_JURISDICTION_NAME,
        editionLabel: BROWNSVILLE_EDITION_LABEL,
        clientId: BROWNSVILLE_CLIENT_ID,
        librarySlug: BROWNSVILLE_LIBRARY_SLUG,
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
  .command("path-c-eval-brownsville")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live Brownsville re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    BROWNSVILLE_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
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
        jurisdictionTenant: BROWNSVILLE_JURISDICTION,
        jurisdictionName: BROWNSVILLE_JURISDICTION_NAME,
        editionLabel: BROWNSVILLE_EDITION_LABEL,
        clientId: BROWNSVILLE_CLIENT_ID,
        librarySlug: BROWNSVILLE_LIBRARY_SLUG,
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
        queries = buildBrownsvilleCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: BROWNSVILLE_JURISDICTION,
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
  .command("export-brownsville-queries")
  .description("Print the Brownsville curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildBrownsvilleCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-mission")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of Mission development regulations from the Municode JSON API (clientId 3334). Top-level CoO chapters covering Buildings, Flood Damage, Manufactured Homes, Planning/Zoning procedures, Signs, Streets, Subdivisions, Utilities + Appendix A Zoning. Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    MISSION_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
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
        jurisdictionTenant: MISSION_JURISDICTION,
        jurisdictionName: MISSION_JURISDICTION_NAME,
        editionLabel: MISSION_EDITION_LABEL,
        clientId: MISSION_CLIENT_ID,
        librarySlug: MISSION_LIBRARY_SLUG,
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
  .command("path-c-eval-mission")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live Mission re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    MISSION_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
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
        jurisdictionTenant: MISSION_JURISDICTION,
        jurisdictionName: MISSION_JURISDICTION_NAME,
        editionLabel: MISSION_EDITION_LABEL,
        clientId: MISSION_CLIENT_ID,
        librarySlug: MISSION_LIBRARY_SLUG,
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
        queries = buildMissionCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: MISSION_JURISDICTION,
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
  .command("export-mission-queries")
  .description("Print the Mission curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildMissionCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-schertz-udc")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of Schertz Unified Development Code from the Municode JSON API (clientId 4260). Schertz publishes its UDC as a separate Municode product (productId 14745). Top-level TOC carries a single wrapper node 'SCHERTZ UNIFIED DEVELOPMENT CODE' containing 16 Articles (1-16). Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SCHERTZ_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
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
        jurisdictionTenant: SCHERTZ_UDC_JURISDICTION,
        jurisdictionName: SCHERTZ_UDC_JURISDICTION_NAME,
        editionLabel: SCHERTZ_UDC_EDITION_LABEL,
        clientId: SCHERTZ_UDC_CLIENT_ID,
        librarySlug: SCHERTZ_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(SCHERTZ_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SCHERTZ_UDC_LIBRARY_CODE_PATH,
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
  .command("path-c-eval-schertz-udc")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live Schertz UDC re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SCHERTZ_UDC_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
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
        jurisdictionTenant: SCHERTZ_UDC_JURISDICTION,
        jurisdictionName: SCHERTZ_UDC_JURISDICTION_NAME,
        editionLabel: SCHERTZ_UDC_EDITION_LABEL,
        clientId: SCHERTZ_UDC_CLIENT_ID,
        librarySlug: SCHERTZ_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(opts.chapterFilter, "i"),
        productNameFilter: new RegExp(SCHERTZ_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SCHERTZ_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: Number(opts.maxLeafFetches),
        accessPolicy: "platform-internal",
      });
      let queries: ReadonlyArray<CuratedQuery>;
      if (opts.queriesFile) {
        const fs = await import("node:fs/promises");
        queries = JSON.parse(await fs.readFile(opts.queriesFile, "utf8")) as CuratedQuery[];
      } else {
        queries = buildSchertzUdcCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: SCHERTZ_UDC_JURISDICTION,
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
  .command("export-schertz-udc-queries")
  .description("Print the Schertz UDC curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildSchertzUdcCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-saginaw")
  .description(
    "Sync 5 TX-metros: Path C live re-ingest of the City of Saginaw development regulations from the Municode JSON API (clientId 4174). Five CoO chapters + Appendices A (Zoning) and B (Subdivisions). Layer 3 bespoke local code; tagged platform-internal per Path A.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SAGINAW_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
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
        jurisdictionTenant: SAGINAW_JURISDICTION,
        jurisdictionName: SAGINAW_JURISDICTION_NAME,
        editionLabel: SAGINAW_EDITION_LABEL,
        clientId: SAGINAW_CLIENT_ID,
        librarySlug: SAGINAW_LIBRARY_SLUG,
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
  .command("path-c-eval-saginaw")
  .description(
    "Sync 5 TX-metros: Path C end-to-end — live Saginaw re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    SAGINAW_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
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
        jurisdictionTenant: SAGINAW_JURISDICTION,
        jurisdictionName: SAGINAW_JURISDICTION_NAME,
        editionLabel: SAGINAW_EDITION_LABEL,
        clientId: SAGINAW_CLIENT_ID,
        librarySlug: SAGINAW_LIBRARY_SLUG,
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
        queries = buildSaginawCuratedQueries();
      }
      const report = await evaluate({
        storage,
        jurisdictionTenant: SAGINAW_JURISDICTION,
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
  .command("export-saginaw-queries")
  .description("Print the Saginaw curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildSaginawCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-live-oak")
  .description("Sync 5 TX-metros: Path C live re-ingest of the City of Live Oak development regulations from the Municode JSON API (clientId 11903). Seven top-level CoO chapters covering Buildings/Floods/Property Maintenance/Streets/Subdivision/Utilities/Zoning. Layer 3; platform-internal per Path A.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", LIVE_OAK_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1000")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: LIVE_OAK_JURISDICTION,
      jurisdictionName: LIVE_OAK_JURISDICTION_NAME,
      editionLabel: LIVE_OAK_EDITION_LABEL,
      clientId: LIVE_OAK_CLIENT_ID,
      librarySlug: LIVE_OAK_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({ entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-live-oak")
  .description("Sync 5 TX-metros: Path C end-to-end Live Oak.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", LIVE_OAK_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1000")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: LIVE_OAK_JURISDICTION,
      jurisdictionName: LIVE_OAK_JURISDICTION_NAME,
      editionLabel: LIVE_OAK_EDITION_LABEL,
      clientId: LIVE_OAK_CLIENT_ID,
      librarySlug: LIVE_OAK_LIBRARY_SLUG,
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
      queries = buildLiveOakCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: LIVE_OAK_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-live-oak-queries")
  .description("Print the Live Oak curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildLiveOakCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-keller")
  .description("Sync 5 TX-metros: Path C live re-ingest of the City of Keller Unified Development Code from the Municode JSON API (clientId 2809). UDC lives at top-level under `PART III - UNIFIED DEVELOPMENT CODE`; the chapter filter targets that wrapper. Layer 3; platform-internal per Path A.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", KELLER_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: KELLER_JURISDICTION,
      jurisdictionName: KELLER_JURISDICTION_NAME,
      editionLabel: KELLER_EDITION_LABEL,
      clientId: KELLER_CLIENT_ID,
      librarySlug: KELLER_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({ entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-keller")
  .description("Sync 5 TX-metros: Path C end-to-end Keller.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", KELLER_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "2000")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: KELLER_JURISDICTION,
      jurisdictionName: KELLER_JURISDICTION_NAME,
      editionLabel: KELLER_EDITION_LABEL,
      clientId: KELLER_CLIENT_ID,
      librarySlug: KELLER_LIBRARY_SLUG,
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
      queries = buildKellerCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: KELLER_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-keller-queries")
  .description("Print the Keller curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildKellerCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-crowley")
  .description("Sync 5 TX-metros: Path C live re-ingest of the City of Crowley development regulations from the Municode JSON API (clientId 1823). Eleven top-level CoO dev chapters + Appendix A. Layer 3; platform-internal per Path A.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", CROWLEY_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: CROWLEY_JURISDICTION,
      jurisdictionName: CROWLEY_JURISDICTION_NAME,
      editionLabel: CROWLEY_EDITION_LABEL,
      clientId: CROWLEY_CLIENT_ID,
      librarySlug: CROWLEY_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({ entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-crowley")
  .description("Sync 5 TX-metros: Path C end-to-end Crowley.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", CROWLEY_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: CROWLEY_JURISDICTION,
      jurisdictionName: CROWLEY_JURISDICTION_NAME,
      editionLabel: CROWLEY_EDITION_LABEL,
      clientId: CROWLEY_CLIENT_ID,
      librarySlug: CROWLEY_LIBRARY_SLUG,
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
      queries = buildCrowleyCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: CROWLEY_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-crowley-queries")
  .description("Print the Crowley curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildCrowleyCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-converse")
  .description("Sync 5 TX-metros: Path C live re-ingest of the City of Converse development regulations from the Municode JSON API (clientId 1749). Ten top-level CoO dev chapters. Layer 3; platform-internal per Path A.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", CONVERSE_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: CONVERSE_JURISDICTION,
      jurisdictionName: CONVERSE_JURISDICTION_NAME,
      editionLabel: CONVERSE_EDITION_LABEL,
      clientId: CONVERSE_CLIENT_ID,
      librarySlug: CONVERSE_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({ entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-converse")
  .description("Sync 5 TX-metros: Path C end-to-end Converse.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", CONVERSE_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: CONVERSE_JURISDICTION,
      jurisdictionName: CONVERSE_JURISDICTION_NAME,
      editionLabel: CONVERSE_EDITION_LABEL,
      clientId: CONVERSE_CLIENT_ID,
      librarySlug: CONVERSE_LIBRARY_SLUG,
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
      queries = buildConverseCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: CONVERSE_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-converse-queries")
  .description("Print the Converse curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildConverseCuratedQueries(), null, 2)); });


program
  .command("path-c-ingest-cedar-hill")
  .description(
    "Sprint 40i / QA-60: Path C live re-ingest of Cedar Hill land-development chapters (Buildings, Flood, Natural Resources, Planning, Subdivision, Zoning) from Municode JSON API (clientId 1568). Primary substrate for QA-58 Cedar Hill geocode; tagged platform-internal.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    CEDAR_HILL_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1200")
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
        jurisdictionTenant: CEDAR_HILL_JURISDICTION,
        jurisdictionName: CEDAR_HILL_JURISDICTION_NAME,
        editionLabel: CEDAR_HILL_EDITION_LABEL,
        clientId: CEDAR_HILL_CLIENT_ID,
        librarySlug: CEDAR_HILL_LIBRARY_SLUG,
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
  .command("path-c-eval-cedar-hill")
  .description(
    "Sprint 40i / QA-60: Path C end-to-end — live Cedar Hill re-ingest + curated-query eval against the B.4 quality bar.",
  )
  .option(
    "--chapter-filter <regex>",
    "Top-level TOC chapter filter regex (case-insensitive).",
    CEDAR_HILL_CHAPTER_FILTER,
  )
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1200")
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
        jurisdictionTenant: CEDAR_HILL_JURISDICTION,
        jurisdictionName: CEDAR_HILL_JURISDICTION_NAME,
        editionLabel: CEDAR_HILL_EDITION_LABEL,
        clientId: CEDAR_HILL_CLIENT_ID,
        librarySlug: CEDAR_HILL_LIBRARY_SLUG,
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
        queries = buildCedarHillCuratedQueries();
      }

      const report = await evaluate({
        storage,
        jurisdictionTenant: CEDAR_HILL_JURISDICTION,
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
  .command("export-cedar-hill-queries")
  .description("Print the Cedar Hill curated-query JSON to stdout.")
  .action(() => {
    console.log(JSON.stringify(buildCedarHillCuratedQueries(), null, 2));
  });


program
  .command("path-c-ingest-pharr")
  .description("Sync 5 lane central: Path C live re-ingest of Pharr development regulations (clientId 3842). platform-internal per Path A.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", PHARR_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--show-sections", "Print all ingested section entityIds + numbers + titles.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; showSections?: boolean }) => {
    const storage = new InMemoryStorage();
    const result = await runPathCIngest({
      storage,
      jurisdictionTenant: PHARR_JURISDICTION,
      jurisdictionName: PHARR_JURISDICTION_NAME,
      editionLabel: PHARR_EDITION_LABEL,
      clientId: PHARR_CLIENT_ID,
      librarySlug: PHARR_LIBRARY_SLUG,
      stateAbbr: "TX",
      chapterFilter: new RegExp(opts.chapterFilter, "i"),
      maxLeafFetches: Number(opts.maxLeafFetches),
      accessPolicy: "platform-internal",
    });
    const output: Record<string, unknown> = { pathCIngest: result.report };
    if (opts.showSections) {
      output.sections = result.atomization.sections.map((s) => ({ entityId: s.entityId, sectionNumber: s.sectionNumber, title: s.title }));
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("path-c-eval-pharr")
  .description("Sync 5 lane central: Path C end-to-end Pharr development regulations.")
  .option("--chapter-filter <regex>", "Top-level TOC chapter filter regex (case-insensitive).", PHARR_CHAPTER_FILTER)
  .option("--max-leaf-fetches <n>", "Cap on per-section Municode fetches", "1500")
  .option("--queries-file <path>", "Optional JSON file of curated queries.")
  .action(async (opts: { chapterFilter: string; maxLeafFetches: string; queriesFile?: string }) => {
    const storage = new InMemoryStorage();
    const ingest = await runPathCIngest({
      storage,
      jurisdictionTenant: PHARR_JURISDICTION,
      jurisdictionName: PHARR_JURISDICTION_NAME,
      editionLabel: PHARR_EDITION_LABEL,
      clientId: PHARR_CLIENT_ID,
      librarySlug: PHARR_LIBRARY_SLUG,
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
      queries = buildPharrCuratedQueries();
    }
    const report = await evaluate({ storage, jurisdictionTenant: PHARR_JURISDICTION, queries });
    console.log(JSON.stringify({ pathCIngest: ingest.report, eval: report, syncFiveReady: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 4;
  });

program
  .command("export-pharr-queries")
  .description("Print the Pharr curated-query JSON to stdout.")
  .action(() => { console.log(JSON.stringify(buildPharrCuratedQueries(), null, 2)); });














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
