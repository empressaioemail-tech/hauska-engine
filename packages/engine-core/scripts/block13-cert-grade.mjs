#!/usr/bin/env node
/**
 * Bastrop mechanical cert grade — THE proven Block-13 harness, generalized by roster.
 *
 * Default (--roster-from=block13): grades the frozen 7-parcel Block-13 regression 7/7.
 * Query (--roster-from=query --district-prefix=SF-1): dominant-district roster (R26),
 * per-parcel layer-23 answer key, same 4 gates. Honest-decline = PASS-or-decline.
 *
 * READ-ONLY. Exits non-zero if any roster parcel fails (promoted must pass all gates).
 *
 *   # Block-13 regression (must stay 7/7):
 *   DATABASE_URL=... CORTEX_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/block13-cert-grade.mjs
 *
 *   # District block sweep (dominant-district cohort):
 *   ... exec tsx scripts/block13-cert-grade.mjs --roster-from=query --district-prefix=SF-1
 */
import fs from "node:fs";
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import elginDescriptor from "../src/property-reasoning/fixtures/descriptors/elgin_tx_descriptor.json" with { type: "json" };
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import {
  loadDominantDistrictRoster,
  BLOCK13_QUARANTINE,
} from "./bastrop-dominant-district-roster.mjs";
import {
  runOnboardPreflight,
  deriveScopeAnnotations,
} from "../src/registry/onboard-preflight.ts";
import { loadJurisdictionRegistryRowById } from "../src/registry/jurisdiction-registry.ts";
import { buildOnboardPreflightDeps } from "../src/registry/preflight-probes.ts";
// Script depends on src — never the reverse. gradeOneParcelInQueryMode and
// gradeBlock13Parcel are the reusable per-parcel grading machinery; they
// live in src/registry/cert-grade-core.ts precisely so other src/ modules
// (e.g. the OPS-8 pre-flight geometry-parity probe) can import them without
// dragging this CLI script's own top-level side effects (arg parsing, DB
// connection setup) into their module graph.
import {
  gradeOneParcelInQueryMode,
  gradeBlock13Parcel,
  gradeUnzonedParcel,
  BLOCK13_ROSTER as BLOCK13,
} from "../src/registry/cert-grade-core.ts";

const COUNTY = "48021";

function parseArgs(argv) {
  const out = {
    rosterFrom: "block13",
    districtPrefix: null,
    rosterFile: null,
    // SCOPE 3 (cert-with-scope-annotation): optional rowId to look up a
    // pre-flight row report for. Absent by default — the existing Bastrop
    // full-coverage invocation never sets this, so scopeAnnotations stays
    // empty/absent and the report is byte-identical to before.
    preflightRowId: null,
    // --grade-mode=unzoned routes every roster parcel through
    // gradeUnzonedParcel instead of the query-mode/block13 graders. Default
    // "" leaves every existing invocation (block13 + query + file rosters)
    // byte-identical — this flag is additive and off by default.
    gradeMode: "",
    // --answer-key=descriptor uses descriptor setback table (Elgin path);
    // absent or layer23 keeps Bastrop layer-23 answer key (byte-identical default).
    answerKey: null,
    descriptorKey: null,
    descriptorFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--roster-from") out.rosterFrom = String(argv[++i] || "block13").trim();
    else if (a.startsWith("--roster-from=")) out.rosterFrom = a.slice("--roster-from=".length).trim();
    else if (a === "--district-prefix") out.districtPrefix = String(argv[++i] || "").trim();
    else if (a.startsWith("--district-prefix=")) {
      out.districtPrefix = a.slice("--district-prefix=".length).trim();
    } else if (a === "--roster-file") out.rosterFile = String(argv[++i] || "").trim();
    else if (a.startsWith("--roster-file=")) out.rosterFile = a.slice("--roster-file=".length).trim();
    else if (a === "--preflight-row-id") out.preflightRowId = String(argv[++i] || "").trim();
    else if (a.startsWith("--preflight-row-id=")) {
      out.preflightRowId = a.slice("--preflight-row-id=".length).trim();
    } else if (a === "--grade-mode") out.gradeMode = String(argv[++i] || "").trim();
    else if (a.startsWith("--grade-mode=")) out.gradeMode = a.slice("--grade-mode=".length).trim();
    else if (a === "--answer-key") out.answerKey = String(argv[++i] || "").trim();
    else if (a.startsWith("--answer-key=")) out.answerKey = a.slice("--answer-key=".length).trim();
    else if (a === "--descriptor") out.descriptorKey = String(argv[++i] || "").trim();
    else if (a.startsWith("--descriptor=")) out.descriptorKey = a.slice("--descriptor=".length).trim();
    else if (a === "--descriptor-file") out.descriptorFile = String(argv[++i] || "").trim();
    else if (a.startsWith("--descriptor-file=")) {
      out.descriptorFile = a.slice("--descriptor-file=".length).trim();
    }
  }
  return out;
}

function resolveCertDescriptor(args) {
  if (args.answerKey !== "descriptor") {
    return {
      ...bastropDescriptor,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
    };
  }
  if (args.descriptorFile) {
    return JSON.parse(fs.readFileSync(args.descriptorFile, "utf8"));
  }
  if (args.descriptorKey === "elgin_tx") {
    return elginDescriptor;
  }
  throw new Error(
    "--answer-key=descriptor requires --descriptor=elgin_tx or --descriptor-file=...",
  );
}

async function loadRoster(args) {
  if (args.rosterFrom === "block13") {
    return { parcelNodeIds: BLOCK13, mode: "block13", source: "BLOCK13 constant" };
  }
  if (args.rosterFrom === "file") {
    if (!args.rosterFile) throw new Error("--roster-file required for --roster-from=file");
    const raw = fs.readFileSync(args.rosterFile, "utf8");
    const ids = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return { parcelNodeIds: ids, mode: "query", source: `file:${args.rosterFile}` };
  }
  if (args.rosterFrom === "query") {
    if (!args.districtPrefix) throw new Error("--district-prefix required for --roster-from=query");
    const loaded = await loadDominantDistrictRoster(args.districtPrefix);
    return {
      parcelNodeIds: loaded.parcelNodeIds,
      mode: "query",
      source: `dominant-district:${args.districtPrefix} (${loaded.source})`,
      districtPrefix: args.districtPrefix,
    };
  }
  throw new Error(`Unknown --roster-from=${args.rosterFrom}`);
}

const args = parseArgs(process.argv.slice(2));
const rosterLoad = await loadRoster(args);

const url = resolveSubstrateDatabaseUrl();
const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  url;
if (!url) {
  console.error("FATAL: DATABASE_URL (atoms) required");
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", max: 4, prepare: false });
const txSql = postgres(txgioUrl, { ssl: "require", max: 4, prepare: false });
const storage = createPgStorage({ databaseUrl: url, maxConnections: 2 });

const roadRows = await sql`
  SELECT body FROM atoms WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY}
    AND coalesce(body->>'status', 'active') = 'active'
`;
const roads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

const descriptor = resolveCertDescriptor(args);
const answerKeyMode = args.answerKey === "descriptor" ? "descriptor" : "layer23";

// SCOPE 3 (cert-with-scope-annotation, operator-ruled 2026-08-03): when the
// caller names a pre-flight row (--preflight-row-id), attach scopeAnnotations
// derived from that row's declined CORE rails. Absent by default — the
// existing Bastrop full-coverage invocation never sets --preflight-row-id,
// so the report carries no scopeAnnotations key at all (byte-identical to
// before this change).
//
// S4 fix: the internal preflight call used to pass an EMPTY deps object
// ({}), so every probe-backed check (1/2/4/5/6/7/8) declined "not runnable:
// <probe> not configured" regardless of whether the source/DB/retrieval-api
// was actually reachable — spurious not-runnable scopeAnnotations (the
// county 20/20 cert carries one such artifact). Now wires the SAME probe
// builders the standalone onboard-preflight.mjs CLI wires
// (buildOnboardPreflightDeps, src/registry/preflight-probes.ts), reusing sql
// / txSql / storage already open in this script for the roster grade run.
// Env-gated identically to the CLI: RETRIEVAL_API_URL / RETRIEVAL_API_KEY
// absent (this script never required them) means check 6 still honestly
// declines not-runnable, same as before — no behavior change without env.
let scopeAnnotations;
if (args.preflightRowId) {
  const rowForFips = loadJurisdictionRegistryRowById(args.preflightRowId);
  if (rowForFips) {
    const preflightDeps = buildOnboardPreflightDeps({
      sql,
      txSql,
      storage: storage.storage,
      descriptor,
      retrievalApiUrl: process.env.RETRIEVAL_API_URL?.trim() || null,
      retrievalApiKey: process.env.RETRIEVAL_API_KEY?.trim() || null,
      gradeOneParcel: gradeOneParcelInQueryMode,
      loadRoads: async (fips) => {
        const rows = await sql`
          SELECT body FROM atoms WHERE entity_type = 'road-node'
            AND body->>'countyFips' = ${fips}
            AND coalesce(body->>'status', 'active') = 'active'
        `;
        return rows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);
      },
    });
    const { report: preflightReport } = await runOnboardPreflight(rowForFips.fips, preflightDeps);
    const rowReport = preflightReport.rows.find((r) => r.rowId === args.preflightRowId);
    const annotations = deriveScopeAnnotations(rowReport);
    if (annotations.length > 0) scopeAnnotations = annotations;
  }
}

const report = {
  when: new Date().toISOString(),
  cert:
    args.gradeMode === "unzoned"
      ? `Unzoned-county cert grade (${rosterLoad.source})`
      : rosterLoad.mode === "block13"
        ? "BLOCK-13 CERT-RESTORE mechanical grade"
        : `Bastrop dominant-district mechanical grade (${rosterLoad.districtPrefix ?? "file"})`,
  rosterFrom: args.rosterFrom,
  rosterSource: rosterLoad.source,
  measurer: "R32 index-matched inward-normal (measurePerEdgeInsetForRings)",
  orientationGate: "fresh labelEdgesFromRoads front-edge road-name token-match (R33 normalization)",
  roadNodesLoaded: roads.length,
  rosterSize: rosterLoad.parcelNodeIds.length,
  parcels: {},
  score: { pass: 0, fail: 0, honestDecline: 0, staleResidue: 0, total: rosterLoad.parcelNodeIds.length },
  ...(scopeAnnotations ? { scopeAnnotations } : {}),
  // Additive — only present when --grade-mode is passed, so the default
  // invocation's report stays byte-identical to before this change.
  ...(args.gradeMode ? { gradeMode: args.gradeMode } : {}),
  ...(args.answerKey ? { answerKey: args.answerKey } : {}),
  ...(args.descriptorKey ? { descriptorKey: args.descriptorKey } : {}),
};

try {
  for (const parcelNodeId of rosterLoad.parcelNodeIds) {
    let parcelResult;

    if (args.gradeMode === "unzoned") {
      parcelResult = await gradeUnzonedParcel(parcelNodeId, { sql });
    } else if (rosterLoad.mode === "query") {
      parcelResult = await gradeOneParcelInQueryMode(parcelNodeId, {
        sql,
        txSql,
        storage: storage.storage,
        roads,
        descriptor,
        districtPrefix: rosterLoad.districtPrefix ?? null,
        answerKeyMode,
      });
    } else {
      parcelResult = await gradeBlock13Parcel(parcelNodeId, {
        sql,
        txSql,
        storage: storage.storage,
        roads,
        descriptor,
      });
    }

    report.parcels[parcelNodeId] = parcelResult;
    if (parcelResult.honestDecline) report.score.honestDecline++;
    if (parcelResult.error === "stale-residue") report.score.staleResidue++;
    if (parcelResult.pass) report.score.pass++;
    else report.score.fail++;
  }

  report.score.label = `${report.score.pass}/${report.score.total}`;
  report.blockPass = report.score.fail === 0 && report.score.total > 0;
  if (rosterLoad.mode === "block13") {
    report.certRestore =
      report.score.pass === report.score.total ? "7/7 — CERT-RESTORE ELIGIBLE" : "STOP — not 7/7";
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.blockPass) process.exitCode = 1;
} finally {
  await sql.end();
  await txSql.end();
}
