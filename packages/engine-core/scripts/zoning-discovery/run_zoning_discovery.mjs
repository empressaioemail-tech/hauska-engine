#!/usr/bin/env node
/**
 * Factory 1.5 L2 — catalogue-driven zoning layer discovery runner.
 *
 *   ZONING_DISCOVERY_PATH=1 \
 *     pnpm --filter @hauska-engine/engine-core run run-zoning-discovery -- \
 *       --out-dir=PATH --queue=PATH [--engine-path=PATH] [--stage-apply] [--city=cityKey]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  stripBom,
  buildQueue,
  RUNNER_VERSION,
  isLandedStatus,
} from "./run-zoning-discovery-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const config = {
    outDir: null,
    queue: null,
    enginePath: null,
    stageApply: false,
    city: null,
  };
  for (const a of argv) {
    if (a.startsWith("--out-dir=")) config.outDir = a.slice("--out-dir=".length);
    else if (a.startsWith("--queue=")) config.queue = a.slice("--queue=".length);
    else if (a.startsWith("--engine-path=")) config.enginePath = a.slice("--engine-path=".length);
    else if (a === "--stage-apply") config.stageApply = true;
    else if (a.startsWith("--city=")) config.city = a.slice("--city=".length).trim().toLowerCase();
  }
  return config;
}

const config = parseArgs(process.argv.slice(2));

if (process.env.ZONING_DISCOVERY_PATH !== "1") {
  console.error("FATAL: ZONING_DISCOVERY_PATH=1 required.");
  process.exit(1);
}

if (!config.outDir || !config.queue) {
  console.error(
    "Usage: run_zoning_discovery.mjs --out-dir=PATH --queue=PATH [--engine-path=PATH] [--stage-apply] [--city=cityKey]",
  );
  process.exit(1);
}

const OUT_DIR = config.outDir;
const progressPath = join(OUT_DIR, "progress.json");
const verdictsDir = join(OUT_DIR, "verdicts");

function loadProgress() {
  if (existsSync(progressPath)) {
    return JSON.parse(stripBom(readFileSync(progressPath, "utf8")));
  }
  return {
    startedAt: new Date().toISOString(),
    runnerVersion: RUNNER_VERSION,
    landed: [],
    attempted: [],
    halted: null,
  };
}

function saveProgress(p) {
  p.updatedAt = new Date().toISOString();
  p.runnerVersion = RUNNER_VERSION;
  writeFileSync(progressPath, JSON.stringify(p, null, 2));
}

function loadQueue() {
  const raw = readFileSync(config.queue, "utf8");
  const items = JSON.parse(stripBom(raw));
  if (!Array.isArray(items)) throw new Error("queue file must be a JSON array");
  return items;
}

function verificationFailure(item, verdict) {
  if (item.expectedStatus && verdict.status !== item.expectedStatus) {
    return `expected status ${item.expectedStatus}, got ${verdict.status}`;
  }
  if (item.expectedLayerUrl && verdict.layerUrl !== item.expectedLayerUrl) {
    return `expected layer ${item.expectedLayerUrl}, got ${verdict.layerUrl ?? "null"}`;
  }
  if (
    Array.isArray(item.expectedLayerUrls) &&
    item.expectedLayerUrls.length > 0 &&
    !item.expectedLayerUrls.includes(verdict.layerUrl)
  ) {
    return `expected one of ${item.expectedLayerUrls.join(" | ")}, got ${verdict.layerUrl ?? "null"}`;
  }
  if (
    Array.isArray(item.forbiddenLayerUrls) &&
    verdict.layerUrl &&
    item.forbiddenLayerUrls.includes(verdict.layerUrl)
  ) {
    return `selected forbidden layer ${verdict.layerUrl}`;
  }
  return null;
}

const CITY_BUDGET_MS = Number(process.env.ZONING_DISCOVERY_CITY_BUDGET_MS ?? 8 * 60_000);

function withCityBudget(promise, cityKey, budgetMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`city-budget-exceeded:${cityKey}:${budgetMs}ms`));
    }, budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(verdictsDir, { recursive: true });

  const { discoverZoningForCity } = await import("../../src/zoning-discovery/discover.ts");
  const { classifyDiscoveryEvidence } = await import("../../src/zoning-discovery/classify.ts");
  const { stageDiscoveredLayer } = await import("../../src/zoning-discovery/stage-discovered.ts");

  const progress = loadProgress();
  let inputQueue = loadQueue();
  if (config.city) {
    inputQueue = inputQueue.filter((item) => item.cityKey === config.city);
    if (inputQueue.length === 0) {
      console.error(`FATAL: --city=${config.city} not found in queue`);
      process.exit(1);
    }
  }

  const queue = buildQueue(inputQueue, progress);
  const runClose = {
    runnerVersion: RUNNER_VERSION,
    startedAt: new Date().toISOString(),
    queuePath: config.queue,
    outDir: OUT_DIR,
    stageApply: config.stageApply,
    cityBudgetMs: CITY_BUDGET_MS,
    verdicts: [],
  };

  for (const item of queue) {
    const t0 = performance.now();
    progress.attempted.push({ cityKey: item.cityKey, at: new Date().toISOString() });
    saveProgress(progress);

    let evidence;
    let verdict;
    let budgetExceeded = false;
    try {
      evidence = await withCityBudget(discoverZoningForCity(item), item.cityKey, CITY_BUDGET_MS);
      verdict = classifyDiscoveryEvidence(item, evidence);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!msg.startsWith("city-budget-exceeded:")) throw err;
      budgetExceeded = true;
      evidence = {
        cityKey: item.cityKey,
        searchPaths: [],
        layers: [],
        bestEuclidean: null,
        constraintLayers: [],
        emptySearch: true,
        allPathsTransportFailed: false,
        anyAuthBlocked: false,
      };
      verdict = {
        cityKey: item.cityKey,
        status: "NOT-FOUND-UNKNOWN-WHY",
        layerUrl: null,
        layer: null,
        searchPaths: [],
        classifiedAt: new Date().toISOString(),
        notes: [`city-budget-exceeded:${CITY_BUDGET_MS}ms`],
      };
    }

    const verdictPath = join(verdictsDir, `${item.cityKey}.json`);
    const verdictArtifact = {
      ...verdict,
      probedLayers: evidence.layers,
      searchPathCount: verdict.searchPaths.length,
      everySearchPath: verdict.searchPaths,
      elapsedMs: Math.round(performance.now() - t0),
      budgetExceeded,
    };
    writeFileSync(verdictPath, JSON.stringify(verdictArtifact, null, 2));

    const failedExpectation = verificationFailure(item, verdict);
    if (failedExpectation) {
      progress.halted = {
        cityKey: item.cityKey,
        reason: `verification-failed: ${failedExpectation}`,
        at: new Date().toISOString(),
        artifact: verdictPath,
      };
      saveProgress(progress);
      throw new Error(`${item.cityKey}: ${failedExpectation}`);
    }

    let stageReport = null;
    if (verdict.status === "LAYER-FOUND" && config.stageApply) {
      try {
        stageReport = await stageDiscoveredLayer(item, verdict, {
          apply: true,
          dryRun: false,
          probeEvidencePath: verdictPath,
        });
      } catch (err) {
        stageReport = {
          event: "zoning-discovery.stage-error",
          cityKey: item.cityKey,
          error: String(err?.message || err),
          applied: false,
        };
        console.error(JSON.stringify(stageReport));
        progress.halted = {
          cityKey: item.cityKey,
          reason: `stage-failed: ${stageReport.error}`,
          at: new Date().toISOString(),
          artifact: verdictPath,
        };
        saveProgress(progress);
        throw err;
      }
      if (!stageReport.applied || stageReport.featuresStaged < 1) {
        progress.halted = {
          cityKey: item.cityKey,
          reason: "stage-failed: LAYER-FOUND produced no applied staging rows",
          at: new Date().toISOString(),
          artifact: verdictPath,
        };
        saveProgress(progress);
        throw new Error(`${item.cityKey}: LAYER-FOUND produced no applied staging rows`);
      }
    }

    if (isLandedStatus(verdict.status) || budgetExceeded) {
      progress.landed.push({
        cityKey: item.cityKey,
        status: verdict.status,
        at: new Date().toISOString(),
        layerUrl: verdict.layerUrl,
        searchPathCount: verdict.searchPaths.length,
        artifact: verdictPath,
        stageReport,
        budgetExceeded: budgetExceeded || undefined,
      });
      progress.halted = null;
    }

    runClose.verdicts.push({
      cityKey: item.cityKey,
      status: verdict.status,
      layerUrl: verdict.layerUrl,
      artifact: verdictPath,
      stageReport,
      budgetExceeded: budgetExceeded || undefined,
    });

    saveProgress(progress);
    console.log(
      JSON.stringify({
        event: "zoning-discovery.city-complete",
        cityKey: item.cityKey,
        status: verdict.status,
        layerUrl: verdict.layerUrl,
        searchPathCount: verdict.searchPaths.length,
        budgetExceeded: budgetExceeded || undefined,
      }),
    );
  }

  runClose.completedAt = new Date().toISOString();
  writeFileSync(join(OUT_DIR, "run_close.json"), JSON.stringify(runClose, null, 2));
  console.log(
    JSON.stringify({
      event: "zoning-discovery.run-close",
      verdictCount: runClose.verdicts.length,
      outDir: OUT_DIR,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
