#!/usr/bin/env node
/**
 * preflight-and-report, thin wrapper around the existing onboard-preflight
 * CLI (scripts/onboard-preflight.mjs). OPS-9 S1.
 *
 * Spawns the existing script UNCHANGED and captures its stdout JSON, so
 * this wrapper never re-implements the pre-flight checks or their DB/env
 * wiring (onboard-preflight.ts / onboard-preflight.mjs are read-only
 * imports elsewhere in this repo and are not touched here). It then:
 *
 *   1. Prints the captured JSON exactly as onboard-preflight.mjs printed it
 *      (byte-identical stdout, this wrapper adds no stdout of its own on
 *      the success path).
 *   2. When LEDGER_INGEST_URL + LEDGER_INGEST_KEY are set, POSTs a
 *      contract-shaped ingest body (sourceKind "preflight") built from the
 *      captured report: a rowMirror snapshot per graded row, one ledger
 *      event per decline, and a gateSummary per row. Absent that env, the
 *      POST is skipped entirely and only a one-line stderr note is logged
 *     , stdout stays print-only, byte-identical to invoking
 *      onboard-preflight.mjs directly.
 *
 *   DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     LEDGER_INGEST_URL=... LEDGER_INGEST_KEY=... \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/preflight-and-report.mjs --fips=48021
 *
 * All flags after the wrapper's own are passed through unchanged to
 * onboard-preflight.mjs (so --fips=... works exactly as before).
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  buildLedgerIngestBody,
  countyNameForFips,
  postLedgerIngest,
  resolveLedgerIngestConfig,
} from "../src/registry/ledger-report-client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");
const TARGET_SCRIPT_ABSOLUTE = join(PACKAGE_DIR, "scripts", "onboard-preflight.mjs");

/**
 * Resolves tsx's CLI entry through normal Node module resolution from this
 * package (works identically under pnpm's symlinked node_modules on every
 * platform), so the target script can be run as
 * `process.execPath <tsxCli> <targetScript> ...args` with NO shell and NO
 * .cmd/.bat shim involved. This is what fixes the Windows spawn EINVAL below.
 */
const requireFromHere = createRequire(import.meta.url);
const TSX_CLI_PATH = requireFromHere.resolve("tsx/cli");

/** Drops a single leading bare "--" argv separator (e.g. from `pnpm run <script> -- --fips=48021`), never inner occurrences. Exported for the pinning test. */
export function stripLeadingArgSeparator(argv) {
  return argv.length > 0 && argv[0] === "--" ? argv.slice(1) : argv;
}

function parseFipsArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fips") return String(argv[i + 1] || "").trim();
    if (a.startsWith("--fips=")) return a.slice("--fips=".length).trim();
  }
  return null;
}

/**
 * Spawns the existing onboard-preflight.mjs directly via
 * `process.execPath <resolved tsx/cli> <script> ...args`, never through a
 * package-manager shim. Node >=20.12 on Windows rejects `spawn()`ing a
 * `.cmd`/`.bat` shim (e.g. `pnpm.cmd`) without `shell: true`
 * (https://nodejs.org/en/blog/vulnerability/february-2024-security-releases,
 * "Improper handling of ... Windows path"; the fix landed as a hardening
 * default that turns the old `pnpm.cmd` spawn into `Error: spawn EINVAL`).
 * Resolving tsx's own CLI entry and invoking it with the Node binary
 * sidesteps the shim question entirely, on every platform, no shell:true
 * needed. Captures stdout/stderr and the exit code; never throws for a
 * non-zero exit, onboard-preflight.mjs's own exit semantics are preserved
 * and reported, not swallowed.
 */
function runTargetScript(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [TSX_CLI_PATH, TARGET_SCRIPT_ABSOLUTE, ...args], {
      cwd: PACKAGE_DIR,
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolvePromise({ code: 1, stdout, stderr: stderr + String(err) }));
  });
}

/**
 * Builds the ledger-ingest events + gateSummary array from a captured
 * onboard-preflight report. Pure, no I/O, so it is unit-testable against
 * fixture JSON shaped like onboard-preflight.ts's PreflightReport /
 * PreflightLedgerEvent types, without spawning the real script.
 */
export function buildPreflightIngestPayload(captured) {
  const { report, ledgerEvents } = captured;
  const now = new Date().toISOString();
  const rowMirror = report.rows.map((row) => ({
    rowId: row.rowId,
    fips: report.fips,
    countyName: countyNameForFips(report.fips),
    status: row.railPlan.declines.length > 0 ? "pre-flight-pending" : "active",
    zoningRegime: "unknown", // not carried on PreflightRowReport; registry is the source of truth for this field.
  }));
  const events = ledgerEvents.map((e) => ({
    ts: e.ts,
    fips: e.fips,
    rowId: e.rowId,
    railOrCheck: e.railOrCheck,
    checkId: e.railOrCheck,
    declineReason: e.declineReason,
    defectClass: e.defectClass,
  }));
  // One gateSummary per row (contract carries a single gateSummary; when
  // multiple rows are graded for a fips, we POST one call per row so each
  // row's gate outcome is represented, see main() below).
  const gateSummaries = report.rows.map((row) => ({
    rowId: row.rowId,
    fips: report.fips,
    passCount: row.checks.filter((c) => c.outcome === "PASS").length,
    declineCount: row.checks.filter((c) => c.outcome === "DECLINE").length,
    checks: row.checks.map((c) => ({ id: c.id, outcome: c.outcome, reason: c.reason })),
  }));
  return { rowMirror, events, gateSummaries, generatedAt: now };
}

async function main() {
  const argv = stripLeadingArgSeparator(process.argv.slice(2));
  const fips = parseFipsArg(argv);

  const result = await runTargetScript(argv);
  // Print the target script's stdout exactly as it produced it, this is
  // the byte-identical print-only contract.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.code !== 0) {
    process.exitCode = result.code;
    return;
  }

  const ledgerConfig = resolveLedgerIngestConfig();
  if (!ledgerConfig) {
    console.error("preflight-and-report: LEDGER_INGEST_URL/LEDGER_INGEST_KEY not set, print-only, no ingest POST.");
    return;
  }

  let captured;
  try {
    captured = JSON.parse(result.stdout);
  } catch (err) {
    console.error(`preflight-and-report: could not parse onboard-preflight.mjs stdout as JSON, skipping ingest POST: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const { rowMirror, events, gateSummaries } = buildPreflightIngestPayload(captured);

  for (const gateSummary of gateSummaries) {
    const rowEvents = events.filter((e) => e.rowId === gateSummary.rowId);
    const rowMirrorForRow = rowMirror.filter((r) => r.rowId === gateSummary.rowId);
    const body = buildLedgerIngestBody({
      sourceKind: "preflight",
      rowMirror: rowMirrorForRow,
      events: rowEvents,
      gateSummary,
    });
    const postResult = await postLedgerIngest(ledgerConfig, body);
    if (!postResult.ok) {
      console.error(
        `preflight-and-report: ingest POST failed for row ${gateSummary.rowId} (status ${postResult.status}): ${postResult.detail ?? "unknown error"}`,
      );
    } else {
      console.error(`preflight-and-report: ingest POST ok for row ${gateSummary.rowId} (fips ${fips ?? "?"}).`);
    }
  }
}

// Only run when invoked directly (tsx scripts/preflight-and-report.mjs), not
// when imported (e.g. by scripts/__tests__/preflight-and-report.test.ts for
// its pure exports), otherwise importing this module for
// buildPreflightIngestPayload would run the top-level spawn/POST flow.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await main();
}
