#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DOWNTOWN_DRILL_MANIFEST_PROP_IDS } from "../src/boundary-primitive/fixtures/bastropDowntownDrill.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const batchScript = join(HERE, "depth-warm-bastrop-batch.mjs");
const dryRun = process.argv.includes("--dry-run");
const results = [];

for (const propId of DOWNTOWN_DRILL_MANIFEST_PROP_IDS) {
  const parcelNodeId = `48021:${propId}`;
  const args = [
    batchScript,
    "--parcel",
    parcelNodeId,
    "--force-repromote",
    ...(dryRun ? ["--dry-run"] : ["--promote"]),
  ];
  const run = spawnSync("pnpm", ["exec", "tsx", ...args], {
    cwd: join(HERE, ".."),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  const stdout = run.stdout ?? "";
  const jsonStart = stdout.lastIndexOf('{\n  "event": "R4-depth-cost.done"');
  let summary = null;
  if (jsonStart >= 0) {
    try {
      summary = JSON.parse(stdout.slice(jsonStart));
    } catch {
      summary = null;
    }
  }
  const row = {
    propId,
    parcelNodeId,
    exitCode: run.status,
    promoted: summary?.outcomes?.promoted ?? 0,
    verifyPass: summary?.outcomes?.verifyPass ?? 0,
    verifyFail: summary?.outcomes?.verifyFail ?? 0,
    declines: summary?.outcomes?.declines ?? null,
  };
  results.push(row);
  console.log(JSON.stringify({ event: "warm.parcel", ...row }));
}

const promoted = results.filter((r) => r.promoted > 0).length;
const verifyPass = results.filter((r) => r.verifyPass > 0).length;
const verifyFail = results.filter((r) => r.verifyFail > 0).length;
const declined = results.filter(
  (r) => r.promoted === 0 && r.verifyPass === 0 && r.verifyFail === 0,
);

console.log(
  JSON.stringify(
    {
      event: "warm.done",
      dryRun,
      manifestCount: results.length,
      promoted,
      verifyPass,
      verifyFail,
      declinedCount: declined.length,
      declined,
      failures: results.filter((r) => r.verifyFail > 0 || r.exitCode !== 0),
    },
    null,
    2,
  ),
);

process.exit(verifyFail > 0 || declined.length > 0 ? 1 : 0);
