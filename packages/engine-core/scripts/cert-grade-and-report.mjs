#!/usr/bin/env node
/**
 * cert-grade-and-report, thin wrapper around the existing block13-cert-grade
 * CLI (scripts/block13-cert-grade.mjs). OPS-9 S1.
 *
 * Spawns the existing script UNCHANGED and captures its stdout JSON, so this
 * wrapper never re-implements cert grading or its DB/env wiring
 * (block13-cert-grade.mjs / cert-grade-core.ts are read-only imports
 * elsewhere in this repo and are not touched here). It then:
 *
 *   1. Prints the captured JSON exactly as block13-cert-grade.mjs printed it
 *      (byte-identical stdout on the success path).
 *   2. When LEDGER_INGEST_URL + LEDGER_INGEST_KEY are set, POSTs THREE kinds
 *      of contract-shaped payload, built read-only from this repo's existing
 *      registry + roster modules:
 *        - sourceKind "cert-grade": a certSummary derived from the captured
 *          report (rowId resolved via --preflight-row-id if passed through,
 *          else falls back to the county-fips row lookup).
 *        - sourceKind "block13-quarantine" (once per run, gated on
 *          --with-quarantine): a rowMirror + parcel-level events, one event
 *          per parcelNodeId in BLOCK13_QUARANTINE (imported read-only from
 *          scripts/bastrop-dominant-district-roster.mjs), so the quarantined
 *          Block-13 parcels stay visible to the ledger even though the
 *          proven harness excludes them from grading by design.
 *   Absent LEDGER_INGEST_URL/LEDGER_INGEST_KEY, both POSTs are skipped -
 *   stdout stays print-only, byte-identical to invoking
 *   block13-cert-grade.mjs directly.
 *
 *   DATABASE_URL=... CORTEX_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     LEDGER_INGEST_URL=... LEDGER_INGEST_KEY=... \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/cert-grade-and-report.mjs \
 *       --preflight-row-id=Bastrop --with-quarantine
 *
 * All recognized block13-cert-grade.mjs flags (--roster-from, --district-prefix,
 * --roster-file, --preflight-row-id, --grade-mode, --answer-key, --descriptor,
 * --descriptor-file) are passed through unchanged. This wrapper's own flag
 * (--with-quarantine) is stripped before pass-through. Wrapper-only flags:
 * (--artifact-out) writes the captured cert JSON to a timestamped artifact
 * file (defaults to cert-artifact-<rowId>-<iso>.json in cwd when omitted
 * but ledger ingest runs — see main()).
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

import { loadJurisdictionRegistryRowById } from "../src/registry/jurisdiction-registry.ts";
// bastrop-dominant-district-roster.mjs is imported LAZILY (inside
// postQuarantine below), not at module top level: that module pulls in
// `postgres` behind a tagged-template call, which a static top-level import
// of this wrapper cannot survive under vitest's esbuild-based SSR transform
// (confirmed by isolated repro, the file is syntactically valid per `node
// --check` and loads fine under plain Node's dynamic import(), but fails
// specifically under vitest's transform when imported statically at the top
// of another module). Deferring the import keeps this wrapper's own runtime
// behavior byte-identical (BLOCK13_QUARANTINE is only ever needed inside
// postQuarantine, which already runs after an await) while keeping this file
// safely importable by scripts/__tests__/cert-grade-and-report.test.ts for
// its pure exports.
import {
  buildLedgerIngestBody,
  countyNameForFips,
  postLedgerIngest,
  resolveLedgerIngestConfig,
} from "../src/registry/ledger-report-client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");
const TARGET_SCRIPT_ABSOLUTE = join(PACKAGE_DIR, "scripts", "block13-cert-grade.mjs");
const COUNTY_FIPS = "48021"; // matches block13-cert-grade.mjs's own COUNTY constant, Bastrop-network only today.

/**
 * Resolves tsx's CLI entry through normal Node module resolution from this
 * package (works identically under pnpm's symlinked node_modules on every
 * platform), so the target script can be run as
 * `process.execPath <tsxCli> <targetScript> ...args` with NO shell and NO
 * .cmd/.bat shim involved. This is what fixes the Windows spawn EINVAL below.
 */
const requireFromHere = createRequire(import.meta.url);
const TSX_CLI_PATH = requireFromHere.resolve("tsx/cli");

/** Drops a single leading bare "--" argv separator (e.g. from `pnpm run <script> -- --preflight-row-id=Bastrop`), never inner occurrences. Exported for the pinning test. */
export function stripLeadingArgSeparator(argv) {
  return argv.length > 0 && argv[0] === "--" ? argv.slice(1) : argv;
}

/**
 * Extracts this wrapper's own row-identity attribution from argv, alongside
 * the unmodified passthrough array handed to block13-cert-grade.mjs.
 *
 * S4 addendum fix (2026-08-04): this used to only recognize
 * `--preflight-row-id=X` (the `=`-joined form) — the space-separated form
 * `--preflight-row-id X` fell into a no-op branch that never captured the
 * next argv token as the value, leaving `preflightRowId` null even though
 * BOTH tokens were still forwarded unchanged to block13-cert-grade.mjs
 * (which DOES parse the space-separated form correctly, so the underlying
 * grading ran against the right row). The wrapper's own certSummary.rowId
 * then silently fell back to the "Bastrop" default and clobbered the
 * previous city cert in county_gate_cert_state. Fixed by consuming the next
 * token (mirrors block13-cert-grade.mjs's and warden-sweep.mjs's own arg
 * parsing) for BOTH `--row-id` (new, explicit) and `--preflight-row-id`
 * (existing pass-through flag).
 *
 * Identity precedence (per the addendum): explicit `--row-id` first, then
 * `--preflight-row-id` (the flag every existing invocation already passes
 * through), then the legacy "Bastrop" default ONLY when neither is given —
 * so the original Bastrop-full-coverage invocation (which sets neither) is
 * unaffected.
 */
export function extractWrapperArgs(rawArgv) {
  const argv = stripLeadingArgSeparator(rawArgv);
  const passthrough = [];
  let withQuarantine = false;
  let preflightRowId = null;
  let explicitRowId = null;
  let artifactOut = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--with-quarantine") {
      withQuarantine = true;
      continue;
    }
    if (a.startsWith("--artifact-out=")) {
      artifactOut = a.slice("--artifact-out=".length).trim();
      continue;
    }
    if (a === "--artifact-out") {
      artifactOut = String(argv[++i] || "").trim();
      continue;
    }
    if (a.startsWith("--preflight-row-id=")) {
      preflightRowId = a.slice("--preflight-row-id=".length).trim();
    } else if (a === "--preflight-row-id") {
      preflightRowId = String(argv[i + 1] || "").trim();
      // value is the next argv element; still pass both through unchanged
      // (do not consume/skip it — block13-cert-grade.mjs parses it itself).
    } else if (a.startsWith("--row-id=")) {
      explicitRowId = a.slice("--row-id=".length).trim();
    } else if (a === "--row-id") {
      explicitRowId = String(argv[i + 1] || "").trim();
      // --row-id is THIS wrapper's own attribution-only flag (not a
      // block13-cert-grade.mjs flag) — still forwarded unchanged below since
      // an unrecognized flag on the target script is harmless passthrough,
      // consistent with how every other wrapper flag here behaves.
    }
    passthrough.push(a);
  }
  const rowId = explicitRowId || preflightRowId || "Bastrop";
  return { passthrough, withQuarantine, preflightRowId, explicitRowId, rowId, artifactOut };
}

/**
 * Spawns the existing block13-cert-grade.mjs directly via
 * `process.execPath <resolved tsx/cli> <script> ...args`, never through a
 * package-manager shim. Node >=20.12 on Windows rejects `spawn()`ing a
 * `.cmd`/`.bat` shim (e.g. `pnpm.cmd`) without `shell: true`
 * (https://nodejs.org/en/blog/vulnerability/february-2024-security-releases,
 * "Improper handling of ... Windows path"; the fix landed as a hardening
 * default that turns the old `pnpm.cmd` spawn into `Error: spawn EINVAL`).
 * Resolving tsx's own CLI entry and invoking it with the Node binary
 * sidesteps the shim question entirely, on every platform, no shell:true
 * needed. Never throws for a non-zero exit, the target script's own exit
 * semantics are preserved and reported.
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
 * Builds the certSummary ledger payload from a captured block13-cert-grade
 * report. Pure, no I/O, so it is unit-testable against fixture JSON shaped
 * like the report block13-cert-grade.mjs emits (report.score.label,
 * report.blockPass, report.scopeAnnotations).
 */
export function buildCertGradeIngestPayload(captured, { rowId, fips }) {
  const certSummary = {
    rowId,
    fips,
    label: captured?.score?.label ?? "unknown",
    blockPass: Boolean(captured?.blockPass),
    ...(captured?.scopeAnnotations ? { scopeAnnotations: captured.scopeAnnotations } : {}),
    gradedAt: captured?.when ?? new Date().toISOString(),
  };
  return { certSummary };
}

/**
 * Builds the block13-quarantine rowMirror + events payload. Pure, no I/O -
 * given the row and the quarantine parcel-id set (both passed in so tests
 * don't need to import the live constant).
 */
export function buildQuarantineIngestPayload(row, quarantineParcelIds, nowIso) {
  const rowMirror = row
    ? [
        {
          rowId: row.rowId,
          fips: row.fips,
          countyName: row.countyName,
          status: row.status,
          zoningRegime: row.zoningRegime,
        },
      ]
    : [];
  const events = [...quarantineParcelIds].sort().map((parcelNodeId) => ({
    ts: nowIso,
    fips: row?.fips ?? COUNTY_FIPS,
    rowId: row?.rowId ?? "Bastrop",
    parcelNodeId,
    defectClass: "BLOCK13-QUARANTINE",
    severity: "info",
  }));
  return { rowMirror, events };
}

async function postCertSummary(ledgerConfig, captured, rowId, fips) {
  const { certSummary } = buildCertGradeIngestPayload(captured, { rowId, fips });
  const body = buildLedgerIngestBody({ sourceKind: "cert-grade", events: [], certSummary });
  const result = await postLedgerIngest(ledgerConfig, body);
  if (!result.ok) {
    console.error(`cert-grade-and-report: cert-grade ingest POST failed (status ${result.status}): ${result.detail ?? "unknown error"}`);
  } else {
    console.error(`cert-grade-and-report: cert-grade ingest POST ok for row ${rowId ?? "?"}.`);
  }
}

async function postQuarantine(ledgerConfig, rowId) {
  const row = rowId ? loadJurisdictionRegistryRowById(rowId) : loadJurisdictionRegistryRowById("Bastrop");
  const nowIso = new Date().toISOString();
  const { BLOCK13_QUARANTINE } = await import("./bastrop-dominant-district-roster.mjs");
  const { rowMirror, events } = buildQuarantineIngestPayload(row, BLOCK13_QUARANTINE, nowIso);
  const body = buildLedgerIngestBody({ sourceKind: "block13-quarantine", rowMirror, events });
  const result = await postLedgerIngest(ledgerConfig, body);
  if (!result.ok) {
    console.error(`cert-grade-and-report: block13-quarantine ingest POST failed (status ${result.status}): ${result.detail ?? "unknown error"}`);
  } else {
    console.error(`cert-grade-and-report: block13-quarantine ingest POST ok (${events.length} parcel event(s)).`);
  }
}

async function main() {
  const { passthrough, withQuarantine, rowId, artifactOut } = extractWrapperArgs(process.argv.slice(2));

  const result = await runTargetScript(passthrough);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.code !== 0) {
    process.exitCode = result.code;
    return;
  }

  let captured;
  try {
    captured = JSON.parse(result.stdout);
  } catch (err) {
    console.error(`cert-grade-and-report: could not parse block13-cert-grade.mjs stdout as JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const artifactPath =
    artifactOut ||
    `cert-artifact-${String(rowId).replace(/\s+/g, "_")}-${(captured.when ?? new Date().toISOString()).replace(/[:.]/g, "-")}.json`;
  try {
    await writeFile(artifactPath, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
    console.error(`cert-grade-and-report: artifact written: ${artifactPath}`);
  } catch (err) {
    console.error(`cert-grade-and-report: failed to write artifact ${artifactPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ledgerConfig = resolveLedgerIngestConfig();
  if (!ledgerConfig) {
    console.error("cert-grade-and-report: LEDGER_INGEST_URL/LEDGER_INGEST_KEY not set, print-only, no ingest POST.");
    return;
  }

  const row = loadJurisdictionRegistryRowById(rowId);
  const fips = row?.fips ?? COUNTY_FIPS;

  await postCertSummary(ledgerConfig, captured, rowId, fips);

  if (withQuarantine) {
    await postQuarantine(ledgerConfig, rowId);
  }
}

// Only run when invoked directly (tsx scripts/cert-grade-and-report.mjs),
// not when imported (e.g. by scripts/__tests__/cert-grade-and-report.test.ts
// for its pure exports), otherwise importing this module for
// buildCertGradeIngestPayload/buildQuarantineIngestPayload would run the
// top-level spawn/POST flow.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await main();
}
