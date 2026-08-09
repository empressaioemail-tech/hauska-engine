#!/usr/bin/env node
/**
 * ingest-statewide-roads-pbf.mjs — L3 Geofabrik PBF → road-node atoms (build/prove lane).
 *
 * DEFAULT IS DRY-RUN. Never writes unless PROPERTY_ATOM_PATH=1 AND ROAD_PBF_APPLY=1.
 * NO full statewide production ingest under this lane without reporting first —
 * pass --county-fips=48021 (or a single-county GeoJSON) for proof.
 *
 * Backpressure: Python worker writes NDJSON to disk (flush-every-N). This
 * script streams that file line-by-line and awaits each DB batch before reading
 * the next batch-sized chunk into memory. No unbounded stdout queue.
 *
 *   # prove extract + compare (no DB):
 *   node scripts/ingest-statewide-roads-pbf.mjs \
 *     --pbf P:/tmp/statewide-roads/texas-latest.osm.pbf \
 *     --county-geojson P:/tmp/statewide-roads/bastrop_48021_county.geojson \
 *     --expected-md5 4dd27afd6bc1c654f9b9635b709cf424 \
 *     --work-dir P:/tmp/statewide-roads/proof-2026-08-09 \
 *     --compare-fixture ../src/road-intake/fixtures/bastrop-overpass-city-bbox.json
 *
 * Env:
 *   ROADS_PBF_PYTHON   python binary (default: python / python3)
 *   ROAD_INGEST_BATCH  apply batch size (default 100)
 *   ROAD_INGEST_LIMIT  cap ways (0 = all)
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

import {
  emitRoadNode,
  parseOsmWayElement,
  roadIntakeDescriptorFromCountyRegistry,
  GEOFABRIK_TEXAS_PBF_URL,
} from "../src/road-intake/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WORKER = join(REPO_ROOT, "artifacts/roads-pbf-worker/extract_highways.py");
const PINNED_MD5 = "4dd27afd6bc1c654f9b9635b709cf424";

function parseArgs(argv) {
  const out = {
    pbf: null,
    countyGeojson: null,
    expectedMd5: PINNED_MD5,
    workDir: null,
    compareFixture: null,
    countyFips: null,
    countyName: "County",
    apply: process.env.ROAD_PBF_APPLY === "1",
    skipExtract: false,
    ndjson: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--pbf") {
      out.pbf = n;
      i++;
    } else if (a === "--county-geojson") {
      out.countyGeojson = n;
      i++;
    } else if (a === "--expected-md5") {
      out.expectedMd5 = n;
      i++;
    } else if (a === "--work-dir") {
      out.workDir = n;
      i++;
    } else if (a === "--compare-fixture") {
      out.compareFixture = n;
      i++;
    } else if (a === "--county-fips") {
      out.countyFips = n;
      i++;
    } else if (a === "--county-name") {
      out.countyName = n;
      i++;
    } else if (a === "--ndjson") {
      out.ndjson = n;
      i++;
    } else if (a === "--skip-extract") {
      out.skipExtract = true;
    } else if (a === "--apply") {
      out.apply = true;
    }
  }
  return out;
}

function resolvePython() {
  return (
    process.env.ROADS_PBF_PYTHON?.trim() ||
    process.env.HYDROLOGY_PYTHON?.trim() ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

function runWorker({ python, pbf, countyGeojson, outNdjson, reportJson, expectedMd5 }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      WORKER,
      "--pbf",
      pbf,
      "--county-geojson",
      countyGeojson,
      "--out-ndjson",
      outNdjson,
      "--report-json",
      reportJson,
      "--expected-md5",
      expectedMd5,
    ];
    const child = spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      const s = c.toString("utf8");
      stderr += s;
      process.stderr.write(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `roads-pbf-worker exited ${code}\nstderr tail:\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function loadCountyMeta(geojsonPath, overrideFips, overrideName) {
  let text = readFileSync(geojsonPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const doc = JSON.parse(text);
  const feat =
    doc.type === "FeatureCollection" ? doc.features?.[0] : doc.type === "Feature" ? doc : null;
  const props = feat?.properties ?? {};
  const fips = String(
    overrideFips || props.countyFips || props.GEOID || props.GEO_ID || "",
  ).padStart(5, "0");
  const name = overrideName || props.countyName || props.NAME || props.name || "County";
  if (!/^\d{5}$/.test(fips)) {
    throw new Error(`could not resolve countyFips from ${geojsonPath}`);
  }
  return { countyFips: fips, countyName: name };
}

const args = parseArgs(process.argv);
if (!args.countyGeojson) {
  console.error("FATAL: --county-geojson required (scoped county proof; refuse bare statewide)");
  process.exit(1);
}
if (!args.pbf && !args.skipExtract) {
  console.error("FATAL: --pbf required unless --skip-extract --ndjson=...");
  process.exit(1);
}
if (!args.workDir) {
  console.error("FATAL: --work-dir required");
  process.exit(1);
}

mkdirSync(args.workDir, { recursive: true });
const outNdjson = args.ndjson || join(args.workDir, "highways.ndjson");
const reportJson = join(args.workDir, "extract_report.json");
const ingestReportPath = join(args.workDir, "ingest_report.json");

const countyMeta = loadCountyMeta(
  args.countyGeojson,
  args.countyFips,
  args.countyName,
);

const t0 = performance.now();
let extractReport = null;

if (!args.skipExtract) {
  if (!existsSync(args.pbf)) {
    console.error(`FATAL: pbf missing ${args.pbf}`);
    process.exit(2);
  }
  // Fail closed if caller skips --expected-md5 empty string intentionally.
  const md5 = (args.expectedMd5 || "").trim() || PINNED_MD5;
  await runWorker({
    python: resolvePython(),
    pbf: args.pbf,
    countyGeojson: args.countyGeojson,
    outNdjson,
    reportJson,
    expectedMd5: md5,
  });
  extractReport = JSON.parse(readFileSync(reportJson, "utf8"));
} else if (!existsSync(outNdjson)) {
  console.error(`FATAL: --skip-extract but ndjson missing: ${outNdjson}`);
  process.exit(2);
}

const descriptor = roadIntakeDescriptorFromCountyRegistry(
  {
    countyFips: countyMeta.countyFips,
    countyName: countyMeta.countyName,
  },
  {
    sourceUrl: `${GEOFABRIK_TEXAS_PBF_URL}#md5=${PINNED_MD5}`,
  },
);

const writeBatch = Math.max(1, Number(process.env.ROAD_INGEST_BATCH || 100));
const ingestLimit = Number(process.env.ROAD_INGEST_LIMIT || 0);
const doApply =
  args.apply &&
  process.env.PROPERTY_ATOM_PATH === "1" &&
  process.env.ROAD_PBF_APPLY === "1";

let storageHandle = null;
if (doApply) {
  const { createPgStorage, resolveSubstrateDatabaseUrl } = await import(
    "@hauska-engine/storage"
  );
  const url = resolveSubstrateDatabaseUrl();
  if (!url) {
    console.error("FATAL: DATABASE_URL required for apply");
    process.exit(1);
  }
  // Refuse pooler for apply (write path / code 25006 lesson).
  if (url.includes("-pooler.")) {
    console.error("FATAL: refuse pooler DATABASE_URL for apply; use direct Neon host");
    process.exit(1);
  }
  storageHandle = createPgStorage({ databaseUrl: url, maxConnections: 2 });
}

const extractedAt = new Date().toISOString();
let waysRead = 0;
let atomsEmitted = 0;
let multiCountyWays = 0;
const osmWayIds = new Set();
const roadNodeIdsSample = [];
let batch = [];
let maxBatchResident = 0;

async function flushBatch() {
  if (batch.length === 0) return;
  maxBatchResident = Math.max(maxBatchResident, batch.length);
  if (doApply) {
    await storageHandle.storage.writeRoadAtomsBatch(batch);
  }
  batch = [];
}

const rl = createInterface({
  input: createReadStream(outNdjson, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;
  const el = JSON.parse(line);
  waysRead += 1;
  if (ingestLimit > 0 && waysRead > ingestLimit) break;

  const hits = Array.isArray(el.countyHits) && el.countyHits.length > 0
    ? el.countyHits
    : [{ countyFips: countyMeta.countyFips, countyName: countyMeta.countyName, basis: "assumed-single" }];
  if (hits.length > 1) multiCountyWays += 1;
  osmWayIds.add(Number(el.id));

  const obs = parseOsmWayElement(
    { type: "way", id: el.id, tags: el.tags, geometry: el.geometry },
    extractedAt,
  );
  if (!obs) continue;

  for (const hit of hits) {
    const desc =
      hit.countyFips === countyMeta.countyFips
        ? descriptor
        : roadIntakeDescriptorFromCountyRegistry(
            {
              countyFips: hit.countyFips,
              countyName: hit.countyName || hit.countyFips,
            },
            { sourceUrl: descriptor.sourceUrl },
          );
    const atom = emitRoadNode(desc, obs);
    atomsEmitted += 1;
    if (roadNodeIdsSample.length < 20) {
      roadNodeIdsSample.push({
        roadNodeId: atom.roadNodeId,
        basis: hit.basis,
      });
    }
    if (doApply) {
      batch.push(atom);
      if (batch.length >= writeBatch) {
        await flushBatch();
      }
    }
  }
}
await flushBatch();
if (storageHandle) await storageHandle.close();

let compare = null;
if (args.compareFixture) {
  const compareOut = join(args.workDir, "compare.json");
  const cmpScript = join(HERE, "compare-pbf-ndjson-to-overpass-fixture.mjs");
  const cmp = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "tsx",
      cmpScript,
      "--ndjson",
      outNdjson,
      "--fixture",
      args.compareFixture,
      "--out",
      compareOut,
      "--county-fips",
      countyMeta.countyFips,
      "--county-name",
      countyMeta.countyName,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: join(HERE, ".."),
      shell: process.platform === "win32",
    },
  );
  let cmpErr = "";
  cmp.stderr.on("data", (c) => {
    cmpErr += c.toString("utf8");
  });
  const cmpCode = await new Promise((res) => cmp.on("close", res));
  if (cmpCode === 0 && existsSync(compareOut)) {
    compare = JSON.parse(readFileSync(compareOut, "utf8"));
  } else {
    console.error(
      `compare spawn exited ${cmpCode}; run compare-pbf-ndjson-to-overpass-fixture separately\n${cmpErr.slice(-1500)}`,
    );
  }
}

const ingestReport = {
  event: "statewide-roads-pbf.done",
  mode: doApply ? "apply" : "dry-run",
  countyFips: countyMeta.countyFips,
  countyName: countyMeta.countyName,
  sourceAdapter: descriptor.sourceAdapter,
  sourceUrl: descriptor.sourceUrl,
  pbf: args.pbf,
  ndjson: outNdjson,
  extractReport,
  counts: {
    waysRead,
    distinctOsmWayId: osmWayIds.size,
    atomsEmitted,
    multiCountyWays,
    perCountyVsDedupNote:
      "atomsEmitted may exceed distinctOsmWayId when ways hit multiple counties",
  },
  backpressure: {
    mechanism: "ndjson-disk + await writeRoadAtomsBatch per ROAD_INGEST_BATCH",
    writeBatch,
    maxBatchResident,
  },
  sampleRoadNodeIds: roadNodeIdsSample,
  compare,
  elapsedMs: Math.round(performance.now() - t0),
  pinnedMd5: PINNED_MD5,
};

writeFileSync(ingestReportPath, `${JSON.stringify(ingestReport, null, 2)}\n`, {
  encoding: "utf8",
});
console.log(JSON.stringify(ingestReport, null, 2));

if (doApply && atomsEmitted === 0) {
  console.error("FATAL: apply mode emitted zero atoms");
  process.exit(1);
}
