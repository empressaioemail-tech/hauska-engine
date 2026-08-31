#!/usr/bin/env node
/**
 * Snapshot (F11-WRITER implementer, 2026-08-31):
 *   Seat: property worktree, supervised by integration on P:/doc_repo.
 *   Repo: hauska-engine
 *   Worktree: P:/seat-worktrees/property/hauska-engine-f11-setback
 *   Branch: seat/property-ctx-f11-writer
 *   HEAD at spawn: 80fb906 (origin/main; PR #366 refuse road-class / placeholder unknown already merged)
 *   PLAN-ROW: F-11, F-02
 *
 * F-02 writer job. Cloud Run Job only. Cloud Run cannot override command,
 * so this file is the only job form. Selection is an allowlist keyed by
 * writer name. CAD_PARCEL_ROLL_PATH is a property of the selected writer,
 * not a constant. startRun is the Factory caller's job. No FACTORY_DATABASE_URL here.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  applyWriterPathEnv,
  requireWriterEnv,
  resolveWriterJob,
} from "./atoms-writer-allowlist.mjs";

export {
  COUNTY_REQUIRED,
  WRITER_ALLOWLIST,
  WRITER_NOT_ALLOWLISTED,
  WRITER_REQUIRED,
  applyWriterPathEnv,
  parseWriterJobFlags,
  refusePooler,
  requireCountyFips,
  requireWriterEnv,
  resolveWriterJob,
  resolveWriterSelection,
  writerJobRunScope,
} from "./atoms-writer-allowlist.mjs";

function printRefuse(err) {
  console.error(
    JSON.stringify({
      event: "atoms-writer.refused",
      code: err.code || err.message,
    }),
  );
}

async function main() {
  let resolved;
  try {
    resolved = resolveWriterJob(process.argv.slice(2), process.env);
  } catch (err) {
    printRefuse(err);
    process.exit(2);
  }

  const { writer, county, rest, runScope } = resolved;
  console.log(JSON.stringify({ event: "atoms-writer.run-scope", ...runScope }));

  const urls = requireWriterEnv(process.env);
  const childEnv = applyWriterPathEnv(
    {
      ...process.env,
      DATABASE_URL: urls.atomsUrl,
      SUBSTRATE_DATABASE_URL: urls.atomsUrl,
      CORTEX_DATABASE_URL: urls.sourceUrl,
    },
    writer,
  );

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const childArgs = [
    "--filter",
    "@hauska-engine/engine-core",
    "exec",
    "tsx",
    writer.script,
    "--",
    `--county=${county}`,
    ...rest,
  ];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", childArgs, {
      stdio: "inherit",
      env: childEnv,
      cwd: repoRoot,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "atoms-writer.error", code: err.code || err.message }));
    process.exit(1);
  });
}
