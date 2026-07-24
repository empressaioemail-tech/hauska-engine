#!/usr/bin/env node
/**
 * Sequential metro bake driver — all 10 Central-TX counties with geometry.
 * Continues on per-county failure; writes metro summary ledger.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = join(
  HERE,
  "../src/property-reasoning/fixtures/breadth-ledgers",
);

const COUNTIES = [
  "48055", // Caldwell smallest first
  "48021", // Bastrop
  "48091", // Comal
  "48209", // Hays
  "48187", // Guadalupe
  "48309", // McLennan
  "48027", // Bell
  "48491", // Williamson
  "48453", // Travis
  "48029", // Bexar largest last
];

function runCounty(fips) {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      [
        "--filter",
        "@hauska-engine/engine-core",
        "exec",
        "tsx",
        "scripts/bake-property-atom-county.mjs",
        `--county=${fips}`,
        "--batch=200",
      ],
      {
        cwd: join(HERE, "../../.."),
        env: process.env,
        shell: false,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on("close", (code) => resolve({ fips, code, stdout, stderr }));
  });
}

mkdirSync(LEDGER_DIR, { recursive: true });
const t0 = performance.now();
const results = [];

console.log(
  JSON.stringify({
    event: "breadth-metro-bake.start",
    counties: COUNTIES,
    geometryCeiling: "include-all-10",
  }),
);

for (const fips of COUNTIES) {
  console.log(JSON.stringify({ event: "breadth-metro-bake.county-start", fips }));
  const r = await runCounty(fips);
  results.push({
    fips,
    exitCode: r.code,
    ok: r.code === 0 || r.code === 2,
  });
  console.log(
    JSON.stringify({
      event: "breadth-metro-bake.county-done",
      fips,
      exitCode: r.code,
    }),
  );
}

const summary = {
  id: "breadth-metro-central-tx",
  bakedAt: new Date().toISOString(),
  geometryCeiling:
    "include-all-10 — live txgio_parcel geometry for Guadalupe/Bell/McLennan; kickoff gap premise corrected",
  wallMs: Math.round(performance.now() - t0),
  results,
};
writeFileSync(
  join(LEDGER_DIR, "metro-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ event: "breadth-metro-bake.done", summary }));
process.exit(results.every((r) => r.ok) ? 0 : 1);
