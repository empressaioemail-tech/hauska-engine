#!/usr/bin/env node
/**
 * F-02 stage runner writer half. Cloud Run Job only.
 * Requires RUN_ID from a Factory runs row. startRun is the caller's job.
 * Refuses a pooler host and any county except Bexar 48029 on apply.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function refusePooler(url, name) {
  if (!url || String(url).trim() === "") {
    const err = new Error(`missing required env: ${name}`);
    err.code = "MISSING_ENV";
    throw err;
  }
  const host = new URL(url).hostname;
  if (host.includes("-pooler")) {
    const err = new Error(`${name} is a pooler host (${host})`);
    err.code = "POOLER_HOST_REFUSED";
    throw err;
  }
  return host;
}

function parseArgs(argv) {
  const out = { county: process.env.COUNTY || "48029", runId: process.env.RUN_ID || null, apply: process.env.APPLY === "1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--run-id") out.runId = String(argv[++i] || "").trim();
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length).trim();
    else if (a === "--apply") out.apply = true;
  }
  return out;
}

export function requireWriterEnv(env = process.env) {
  const atomsUrl = env.SUBSTRATE_DATABASE_URL || env.DATABASE_URL || env.ATOMS_DATABASE_URL;
  const sourceUrl = env.CORTEX_DATABASE_URL || env.SOURCE_DATABASE_URL || env.TXGIO_DATABASE_URL;
  const atomsHost = refusePooler(atomsUrl, "DATABASE_URL");
  const sourceHost = refusePooler(sourceUrl, "CORTEX_DATABASE_URL");
  return { atomsUrl, sourceUrl, atomsHost, sourceHost };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId) {
    console.error(JSON.stringify({ event: "atoms-writer.refused", code: "LEASE_REQUIRED" }));
    process.exit(2);
  }
  if (args.apply && args.county !== "48029") {
    console.error(JSON.stringify({ event: "atoms-writer.refused", code: "OLD_SHAPE_FILL_FROZEN", county: args.county }));
    process.exit(2);
  }
  const urls = requireWriterEnv(process.env);
  const applyStart = new Date().toISOString();
  process.env.CAD_PARCEL_ROLL_PATH = "1";
  process.env.DATABASE_URL = urls.atomsUrl;
  process.env.SUBSTRATE_DATABASE_URL = urls.atomsUrl;
  process.env.CORTEX_DATABASE_URL = urls.sourceUrl;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const childArgs = [
    "--filter",
    "@hauska-engine/engine-core",
    "exec",
    "tsx",
    "scripts/write-cad-parcel-roll-county.mjs",
    "--",
    `--county=${args.county}`,
    `--run-id=${args.runId}`,
  ];
  if (args.apply) childArgs.push("--apply");

  const t0 = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", childArgs, {
      stdio: "inherit",
      env: process.env,
      cwd: repoRoot,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  const wallMs = Date.now() - t0;
  console.log(
    JSON.stringify({
      event: "atoms-writer.done",
      runId: args.runId,
      county: args.county,
      apply: args.apply,
      apply_start: applyStart,
      wall_ms: wallMs,
      atomsHost: urls.atomsHost,
      sourceHost: urls.sourceHost,
      exit: exitCode,
    }),
  );
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "atoms-writer.error", code: err.code || err.message }));
    process.exit(1);
  });
}
