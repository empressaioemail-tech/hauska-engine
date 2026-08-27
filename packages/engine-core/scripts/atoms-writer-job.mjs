#!/usr/bin/env node
/**
 * F-02 writer half. Cloud Run Job only.
 * Passes container args through to write-cad-parcel-roll-county.
 * startRun is the Factory caller's job. No FACTORY_DATABASE_URL here.
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

export function requireWriterEnv(env = process.env) {
  const atomsUrl = env.SUBSTRATE_DATABASE_URL || env.DATABASE_URL || env.ATOMS_DATABASE_URL;
  const sourceUrl = env.CORTEX_DATABASE_URL || env.SOURCE_DATABASE_URL || env.TXGIO_DATABASE_URL;
  const atomsHost = refusePooler(atomsUrl, "DATABASE_URL");
  const sourceHost = refusePooler(sourceUrl, "CORTEX_DATABASE_URL");
  return { atomsUrl, sourceUrl, atomsHost, sourceHost };
}

async function main() {
  const urls = requireWriterEnv(process.env);
  process.env.CAD_PARCEL_ROLL_PATH = "1";
  process.env.DATABASE_URL = urls.atomsUrl;
  process.env.SUBSTRATE_DATABASE_URL = urls.atomsUrl;
  process.env.CORTEX_DATABASE_URL = urls.sourceUrl;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const passthrough = process.argv.slice(2);
  const childArgs = [
    "--filter",
    "@hauska-engine/engine-core",
    "exec",
    "tsx",
    "scripts/write-cad-parcel-roll-county.mjs",
    "--",
    ...passthrough,
  ];

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
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "atoms-writer.error", code: err.code || err.message }));
    process.exit(1);
  });
}
