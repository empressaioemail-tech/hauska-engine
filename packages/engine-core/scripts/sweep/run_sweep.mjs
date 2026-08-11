/**
 * Parcel-node county sweep runner — dry then apply, halt on mismatch.
 * Operator-authorized 2026-08-09. Reads sizing.json queue (store-truth, smallest-first).
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { stripBom, buildQueue } from "./run-sweep-lib.mjs";

function parseArgs(argv) {
  const config = {
    outDir: null,
    enginePath: null,
    cliScript: "write-parcel-node-county",
  };
  for (const a of argv) {
    if (a.startsWith("--out-dir=")) config.outDir = a.slice("--out-dir=".length);
    else if (a.startsWith("--engine-path=")) config.enginePath = a.slice("--engine-path=".length);
    else if (a.startsWith("--cli-script=")) config.cliScript = a.slice("--cli-script=".length);
  }
  return config;
}

const config = parseArgs(process.argv.slice(2));
if (!config.outDir || !config.enginePath) {
  console.error(
    "Usage: node run_sweep.mjs --out-dir=PATH --engine-path=PATH [--cli-script=write-parcel-node-county]",
  );
  process.exit(1);
}

const OUT_DIR = config.outDir;
const ENGINE = config.enginePath;
const CLI_SCRIPT = config.cliScript;

const SIZING = JSON.parse(readFileSync(`${OUT_DIR}/sizing.json`, "utf8"));
const MANIFEST_URL = "https://cortex-api-tds7av26va-uc.a.run.app/api/county-ledger";

// Load .env into process.env
for (const line of readFileSync(`${OUT_DIR}/.env`, "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
process.env.PARCEL_NODE_PATH = "1";

const progressPath = `${OUT_DIR}/progress.json`;
const logPath = `${OUT_DIR}/runner.log`;
const reportRows = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
}

function loadProgress() {
  if (existsSync(progressPath)) {
    const raw = readFileSync(progressPath, "utf8");
    return JSON.parse(stripBom(raw));
  }
  return {
    startedAt: new Date().toISOString(),
    landed: [],
    failed: [],
    econnresets: [],
    attempted: [],
    halted: null,
    checkpoints: [],
  };
}

function saveProgress(p) {
  p.updatedAt = new Date().toISOString();
  writeFileSync(progressPath, JSON.stringify(p, null, 2));
}

function runCli(county, apply, outFile) {
  return new Promise((resolve) => {
    const args = [
      "--filter",
      "@hauska-engine/engine-core",
      "run",
      CLI_SCRIPT,
      "--",
      `--county=${county}`,
      `--out=${outFile}`,
      // Verify cost is ~CONSTANT per batch: the write-then-verify SELECT
      // seq-scans all ~10.7M atoms regardless of how many ids it carries
      // (measured 2026-08-10: 9.13 s for 500 ids, 9.30 s for 5000). A bigger
      // batch amortizes that fixed cost across 10x more atoms -- 55 -> 538
      // atoms/sec. The index cannot help: 500 scattered keys against a 3.7M-row
      // partition never beats a scan, and forcing it measured WORSE (39/sec).
      "--batch=5000",
    ];
    if (apply) args.push("--apply");

    const child = spawn("pnpm", args, {
      cwd: ENGINE,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isEconnReset(result, summary) {
  const blob = `${result.stderr}\n${result.stdout}\n${summary?.error || ""}`;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|socket hang up/i.test(blob);
}

async function fetchManifestSummary() {
  // Node on this host fails leaf verification on the Run URL; curl uses the system CA store.
  const bodyText = await new Promise((resolve, reject) => {
    const child = spawn(
      "curl.exe",
      ["-sS", "--max-time", "60", MANIFEST_URL],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`curl exit ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
  const body = JSON.parse(bodyText);
  return {
    at: new Date().toISOString(),
    texasCompletenessPct: body.summary?.texasCompletenessPct,
    satisfiedCells: body.summary?.satisfiedCells,
    onboardedCount: body.summary?.onboardedCount,
    totalCells: body.summary?.totalCells,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const progress = loadProgress();
  const queue = buildQueue(SIZING.queueSmallestFirst, progress);

  log(
    `SIZING geometry=${SIZING.geometryCounties} atoms=${SIZING.atomCounties} delta=${SIZING.deltaCount} queueRemaining=${queue.length}`,
  );

  const baseline = await fetchManifestSummary();
  progress.manifestBaseline = baseline;
  saveProgress(progress);
  log(`MANIFEST baseline texasCompletenessPct=${baseline.texasCompletenessPct} satisfied=${baseline.satisfiedCells}`);

  let landedThisSession = 0;

  for (const entry of queue) {
    const fips = entry.countyFips;
    const dryOut = `${OUT_DIR}/${fips}_dry.json`;
    const applyOut = `${OUT_DIR}/${fips}_apply.json`;

    log(`=== COUNTY ${fips} features=${entry.features} rows=${entry.rows} ===`);
    progress.attempted.push({ countyFips: fips, at: new Date().toISOString() });
    saveProgress(progress);

    // DRY (retry transient spawn/pnpm filter misses — not data defects)
    let dryRun = null;
    let dryMs = 0;
    for (let dryAttempt = 1; dryAttempt <= 3; dryAttempt++) {
      const tDry0 = performance.now();
      dryRun = await runCli(fips, false, dryOut);
      dryMs = Math.round(performance.now() - tDry0);
      const spawnMiss =
        new RegExp(`None of the selected packages has a "${CLI_SCRIPT}" script`, "i").test(
          `${dryRun.stdout}\n${dryRun.stderr}`,
        ) ||
        (dryRun.code === 0 && !existsSync(dryOut) && dryMs < 5000);
      if (dryRun.code === 0 && existsSync(dryOut)) break;
      if (spawnMiss && dryAttempt < 3) {
        progress.transients = progress.transients || [];
        progress.transients.push({
          at: new Date().toISOString(),
          countyFips: fips,
          kind: "pnpm-or-spawn-miss",
          dryAttempt,
          exitCode: dryRun.code,
          wallMs: dryMs,
        });
        saveProgress(progress);
        log(`TRANSIENT dry spawn miss ${fips} attempt=${dryAttempt}; retrying`);
        await new Promise((r) => setTimeout(r, 2000 * dryAttempt));
        continue;
      }
      const finding = {
        countyFips: fips,
        stage: "dry",
        exitCode: dryRun.code,
        wallMs: dryMs,
        dryAttempt,
        error: (dryRun.stderr || dryRun.stdout || "").slice(-2000),
      };
      progress.failed.push(finding);
      progress.halted = { ...finding, reason: "dry-run-failed" };
      saveProgress(progress);
      log(`HALT dry failed ${fips}`);
      process.exit(2);
    }

    const dry = readJson(dryOut);
    const atomsBuilt = dry.atomsBuilt;
    const features = dry.plan?.distinctFeatures ?? entry.features;
    const rows = dry.storeTruth?.rows ?? entry.rows;

    // DEDUP TRIPWIRE: atoms must track features, not rows
    if (atomsBuilt > features * 1.05) {
      const finding = {
        countyFips: fips,
        stage: "dedup-tripwire",
        atomsBuilt,
        features,
        rows,
        reason: "dry atomsBuilt near/above features*1.05 — likely not de-duplicating",
      };
      progress.halted = finding;
      saveProgress(progress);
      log(`HALT DEDUP TRIPWIRE ${JSON.stringify(finding)}`);
      process.exit(3);
    }
    // Also flag if atoms ~ rows (seam-inflated) when seam factor > 1.1
    if (rows > features * 1.1 && atomsBuilt > features * 0.98 && Math.abs(atomsBuilt - rows) < rows * 0.05) {
      const finding = {
        countyFips: fips,
        stage: "dedup-tripwire",
        atomsBuilt,
        features,
        rows,
        reason: "dry predicts near ROW count rather than FEATURE count",
      };
      progress.halted = finding;
      saveProgress(progress);
      log(`HALT DEDUP TRIPWIRE ${JSON.stringify(finding)}`);
      process.exit(3);
    }

    log(
      `DRY ${fips}: atomsBuilt=${atomsBuilt} features=${features} rows=${rows} resolved=${dry.plan?.wouldWriteResolved} absent=${dry.plan?.wouldWriteAbsent} orphans=${dry.reconcile?.orphans ?? dry.reconcile?.retireAtomsBuilt ?? "?"} wall=${dryMs}ms`,
    );

    // APPLY (with up to 2 ECONNRESET re-runs of the same county)
    let applyAttempt = 0;
    let applySummary = null;
    let applyResult = null;
    const maxEconnRetries = 2;

    while (true) {
      applyAttempt += 1;
      const t0 = performance.now();
      applyResult = await runCli(fips, true, applyOut);
      const wallMs = Math.round(performance.now() - t0);

      if (existsSync(applyOut)) {
        try {
          applySummary = readJson(applyOut);
        } catch {
          applySummary = null;
        }
      }

      if (applyResult.code === 0 && applySummary) {
        const written = applySummary.atomsWritten;
        const verified = applySummary.verified;
        const orphanOk = applySummary.orphanVerdict?.ok === true || applySummary.orphansRetired === 0;

        if (written !== atomsBuilt || verified !== atomsBuilt) {
          const finding = {
            countyFips: fips,
            stage: "dry-apply-mismatch",
            atomsBuilt,
            atomsWritten: written,
            verified,
            wallMs,
            applyAttempt,
          };
          progress.halted = finding;
          progress.failed.push(finding);
          saveProgress(progress);
          log(`HALT dry/apply mismatch ${JSON.stringify(finding)}`);
          process.exit(4);
        }

        if (applySummary.verifyFailures?.length > 0) {
          const finding = {
            countyFips: fips,
            stage: "verify-failures",
            count: applySummary.verifyFailures.length,
            first: applySummary.verifyFailures[0],
          };
          progress.halted = finding;
          saveProgress(progress);
          log(`HALT verify failures ${JSON.stringify(finding)}`);
          process.exit(5);
        }

        if (applySummary.orphanVerdict && applySummary.orphanVerdict.ok !== true) {
          const finding = {
            countyFips: fips,
            stage: "orphan-verdict",
            verdict: applySummary.orphanVerdict,
          };
          progress.halted = finding;
          saveProgress(progress);
          log(`HALT orphan verdict ${JSON.stringify(finding)}`);
          process.exit(6);
        }

        const row = {
          countyFips: fips,
          features,
          rows,
          atomsBuilt,
          atomsWritten: written,
          verified,
          resolved: dry.plan?.wouldWriteResolved,
          absent: dry.plan?.wouldWriteAbsent,
          absentByKind: dry.plan?.wouldWriteAbsentByKind,
          orphansRetired: applySummary.orphansRetired ?? 0,
          dryWallMs: dryMs,
          applyWallMs: wallMs,
          applyAttempts: applyAttempt,
          landedAt: new Date().toISOString(),
        };
        progress.landed.push(row);
        reportRows.push(row);
        landedThisSession += 1;
        saveProgress(progress);
        writeFileSync(`${OUT_DIR}/landed_${fips}.json`, JSON.stringify(row, null, 2));
        log(`LANDED ${fips}: written=${written} verified=${verified} orphansRetired=${row.orphansRetired} wall=${wallMs}ms attempts=${applyAttempt}`);
        break;
      }

      // Failure path
      if (isEconnReset(applyResult, applySummary)) {
        const writtenSoFar = applySummary?.atomsWritten ?? null;
        const efind = {
          countyFips: fips,
          stage: "econnreset",
          applyAttempt,
          atomsWrittenBeforeDrop: writtenSoFar,
          atomsBuilt,
          wallMs,
          at: new Date().toISOString(),
          errorTail: (applySummary?.error || applyResult.stderr || "").slice(-800),
        };
        progress.econnresets.push(efind);
        saveProgress(progress);
        log(`ECONNRESET ${fips} attempt=${applyAttempt} writtenSoFar=${writtenSoFar}/${atomsBuilt} — will re-run (idempotent)`);

        if (applyAttempt > maxEconnRetries + 1) {
          progress.halted = { ...efind, reason: "econnreset-retries-exhausted" };
          progress.failed.push(efind);
          saveProgress(progress);
          log(`HALT econnreset retries exhausted on ${fips}`);
          process.exit(7);
        }
        continue;
      }

      // Non-ECONNRESET failure → HALT
      const finding = {
        countyFips: fips,
        stage: "apply-failed",
        exitCode: applyResult.code,
        atomsBuilt,
        atomsWritten: applySummary?.atomsWritten ?? null,
        wallMs,
        error: (applySummary?.error || applyResult.stderr || "").slice(-1500),
      };
      progress.failed.push(finding);
      progress.halted = finding;
      saveProgress(progress);
      log(`HALT apply failed ${JSON.stringify(finding)}`);
      process.exit(8);
    }

    // Checkpoint every 10 counties landed this session
    if (landedThisSession % 10 === 0) {
      try {
        const snap = await fetchManifestSummary();
        progress.checkpoints.push({ afterLandedSession: landedThisSession, ...snap });
        saveProgress(progress);
        writeFileSync(
          `${OUT_DIR}/manifest_checkpoint_${landedThisSession}.json`,
          JSON.stringify(snap, null, 2),
        );
        log(
          `CHECKPOINT after ${landedThisSession} this-session: texasCompletenessPct=${snap.texasCompletenessPct} satisfied=${snap.satisfiedCells}`,
        );
      } catch (e) {
        log(`CHECKPOINT fetch failed: ${e}`);
      }
    }
  }

  const finalManifest = await fetchManifestSummary();
  progress.manifestFinal = finalManifest;
  progress.completedAt = new Date().toISOString();
  saveProgress(progress);
  log(`QUEUE COMPLETE thisSession=${landedThisSession} totalLanded=${progress.landed.length}`);
  log(`MANIFEST final texasCompletenessPct=${finalManifest.texasCompletenessPct}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
