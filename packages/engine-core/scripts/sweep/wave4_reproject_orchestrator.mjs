/**
 * Wave 4 L2 parcel reprojection orchestrator (57 Web Mercator counties).
 * - Loads ingest_safe_today=false from county source matrix (202505 vintage)
 * - Sorts by parcel_count_est ascending; concurrency BATCH_SIZE=2
 * - Halt on first county failure
 * - Donley 48129 is NOT in scope (dead at source 404); document only
 * - Sets DATABASE_URL from TXGIO_DATABASE_URL in out-dir/.env before workers run
 *
 * Usage:
 *   node wave4_reproject_orchestrator.mjs \
 *     --out-dir=P:/tmp/wave4_reproject_<date> \
 *     --ingest-repo-path=P:/legacy-design-tools \
 *     --matrix-path=P:/doc_repo/_inbox/2026-08-08_SWEEP_county_source_matrix.json
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PSQL = "C:/Program Files/PostgreSQL/18/bin/psql.exe";
const DEFAULT_INGEST_REPO = "P:/legacy-design-tools";
const DEFAULT_MATRIX =
  "P:/doc_repo/_inbox/2026-08-08_SWEEP_county_source_matrix.json";
const WAVE_TAG = "WAVE4";
const DONLEY_NOTE =
  "Donley 48129 excluded: dead at source (404), not among the 57 ingest_safe_today=false counties";

function parseArgs(argv) {
  const config = {
    outDir: null,
    ingestRepoPath: DEFAULT_INGEST_REPO,
    matrixPath: DEFAULT_MATRIX,
    psqlPath: DEFAULT_PSQL,
    batchSize: 2,
  };
  for (const a of argv) {
    if (a.startsWith("--out-dir=")) config.outDir = a.slice("--out-dir=".length);
    else if (a.startsWith("--ingest-repo-path=")) {
      config.ingestRepoPath = a.slice("--ingest-repo-path=".length);
    } else if (a.startsWith("--matrix-path=")) config.matrixPath = a.slice("--matrix-path=".length);
    else if (a.startsWith("--psql-path=")) config.psqlPath = a.slice("--psql-path=".length);
    else if (a.startsWith("--batch-size=")) {
      config.batchSize = Number(a.slice("--batch-size=".length));
    }
  }
  return config;
}

const config = parseArgs(process.argv.slice(2));
if (!config.outDir) {
  console.error(
    "Usage: node wave4_reproject_orchestrator.mjs --out-dir=PATH " +
      "[--ingest-repo-path=PATH] [--matrix-path=PATH] [--batch-size=N] [--psql-path=PATH]",
  );
  process.exit(1);
}

const WAVE_DIR = config.outDir;
const INGEST_REPO = config.ingestRepoPath;
const MATRIX = config.matrixPath;
const PSQL = config.psqlPath;
const BATCH_SIZE = config.batchSize;
const WORKER = join(__dirname, "wave4_reproject_worker.mjs");
const PROGRESS = join(WAVE_DIR, "progress.json");

mkdirSync(WAVE_DIR, { recursive: true });

function loadEnvFromOutDir() {
  const envPath = join(WAVE_DIR, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`missing ${envPath} — copy TXGIO_DATABASE_URL into out-dir/.env`);
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) process.env[t.slice(0, i)] = t.slice(i + 1);
  }
  const txgio = process.env.TXGIO_DATABASE_URL;
  if (!txgio) {
    throw new Error(`TXGIO_DATABASE_URL not found in ${envPath}`);
  }
  process.env.DATABASE_URL = txgio;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function sql(query) {
  const db = requireEnv("DATABASE_URL");
  const r = spawnSync(
    PSQL,
    [db, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", query],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function writeProgress(state) {
  writeFileSync(PROGRESS, JSON.stringify(state, null, 2), "utf8");
}

function loadCounties() {
  const matrix = JSON.parse(readFileSync(MATRIX, "utf8"));
  const counties = matrix.counties
    .filter((c) => c.ingest_safe_today === false)
    .sort((a, b) => (a.parcel_count_est || 0) - (b.parcel_count_est || 0));
  if (counties.length !== 57) {
    throw new Error(`expected 57 counties, got ${counties.length}`);
  }
  if (counties.some((c) => c.fips === "48129")) {
    throw new Error("Donley 48129 must not appear in Wave 4 county list");
  }
  return counties;
}

function runCountyWorker(c) {
  return new Promise((resolve) => {
    const args = [
      WORKER,
      `--out-dir=${WAVE_DIR}`,
      `--ingest-repo-path=${INGEST_REPO}`,
      `--psql-path=${PSQL}`,
      c.fips,
      c.name,
      c.url,
      String(c.http_status ?? ""),
      String(c.vintage_yyyymm ?? ""),
    ];
    const child = spawn("node", args, {
      windowsHide: true,
      env: process.env,
      shell: false,
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
      const art = join(WAVE_DIR, `wave4_${c.fips}.json`);
      if (existsSync(art)) {
        try {
          resolve(JSON.parse(readFileSync(art, "utf8")));
          return;
        } catch (e) {
          resolve({
            fips: c.fips,
            name: c.name,
            pass: false,
            halted: true,
            halt_reason: `artifact parse failed: ${String(e)}`,
            worker_exit: code,
          });
          return;
        }
      }
      resolve({
        fips: c.fips,
        name: c.name,
        pass: false,
        halted: true,
        halt_reason: `worker exit ${code} without artifact; stderr=${stderr.slice(-500)}`,
        worker_exit: code,
        stdout_tail: stdout.slice(-500),
      });
    });
  });
}

async function main() {
  if (!existsSync(WORKER)) throw new Error(`missing worker ${WORKER}`);
  loadEnvFromOutDir();
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--use-system-ca"]
    .filter(Boolean)
    .join(" ");
  requireEnv("DATABASE_URL");

  let counties = loadCounties();
  const already = sql(
    `SELECT county_fips FROM txgio_parcel GROUP BY 1 HAVING count(*) > 0`,
  );
  const landedSet = new Set(
    already.split(/\r?\n/).filter(Boolean).map((f) => f.trim()),
  );
  const cohortFips = new Set(counties.map((c) => c.fips));
  const skip = [...landedSet].filter((f) => cohortFips.has(f));
  if (skip.length > 0) {
    counties = counties.filter((c) => !landedSet.has(c.fips));
    console.log(
      `Skipping ${skip.length} already-loaded cohort counties: ${skip.join(",")}`,
    );
  }
  console.log(
    `Wave 4 orchestrator: ${counties.length} counties, BATCH_SIZE=${BATCH_SIZE}, ingestRepo=${INGEST_REPO}`,
  );
  console.log(DONLEY_NOTE);

  const state = {
    wave: WAVE_TAG,
    ingestRepo: INGEST_REPO,
    batch_size: BATCH_SIZE,
    county_count: counties.length,
    donley_note: DONLEY_NOTE,
    halted: false,
    haltReason: null,
    results: [],
    waveStarted: Date.now(),
  };
  writeProgress(state);

  const batches = chunk(counties, BATCH_SIZE);
  for (let bi = 0; bi < batches.length; bi++) {
    if (state.halted) break;
    const batch = batches[bi];
    console.log(
      `\n======== batch ${bi + 1}/${batches.length}: ${batch.map((c) => c.fips).join(",")} ========`,
    );

    const batchResults = await Promise.all(batch.map((c) => runCountyWorker(c)));
    for (const r of batchResults) {
      r.batchIndex = bi + 1;
      state.results.push(r);
      if (r.halted || !r.pass) {
        state.halted = true;
        state.haltReason = r.halt_reason || `county ${r.fips} failed`;
        console.error(`\n*** WAVE 4 HALTED at ${r.fips}: ${state.haltReason} ***\n`);
      }
    }

    writeProgress({
      ...state,
      currentBatch: bi + 1,
      totalBatches: batches.length,
      landed_so_far: state.results.filter((x) => x.pass).length,
      wall_s: Math.round((Date.now() - state.waveStarted) / 1000),
    });

    if (state.halted) break;
  }

  const landed = state.results.filter((r) => r.pass);
  writeFileSync(
    join(WAVE_DIR, "wave4_results.json"),
    JSON.stringify(
      {
        ...state,
        counties_landed: landed.length,
        counties_failed: state.results.filter((r) => !r.pass).length,
        wall_clock_ms: Date.now() - state.waveStarted,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        halted: state.halted,
        haltReason: state.haltReason,
        landed: landed.length,
        progress: PROGRESS,
      },
      null,
      2,
    ),
  );
  process.exit(state.halted ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
