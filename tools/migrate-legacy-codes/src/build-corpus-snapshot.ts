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
  buildAnthonyCuratedQueries,
  ANTHONY_CHAPTER_FILTER,
  ANTHONY_CLIENT_ID,
  ANTHONY_EDITION_LABEL,
  ANTHONY_JURISDICTION,
  ANTHONY_JURISDICTION_NAME,
  ANTHONY_LIBRARY_SLUG,
} from "./anthony-curated-queries.js";

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
    tenant: TAYLOR_LDC_JURISDICTION,
    label: "Taylor Land Development Code (Path PDF / chapter-decimal)",
    async run(storage) {
      await runPathPdfIngest({
        storage,
        jurisdictionTenant: TAYLOR_LDC_JURISDICTION,
        jurisdictionName: TAYLOR_LDC_JURISDICTION_NAME,
        editionLabel: TAYLOR_LDC_EDITION_LABEL,
        pdfUrl: TAYLOR_LDC_PDF_URL,
        accessPolicy: "platform-internal",
        capabilitiesName: "taylor-ldc-pdf",
        capabilitiesDisplayName: "Taylor LDC (PDF)",
        normalizeOptions: TAYLOR_LDC_NORMALIZE_OPTIONS,
      });
      return buildTaylorLdcCuratedQueries();
    },
  },
  {
    tenant: LEANDER_JURISDICTION,
    label: "Leander Subdivision + Zoning (Path C / Municode, disambiguated)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: LEANDER_JURISDICTION,
        jurisdictionName: LEANDER_JURISDICTION_NAME,
        editionLabel: LEANDER_EDITION_LABEL,
        clientId: LEANDER_CLIENT_ID,
        librarySlug: LEANDER_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(LEANDER_CHAPTER_FILTER, "i"),
        // Leander's Subdivision + Zoning exhibits fan out to ~550 leaf
        // TOC nodes; an 800 cap clears the truncation boundary so every
        // article's content ingests reliably (a 400 cap dropped the
        // tail articles intermittently).
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildLeanderCuratedQueries();
    },
  },
  {
    tenant: GEORGETOWN_UDC_JURISDICTION,
    label: "Georgetown Unified Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: GEORGETOWN_UDC_JURISDICTION,
        jurisdictionName: GEORGETOWN_UDC_JURISDICTION_NAME,
        editionLabel: GEORGETOWN_UDC_EDITION_LABEL,
        clientId: GEORGETOWN_UDC_CLIENT_ID,
        librarySlug: GEORGETOWN_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(GEORGETOWN_UDC_CHAPTER_FILTER, "i"),
        productNameFilter: new RegExp(GEORGETOWN_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: GEORGETOWN_UDC_LIBRARY_CODE_PATH,
        // Georgetown's UDC fans out to 16 chapters of multi-level
        // SECTION/Sec. units; an 800 cap clears the leaf count with
        // headroom (the per-parent fetch dedup keeps actual requests
        // well below it).
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildGeorgetownUdcCuratedQueries();
    },
  },
  {
    tenant: NEW_BRAUNFELS_JURISDICTION,
    label: "New Braunfels Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
        jurisdictionName: NEW_BRAUNFELS_JURISDICTION_NAME,
        editionLabel: NEW_BRAUNFELS_EDITION_LABEL,
        clientId: NEW_BRAUNFELS_CLIENT_ID,
        librarySlug: NEW_BRAUNFELS_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(NEW_BRAUNFELS_CHAPTER_FILTER, "i"),
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildNewBraunfelsCuratedQueries();
    },
  },
  {
    tenant: KILLEEN_JURISDICTION,
    label: "Killeen Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: KILLEEN_JURISDICTION,
        jurisdictionName: KILLEEN_JURISDICTION_NAME,
        editionLabel: KILLEEN_EDITION_LABEL,
        clientId: KILLEEN_CLIENT_ID,
        librarySlug: KILLEEN_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(KILLEEN_CHAPTER_FILTER, "i"),
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildKilleenCuratedQueries();
    },
  },
  {
    tenant: COPPERAS_COVE_JURISDICTION,
    label: "Copperas Cove Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: COPPERAS_COVE_JURISDICTION,
        jurisdictionName: COPPERAS_COVE_JURISDICTION_NAME,
        editionLabel: COPPERAS_COVE_EDITION_LABEL,
        clientId: COPPERAS_COVE_CLIENT_ID,
        librarySlug: COPPERAS_COVE_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(COPPERAS_COVE_CHAPTER_FILTER, "i"),
        maxLeafFetches: 400,
        accessPolicy: "platform-internal",
      });
      return buildCopperasCoveCuratedQueries();
    },
  },
{
    tenant: AUSTIN_LDC_JURISDICTION,
    label: "Austin Land Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: AUSTIN_LDC_JURISDICTION,
        jurisdictionName: AUSTIN_LDC_JURISDICTION_NAME,
        editionLabel: AUSTIN_LDC_EDITION_LABEL,
        clientId: AUSTIN_LDC_CLIENT_ID,
        librarySlug: AUSTIN_LDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(AUSTIN_LDC_CHAPTER_FILTER, "i"),
        productNameFilter: new RegExp(AUSTIN_LDC_PRODUCT_FILTER, "i"),
        libraryCodePath: AUSTIN_LDC_LIBRARY_CODE_PATH,
        maxLeafFetches: 8000,
        accessPolicy: "platform-internal",
      });
      return buildAustinLdcCuratedQueries();
    },
  },

  {
    tenant: MANOR_JURISDICTION,
    label: "Manor Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: MANOR_JURISDICTION,
        jurisdictionName: MANOR_JURISDICTION_NAME,
        editionLabel: MANOR_EDITION_LABEL,
        clientId: MANOR_CLIENT_ID,
        librarySlug: MANOR_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(MANOR_CHAPTER_FILTER, "i"),
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildManorCuratedQueries();
    },
  },

  {
    tenant: LOCKHART_JURISDICTION,
    label: "Lockhart Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: LOCKHART_JURISDICTION,
        jurisdictionName: LOCKHART_JURISDICTION_NAME,
        editionLabel: LOCKHART_EDITION_LABEL,
        clientId: LOCKHART_CLIENT_ID,
        librarySlug: LOCKHART_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(LOCKHART_CHAPTER_FILTER, "i"),
        maxLeafFetches: 400,
        accessPolicy: "platform-internal",
      });
      return buildLockhartCuratedQueries();
    },
  },

  {
    tenant: LAGO_VISTA_JURISDICTION,
    label: "Lago Vista Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: LAGO_VISTA_JURISDICTION,
        jurisdictionName: LAGO_VISTA_JURISDICTION_NAME,
        editionLabel: LAGO_VISTA_EDITION_LABEL,
        clientId: LAGO_VISTA_CLIENT_ID,
        librarySlug: LAGO_VISTA_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(LAGO_VISTA_CHAPTER_FILTER, "i"),
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildLagoVistaCuratedQueries();
    },
  },

  {
    tenant: DRIPPING_SPRINGS_JURISDICTION,
    label: "Dripping Springs Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: DRIPPING_SPRINGS_JURISDICTION,
        jurisdictionName: DRIPPING_SPRINGS_JURISDICTION_NAME,
        editionLabel: DRIPPING_SPRINGS_EDITION_LABEL,
        clientId: DRIPPING_SPRINGS_CLIENT_ID,
        librarySlug: DRIPPING_SPRINGS_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(DRIPPING_SPRINGS_CHAPTER_FILTER, "i"),
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildDrippingSpringsCuratedQueries();
    },
  },

  {
    tenant: WIMBERLEY_JURISDICTION,
    label: "Wimberley Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: WIMBERLEY_JURISDICTION,
        jurisdictionName: WIMBERLEY_JURISDICTION_NAME,
        editionLabel: WIMBERLEY_EDITION_LABEL,
        clientId: WIMBERLEY_CLIENT_ID,
        librarySlug: WIMBERLEY_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(WIMBERLEY_CHAPTER_FILTER, "i"),
        maxLeafFetches: 400,
        accessPolicy: "platform-internal",
      });
      return buildWimberleyCuratedQueries();
    },
  },

  {
    tenant: ROLLINGWOOD_JURISDICTION,
    label: "Rollingwood Land Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: ROLLINGWOOD_JURISDICTION,
        jurisdictionName: ROLLINGWOOD_JURISDICTION_NAME,
        editionLabel: ROLLINGWOOD_EDITION_LABEL,
        clientId: ROLLINGWOOD_CLIENT_ID,
        librarySlug: ROLLINGWOOD_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(ROLLINGWOOD_CHAPTER_FILTER, "i"),
        maxLeafFetches: 400,
        accessPolicy: "platform-internal",
      });
      return buildRollingwoodCuratedQueries();
    },
  },

  {
    tenant: SAN_ANTONIO_UDC_JURISDICTION,
    label: "San Antonio Unified Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: SAN_ANTONIO_UDC_JURISDICTION,
        jurisdictionName: SAN_ANTONIO_UDC_JURISDICTION_NAME,
        editionLabel: SAN_ANTONIO_UDC_EDITION_LABEL,
        clientId: SAN_ANTONIO_UDC_CLIENT_ID,
        librarySlug: SAN_ANTONIO_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(SAN_ANTONIO_UDC_CHAPTER_FILTER, "i"),
        productNameFilter: new RegExp(SAN_ANTONIO_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SAN_ANTONIO_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: 8000,
        accessPolicy: "platform-internal",
      });
      return buildSanAntonioUdcCuratedQueries();
    },
  },

  {
    tenant: BOERNE_UDC_JURISDICTION,
    label: "Boerne Unified Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: BOERNE_UDC_JURISDICTION,
        jurisdictionName: BOERNE_UDC_JURISDICTION_NAME,
        editionLabel: BOERNE_UDC_EDITION_LABEL,
        clientId: BOERNE_UDC_CLIENT_ID,
        librarySlug: BOERNE_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(BOERNE_UDC_CHAPTER_FILTER, "i"),
        productNameFilter: new RegExp(BOERNE_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: BOERNE_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: 800,
        accessPolicy: "platform-internal",
      });
      return buildBoerneUdcCuratedQueries();
    },
  },

  {
    tenant: BROWNSVILLE_JURISDICTION,
    label: "Brownsville Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: BROWNSVILLE_JURISDICTION,
        jurisdictionName: BROWNSVILLE_JURISDICTION_NAME,
        editionLabel: BROWNSVILLE_EDITION_LABEL,
        clientId: BROWNSVILLE_CLIENT_ID,
        librarySlug: BROWNSVILLE_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(BROWNSVILLE_CHAPTER_FILTER, "i"),
        maxLeafFetches: 2000,
        accessPolicy: "platform-internal",
      });
      return buildBrownsvilleCuratedQueries();
    },
  },

  {
    tenant: MISSION_JURISDICTION,
    label: "Mission Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: MISSION_JURISDICTION,
        jurisdictionName: MISSION_JURISDICTION_NAME,
        editionLabel: MISSION_EDITION_LABEL,
        clientId: MISSION_CLIENT_ID,
        librarySlug: MISSION_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(MISSION_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1500,
        accessPolicy: "platform-internal",
      });
      return buildMissionCuratedQueries();
    },
  },

  {
    tenant: SCHERTZ_UDC_JURISDICTION,
    label: "Schertz Unified Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: SCHERTZ_UDC_JURISDICTION,
        jurisdictionName: SCHERTZ_UDC_JURISDICTION_NAME,
        editionLabel: SCHERTZ_UDC_EDITION_LABEL,
        clientId: SCHERTZ_UDC_CLIENT_ID,
        librarySlug: SCHERTZ_UDC_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(SCHERTZ_UDC_CHAPTER_FILTER, "i"),
        productNameFilter: new RegExp(SCHERTZ_UDC_PRODUCT_FILTER, "i"),
        libraryCodePath: SCHERTZ_UDC_LIBRARY_CODE_PATH,
        maxLeafFetches: 2000,
        accessPolicy: "platform-internal",
      });
      return buildSchertzUdcCuratedQueries();
    },
  },

  {
    tenant: SAGINAW_JURISDICTION,
    label: "Saginaw Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: SAGINAW_JURISDICTION,
        jurisdictionName: SAGINAW_JURISDICTION_NAME,
        editionLabel: SAGINAW_EDITION_LABEL,
        clientId: SAGINAW_CLIENT_ID,
        librarySlug: SAGINAW_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(SAGINAW_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1500,
        accessPolicy: "platform-internal",
      });
      return buildSaginawCuratedQueries();
    },
  },

  {
    tenant: LIVE_OAK_JURISDICTION,
    label: "Live Oak Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: LIVE_OAK_JURISDICTION,
        jurisdictionName: LIVE_OAK_JURISDICTION_NAME,
        editionLabel: LIVE_OAK_EDITION_LABEL,
        clientId: LIVE_OAK_CLIENT_ID,
        librarySlug: LIVE_OAK_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(LIVE_OAK_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1000,
        accessPolicy: "platform-internal",
      });
      return buildLiveOakCuratedQueries();
    },
  },

  {
    tenant: KELLER_JURISDICTION,
    label: "Keller Unified Development Code (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: KELLER_JURISDICTION,
        jurisdictionName: KELLER_JURISDICTION_NAME,
        editionLabel: KELLER_EDITION_LABEL,
        clientId: KELLER_CLIENT_ID,
        librarySlug: KELLER_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(KELLER_CHAPTER_FILTER, "i"),
        maxLeafFetches: 2000,
        accessPolicy: "platform-internal",
      });
      return buildKellerCuratedQueries();
    },
  },

  {
    tenant: CROWLEY_JURISDICTION,
    label: "Crowley Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: CROWLEY_JURISDICTION,
        jurisdictionName: CROWLEY_JURISDICTION_NAME,
        editionLabel: CROWLEY_EDITION_LABEL,
        clientId: CROWLEY_CLIENT_ID,
        librarySlug: CROWLEY_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(CROWLEY_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1500,
        accessPolicy: "platform-internal",
      });
      return buildCrowleyCuratedQueries();
    },
  },

  {
    tenant: CONVERSE_JURISDICTION,
    label: "Converse Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: CONVERSE_JURISDICTION,
        jurisdictionName: CONVERSE_JURISDICTION_NAME,
        editionLabel: CONVERSE_EDITION_LABEL,
        clientId: CONVERSE_CLIENT_ID,
        librarySlug: CONVERSE_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(CONVERSE_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1500,
        accessPolicy: "platform-internal",
      });
      return buildConverseCuratedQueries();
    },
  },

  {
    tenant: ANTHONY_JURISDICTION,
    label: "Anthony municipal code development titles (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: ANTHONY_JURISDICTION,
        jurisdictionName: ANTHONY_JURISDICTION_NAME,
        editionLabel: ANTHONY_EDITION_LABEL,
        clientId: ANTHONY_CLIENT_ID,
        librarySlug: ANTHONY_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(ANTHONY_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1500,
        accessPolicy: "platform-internal",
      });
      return buildAnthonyCuratedQueries();
    },
  },

  {
    tenant: CEDAR_HILL_JURISDICTION,
    label: "Cedar Hill Development Regulations (Path C / Municode)",
    async run(storage) {
      await runPathCIngest({
        storage,
        jurisdictionTenant: CEDAR_HILL_JURISDICTION,
        jurisdictionName: CEDAR_HILL_JURISDICTION_NAME,
        editionLabel: CEDAR_HILL_EDITION_LABEL,
        clientId: CEDAR_HILL_CLIENT_ID,
        librarySlug: CEDAR_HILL_LIBRARY_SLUG,
        stateAbbr: "TX",
        chapterFilter: new RegExp(CEDAR_HILL_CHAPTER_FILTER, "i"),
        maxLeafFetches: 1200,
        accessPolicy: "platform-internal",
      });
      return buildCedarHillCuratedQueries();
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
