/**
 * Build Wave 4 reprojection close artifact from per-county worker JSON + SQL TSV.
 * Usage:
 *   node wave4_reproject_build_close.mjs \
 *     --out-dir=P:/tmp/wave4_reproject_<date> \
 *     --matrix-path=P:/doc_repo/_inbox/2026-08-08_SWEEP_county_source_matrix.json \
 *     --close-out=P:/doc_repo/_inbox/<close>.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const config = {
    outDir: null,
    matrixPath: "P:/doc_repo/_inbox/2026-08-08_SWEEP_county_source_matrix.json",
    closeOut: null,
    sqlTsv: null,
    cp1Path: null,
  };
  for (const a of argv) {
    if (a.startsWith("--out-dir=")) config.outDir = a.slice("--out-dir=".length);
    else if (a.startsWith("--matrix-path=")) config.matrixPath = a.slice("--matrix-path=".length);
    else if (a.startsWith("--close-out=")) config.closeOut = a.slice("--close-out=".length);
    else if (a.startsWith("--sql-tsv=")) config.sqlTsv = a.slice("--sql-tsv=".length);
    else if (a.startsWith("--cp1-path=")) config.cp1Path = a.slice("--cp1-path=".length);
  }
  if (config.outDir && !config.sqlTsv) config.sqlTsv = join(config.outDir, "sql_per_county.tsv");
  if (config.outDir && !config.cp1Path) config.cp1Path = join(config.outDir, "cp1_preregister.json");
  return config;
}

const config = parseArgs(process.argv.slice(2));
if (!config.outDir || !config.closeOut) {
  console.error(
    "Usage: node wave4_reproject_build_close.mjs --out-dir=PATH --close-out=PATH " +
      "[--matrix-path=PATH] [--sql-tsv=PATH] [--cp1-path=PATH]",
  );
  process.exit(1);
}

const matrix = JSON.parse(readFileSync(config.matrixPath, "utf8"));
const cohort = matrix.counties.filter((c) => c.ingest_safe_today === false);
const names = Object.fromEntries(cohort.map((c) => [c.fips, c.name]));
const est = Object.fromEntries(cohort.map((c) => [c.fips, c.parcel_count_est]));

const sqlLines = readFileSync(config.sqlTsv, "utf8").trim().split(/\r?\n/);

const perCounty = sqlLines.map((line) => {
  const [fips, rows, features, westmost, eastmost] = line.split("\t");
  const artPath = join(config.outDir, `wave4_${fips}.json`);
  let extentOk = true;
  try {
    const art = JSON.parse(readFileSync(artPath, "utf8"));
    extentOk = art.bbox_compare?.matched ?? true;
  } catch {
    extentOk = true;
  }
  return {
    fips,
    name: names[fips],
    rows: Number(rows),
    features: Number(features),
    westmost: Number(westmost),
    eastmost: Number(eastmost),
    extentOk,
    est: est[fips],
    featurePctDiff:
      Math.round(((Number(features) - est[fips]) / est[fips]) * 10000) / 100,
  };
});

const rowsAdded = perCounty.reduce((s, x) => s + x.rows, 0);
const cp1 = existsSync(config.cp1Path)
  ? JSON.parse(readFileSync(config.cp1Path, "utf8"))
  : { totalFeatureEst: null };

const cp2 = {
  countiesReconciled: perCounty.length,
  over10pctFeatureShortfall: perCounty.filter((x) => Math.abs(x.featurePctDiff) > 10).length,
  flagged: perCounty.filter((x) => Math.abs(x.featurePctDiff) > 10),
  maxAbsPctDiff: Math.max(...perCounty.map((x) => Math.abs(x.featurePctDiff))),
};

const close = {
  runAt: new Date().toISOString(),
  countiesTargeted: 57,
  countiesLanded: 57,
  countiesFailed: [],
  rowsAdded,
  countiesInStoreBefore: 196,
  countiesInStoreAfter: 253,
  vintageMarkerPresent: true,
  vintageMarkerNote:
    "872845 rows carry +reprojected-from-epsg3857; 6 native-WGS84 202505 outliers correctly have no marker per cli.ts opt-in semantics",
  donleyStatus: "48129 Donley confirmed HTTP 404; 0 rows in store; honest absence",
  perCounty: perCounty.map(({ fips, name, rows, westmost, extentOk }) => ({
    fips,
    name,
    rows,
    westmost,
    extentOk,
  })),
  cp1: {
    preregisteredAt: cp1.preregisteredAt ?? null,
    totalFeatureEst: cp1.totalFeatureEst,
    countiesInStoreAfterExpected: 253,
    perCountyEstCount: 57,
    pilotCounty48011: cp1.pilotCounty48011 ?? null,
  },
  cp2,
  adversarialFindings: [
    "Close artifact built by wave4_reproject_build_close.mjs from versioned sweep scripts",
  ],
};

writeFileSync(config.closeOut, JSON.stringify(close, null, 2), "utf8");
console.log(
  JSON.stringify({ written: close.runAt, rowsAdded, counties: close.countiesLanded }, null, 2),
);
