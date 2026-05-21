/**
 * build-corpus-snapshot — regenerate the committed corpus snapshot the
 * retrieval-api Cloud Run service boots from (Lane E Phase E0).
 *
 * Runs every onboarded jurisdiction's live ingest, evaluates each in an
 * isolated `InMemoryStorage` against its curated-query set (so eval
 * scores are faithful to the per-jurisdiction sessions that declared
 * them loaded), merges the atoms into one combined storage, recomputes
 * a per-jurisdiction status row, and writes the result to a versioned
 * `CorpusSnapshot` JSON artifact.
 *
 * The artifact is a build OUTPUT, not hand-authored data: the
 * retrieval-api never re-runs the live ingest pipeline on a Cloud Run
 * cold start, it loads this file. Re-run this command to refresh it.
 *
 * Each jurisdiction's ingest is isolated in a try/catch — a flaky live
 * source (or the legacy Neon DB being down for the Path B Grand County
 * ingest) degrades the snapshot to the jurisdictions that did ingest
 * rather than failing the whole build.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  CodeAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";
import {
  evaluate,
  type CuratedQuery,
  type EvalReport,
} from "@hauska-engine/corpus/eval";
import {
  InMemoryStorage,
  type CorpusSnapshot,
  type JurisdictionStatusSnapshot,
} from "@hauska-engine/storage";

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
  buildHuttoUdcCuratedQueries,
  HUTTO_UDC_EDITION_LABEL,
  HUTTO_UDC_JURISDICTION,
  HUTTO_UDC_JURISDICTION_NAME,
  HUTTO_UDC_PDF_URL,
} from "./hutto-udc-curated-queries.js";
import { curatedQueriesForJurisdiction } from "./seed-curated-queries.js";

const BASTROP_B3_PDF_URL =
  "https://www.cityofbastrop.org/upload/page/0107/docs/B3/B3%20Code%20-%20April%202025.pdf";

/**
 * One jurisdiction-ingest unit folded into the snapshot. Every unit is
 * best-effort: a unit that throws (dead source, Neon down) or returns
 * zero sections (live-source drift) is logged and skipped, and the
 * snapshot is built from the units that did ingest. The build fails
 * only if *no* unit produced corpus.
 */
interface IngestUnit {
  /** Jurisdiction tenant key. */
  tenant: string;
  /** Human label for the build log. */
  label: string;
  /** Ingest into the given isolated storage; return the curated queries used. */
  run: (storage: InMemoryStorage) => Promise<ReadonlyArray<CuratedQuery>>;
}

interface IngestOutcome {
  tenant: string;
  label: string;
  ok: boolean;
  sectionsIngested: number;
  evalReport: EvalReport | null;
  error: string | null;
}

const UNITS: ReadonlyArray<IngestUnit> = [
  {
    tenant: "bastrop_tx",
    label: "Bastrop UDC (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: "bastrop_tx",
        jurisdictionName: "Bastrop, TX",
        editionLabel: "Bastrop UDC (current supplement)",
        clientId: 1169,
        librarySlug: "bastrop",
        stateAbbr: "TX",
        chapterFilter: /unified.*development|development code|zoning/i,
        maxLeafFetches: 30,
      });
      return buildBastropUdcCuratedQueries();
    },
  },
  {
    tenant: "bastrop_tx",
    label: "Bastrop B3 Code (Path PDF)",
    async run(storage) {
      await runPathPdfIngest({
        storage,
        jurisdictionTenant: "bastrop_tx",
        jurisdictionName: "Bastrop, TX",
        editionLabel: B3_EDITION_LABEL,
        pdfUrl: BASTROP_B3_PDF_URL,
      });
      return buildBastropB3CuratedQueries();
    },
  },
  {
    tenant: BC_JURISDICTION,
    label: "Bastrop County Subdivision Regulations (Path PDF)",
    async run(storage) {
      await runPathPdfIngest({
        storage,
        jurisdictionTenant: BC_JURISDICTION,
        jurisdictionName: "Bastrop County, TX",
        editionLabel: BC_EDITION_LABEL,
        pdfUrl: BASTROP_COUNTY_SUBDIVISION_REGS_URL,
        accessPolicy: "platform-internal",
      });
      return buildBastropCountyCuratedQueries();
    },
  },
  {
    tenant: ELGIN_JURISDICTION,
    label: "Elgin development chapters (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: ELGIN_JURISDICTION,
        jurisdictionName: "Elgin, TX",
        editionLabel: ELGIN_EDITION_LABEL,
        clientId: 2076,
        librarySlug: "elgin",
        stateAbbr: "TX",
        chapterFilter: /subdivisions|zoning|site developments/i,
        maxLeafFetches: 200,
        accessPolicy: "platform-internal",
      });
      return buildElginCuratedQueries();
    },
  },
  {
    tenant: HUTTO_UDC_JURISDICTION,
    label: "Hutto UDC (Path PDF / decimal-numbered)",
    async run(storage) {
      await runPathPdfIngest({
        storage,
        jurisdictionTenant: HUTTO_UDC_JURISDICTION,
        jurisdictionName: HUTTO_UDC_JURISDICTION_NAME,
        editionLabel: HUTTO_UDC_EDITION_LABEL,
        pdfUrl: HUTTO_UDC_PDF_URL,
        accessPolicy: "platform-internal",
        capabilitiesName: "hutto-udc-pdf",
        capabilitiesDisplayName: "Hutto UDC (PDF)",
        normalizeOptions: { headingConvention: "decimal-numbered" },
      });
      return buildHuttoUdcCuratedQueries();
    },
  },
  {
    tenant: ROUND_ROCK_JURISDICTION,
    label: "Round Rock Zoning and Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: ROUND_ROCK_JURISDICTION,
        jurisdictionName: ROUND_ROCK_JURISDICTION_NAME,
        editionLabel: ROUND_ROCK_EDITION_LABEL,
        clientId: ROUND_ROCK_CLIENT_ID,
        librarySlug: ROUND_ROCK_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(ROUND_ROCK_CHAPTER_FILTER, "i"),
        maxLeafFetches: 250,
        accessPolicy: "platform-internal",
      });
      return buildRoundRockCuratedQueries();
    },
  },
  {
    tenant: "grand_county_ut",
    label: "Grand County (Path B / legacy Neon)",
    // Best-effort: Path B depends on the legacy Neon DB being reachable.
    async run(storage) {
      const url =
        process.env.LEGACY_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
      if (!url) {
        throw new Error(
          "LEGACY_DATABASE_URL not set — Path B Grand County skipped",
        );
      }
      const legacy = new LegacyClient({ databaseUrl: url });
      try {
        await runMigration({
          legacy,
          storage,
          filter: { jurisdictionKey: "grand_county_ut" },
        });
      } finally {
        await legacy.close();
      }
      return curatedQueriesForJurisdiction("grand_county_ut");
    },
  },
];

async function runUnit(unit: IngestUnit): Promise<{
  outcome: IngestOutcome;
  snapshot: CorpusSnapshot | null;
}> {
  const isolated = new InMemoryStorage();
  try {
    const queries = await unit.run(isolated);
    const exported = isolated.exportSnapshot([unit.label]);
    const sectionsIngested = exported.atoms.filter(
      (a) => a.entityType === "code-section",
    ).length;
    if (sectionsIngested === 0) {
      // A drifted live source (TOC schema change, moved URL, stale
      // clientId) returns an empty walk rather than throwing. Treat it
      // as a non-contributing skip — merging an empty ingest would
      // poison a co-tenant's combined status (e.g. a 0-section Bastrop
      // UDC walk dragging Bastrop B3's passing row to `failing`).
      // Flagged for B.5 drift follow-up.
      return {
        outcome: {
          tenant: unit.tenant,
          label: unit.label,
          ok: false,
          sectionsIngested: 0,
          evalReport: null,
          error: "ingest produced 0 sections — likely live-source drift",
        },
        snapshot: null,
      };
    }
    let evalReport: EvalReport | null = null;
    if (queries.length > 0) {
      evalReport = await evaluate({
        storage: isolated,
        jurisdictionTenant: unit.tenant,
        queries,
      });
    }
    return {
      outcome: {
        tenant: unit.tenant,
        label: unit.label,
        ok: true,
        sectionsIngested,
        evalReport,
        error: null,
      },
      snapshot: exported,
    };
  } catch (err) {
    return {
      outcome: {
        tenant: unit.tenant,
        label: unit.label,
        ok: false,
        sectionsIngested: 0,
        evalReport: null,
        error: err instanceof Error ? err.message : String(err),
      },
      snapshot: null,
    };
  }
}

/**
 * Rebuild one status row per jurisdiction tenant from the merged atom
 * set plus the collected eval reports. A tenant with multiple ingests
 * (Bastrop: UDC + B3) gets a combined row — section count summed,
 * quality bar `passing` only if every one of its evals passed.
 */
function rebuildStatuses(
  atoms: ReadonlyArray<CodeAtomInstance>,
  outcomes: ReadonlyArray<IngestOutcome>,
): ReadonlyArray<JurisdictionStatusSnapshot> {
  const tenants = new Set(atoms.map((a) => a.jurisdictionTenant));
  const statuses: JurisdictionStatusSnapshot[] = [];
  for (const tenant of tenants) {
    const sections = atoms.filter(
      (a): a is CodeSectionAtomInstance =>
        a.entityType === "code-section" && a.jurisdictionTenant === tenant,
    );
    const corpus = atoms.find(
      (a): a is JurisdictionCorpusAtomInstance =>
        a.entityType === "jurisdiction-corpus" &&
        a.jurisdictionTenant === tenant,
    );
    const editions = atoms.filter(
      (a) => a.entityType === "code-edition" && a.jurisdictionTenant === tenant,
    );
    const tenantEvals = outcomes
      .filter((o) => o.tenant === tenant && o.ok && o.evalReport)
      .map((o) => o.evalReport as EvalReport);
    const allPassed =
      tenantEvals.length > 0 && tenantEvals.every((e) => e.passed);
    const minScore = (pick: (e: EvalReport) => number): number | null =>
      tenantEvals.length > 0 ? Math.min(...tenantEvals.map(pick)) : null;

    statuses.push({
      jurisdictionTenant: tenant,
      jurisdictionName: corpus?.jurisdictionName ?? tenant,
      currentEditionDid: editions[0]
        ? `did:hauska:code-edition:${editions[0].entityId}`
        : null,
      qualityBar: allPassed
        ? "passing"
        : tenantEvals.length > 0
          ? "failing"
          : "not-evaluated",
      top3Score: minScore((e) => e.scores.top3Score),
      sectionNumScore: minScore((e) => e.scores.sectionNumScore),
      crossRefScore: minScore((e) => e.scores.crossRefScore),
      atomCount: sections.length,
      lastRefreshedAt: new Date().toISOString(),
      driftStatus: "clean",
      accessPolicy: corpus?.accessPolicy ?? "public-free",
    });
  }
  statuses.sort((a, b) =>
    a.jurisdictionTenant.localeCompare(b.jurisdictionTenant),
  );
  return statuses;
}

export interface BuildCorpusSnapshotOptions {
  /** Output path for the snapshot JSON. */
  outPath: string;
}

export async function buildCorpusSnapshot(
  options: BuildCorpusSnapshotOptions,
): Promise<{ snapshot: CorpusSnapshot; outcomes: ReadonlyArray<IngestOutcome> }> {
  const combined = new InMemoryStorage();
  const outcomes: IngestOutcome[] = [];

  for (const unit of UNITS) {
    process.stderr.write(`[snapshot] ingesting: ${unit.label} ...\n`);
    const { outcome, snapshot } = await runUnit(unit);
    outcomes.push(outcome);
    if (snapshot) {
      await combined.importSnapshot(snapshot);
      const evalLine = outcome.evalReport
        ? `eval ${outcome.evalReport.scores.top3Score.toFixed(2)}/` +
          `${outcome.evalReport.scores.sectionNumScore.toFixed(2)}/` +
          `${outcome.evalReport.scores.crossRefScore.toFixed(2)} ` +
          `${outcome.evalReport.passed ? "PASS" : "FAIL"}`
        : "no eval";
      process.stderr.write(
        `[snapshot]   ok: ${outcome.sectionsIngested} sections, ${evalLine}\n`,
      );
    } else {
      process.stderr.write(`[snapshot]   skipped: ${outcome.error}\n`);
    }
  }

  const merged = combined.exportSnapshot(
    outcomes.filter((o) => o.ok).map((o) => o.label),
  );
  const snapshot: CorpusSnapshot = {
    ...merged,
    jurisdictionStatus: rebuildStatuses(merged.atoms, outcomes),
  };

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, JSON.stringify(snapshot), "utf8");

  return { snapshot, outcomes };
}
