#!/usr/bin/env node
/**
 * ledger-serving-measure.mjs — the P-295 phase-1 instrument, runnable.
 *
 *   # 1. cell shape per rail for one county (heavy: announce it before you run it)
 *   FACTORY_DATABASE_URL_RO=... tsx scripts/ledger-serving-measure.mjs cells --county 48209 > out/m1-48209.csv
 *
 *   # 2. atoms existence for the parcels in a sample
 *   ATOMS_DATABASE_URL=... tsx scripts/ledger-serving-measure.mjs atoms --sample out/m2-sample-48209.csv
 *
 *   # 3. the /record route's own cost, cold and warm
 *   HAUSKA_ENGINE_API_KEY=... tsx scripts/ledger-serving-measure.mjs record-timing \
 *     --parcels out/parcels.txt --url https://hauska-retrieval-api-h7gvurgcq-uc.a.run.app
 *
 * Invoked via `tsx` so the TypeScript module under src/ resolves (same convention as
 * run-bastrop-spine-health.mjs). The SQL, the pointer vocabulary and the percentile rule all
 * come from src/ledger-serving-measure.ts — this file is a driver, never a second opinion.
 *
 * It reads. It does not write, deploy, or migrate anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  atomsEntityLookupExplainSql,
  atomsLookupSql,
  atomsParcelNodeExplainSql,
  cellShapeSql,
  parseCellShapeCsv,
  percentile,
  summarizeRows,
  timingSummary,
} from "../src/ledger-serving-measure.ts";

function arg(name, { required = true } = {}) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (required && !v) throw new Error(`--${name} is required`);
  return v;
}

/**
 * Every store call goes through psql with the connection passed as PG* environment variables,
 * never on the command line, so a connection string cannot land in a shell history or a
 * process listing (`ps` shows args, not env).
 */
function psqlWithUrlEnv(envName, sql) {
  const url = process.env[envName];
  if (!url) throw new Error(`${envName} is not set (fetch it with gcloud secrets versions access latest; never write it to disk)`);
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ""),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
  };
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function cmdCells() {
  const county = arg("county");
  process.stderr.write(`# heavy scan: parcel_record_cell, county ${county}, one statement, read-only, timeout in-statement\n`);
  const csv = psqlWithUrlEnv("FACTORY_DATABASE_URL_RO", cellShapeSql(county));
  process.stdout.write(csv.endsWith("\n") ? csv : `${csv}\n`);
  const rows = parseCellShapeCsv(csv);
  const summary = summarizeRows(rows);
  process.stderr.write(`# ${summary.length} rails, ${summary.reduce((s, r) => s + r.cells, 0)} cells, ${summary.reduce((s, r) => s + r.valueWithPointer, 0)} value cells with a pointer\n`);
}

function cmdAtoms() {
  const samplePath = arg("sample");
  const entityType = arg("entity-type", { required: false }) ?? "setback-rule";
  const ids = readFileSync(samplePath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(",")[0])
    .filter((id) => /^\d{5}:[A-Za-z0-9._-]+$/.test(id));
  if (ids.length === 0) throw new Error(`no parcel node ids in ${samplePath}`);
  process.stderr.write(`# ${ids.length} point lookups on atoms (entity_type, entity_id); no scan\n`);
  process.stderr.write(psqlWithUrlEnv("ATOMS_DATABASE_URL", atomsLookupSql(entityType, ids)));
}

function cmdExplains() {
  const entityType = arg("entity-type", { required: false }) ?? "setback-rule";
  const id = arg("parcel");
  process.stderr.write("# composite-unique spelling of the question:\n");
  process.stderr.write(psqlWithUrlEnv("ATOMS_DATABASE_URL", atomsEntityLookupExplainSql(entityType, id)));
  process.stderr.write("# partial-index spelling of the same question:\n");
  process.stderr.write(psqlWithUrlEnv("ATOMS_DATABASE_URL", atomsParcelNodeExplainSql(entityType, id)));
}

async function cmdRecordTiming() {
  const url = arg("url").replace(/\/+$/, "");
  const parcelsPath = arg("parcels");
  const key = process.env.HAUSKA_ENGINE_API_KEY;
  if (!key) throw new Error("HAUSKA_ENGINE_API_KEY is not set");
  const parcels = readFileSync(parcelsPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (parcels.length === 0) throw new Error(`no parcel node ids in ${parcelsPath}`);

  const call = async (parcelNodeId) => {
    const t0 = performance.now();
    const res = await fetch(`${url}/property-nodes/${encodeURIComponent(parcelNodeId)}/record`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = await res.text();
    return { ms: performance.now() - t0, status: res.status, bytes: body.length };
  };

  const coldMs = [];
  const warmMs = [];
  const statuses = {};
  for (const p of parcels) {
    const cold = await call(p);
    const warm = await call(p);
    coldMs.push(cold.ms);
    warmMs.push(warm.ms);
    statuses[cold.status] = (statuses[cold.status] ?? 0) + 1;
  }
  const summary = timingSummary({ coldMs, warmMs });
  process.stdout.write(`${JSON.stringify({ url, parcels: parcels.length, statuses, ...summary, coldMs, warmMs }, null, 2)}\n`);
  process.stderr.write(`# cold p50 ${percentile(coldMs, 50)?.toFixed(0)}ms p95 ${percentile(coldMs, 95)?.toFixed(0)}ms | warm p50 ${percentile(warmMs, 50)?.toFixed(0)}ms p95 ${percentile(warmMs, 95)?.toFixed(0)}ms\n`);
}

const COMMANDS = { cells: cmdCells, atoms: cmdAtoms, explains: cmdExplains, "record-timing": cmdRecordTiming };
const cmd = process.argv[2];
if (!cmd || !(cmd in COMMANDS)) {
  process.stderr.write(`usage: ledger-serving-measure.mjs <${Object.keys(COMMANDS).join("|")}> [--flags]\n`);
  process.exit(2);
}
await COMMANDS[cmd]();
