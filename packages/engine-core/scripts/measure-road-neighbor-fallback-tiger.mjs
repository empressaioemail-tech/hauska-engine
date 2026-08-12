#!/usr/bin/env node
/**
 * Neighbor-county fallback benchmark on real two-county TIGER adjacency (F5 H3).
 * READ-ONLY — no database access.
 */
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCountyBoundaryIndex,
  pointInCountyGeometry,
  resolveWayCounties,
} from "../src/road-intake/way-to-county.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[4] || join(HERE, "../../../.tmp-f5-neighbor-fallback");
mkdirSync(outDir, { recursive: true });

function loadCounty(path, fips, name) {
  const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const feats =
    doc.type === "FeatureCollection" ? doc.features : [doc.type === "Feature" ? doc : null];
  const feat = feats.find((f) => {
    const p = f.properties || {};
    const g = String(p.countyFips || p.GEOID || p.GEO_ID || "").padStart(5, "0");
    return g === fips || !fips;
  }) || feats[0];
  return {
    countyFips: fips,
    countyName: name,
    geometry: feat.geometry,
    ringLen: feat.geometry.coordinates[0]?.length ?? 0,
  };
}

const bastropPath =
  process.argv[2] || "P:/tmp/statewide-roads/bastrop_48021_county.geojson";
const caldwellPath =
  process.argv[3] || "P:/tmp/statewide-roads/caldwell_48055_tiger.geojson";

const bastropRec = loadCounty(bastropPath, "48021", "Bastrop");
const caldwellRec = loadCounty(caldwellPath, "48055", "Caldwell");
const index = buildCountyBoundaryIndex([bastropRec, caldwellRec]);
const bastropOnly = buildCountyBoundaryIndex([bastropRec]);

function bench(label, coords, idx, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    resolveWayCounties(coords, idx);
  }
  const ms = (performance.now() - t0) / n;
  const sample = resolveWayCounties(coords, idx);
  return {
    label,
    msPerWay: Number(ms.toFixed(4)),
    hits: sample.hits.length,
    unresolved: sample.unresolved,
    fips: sample.hits.map((h) => h.countyFips),
    bases: sample.hits.map((h) => h.basis),
    coords,
  };
}

function bboxOf(rec) {
  const ring = rec.geometry.coordinates[0];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of ring) {
    w = Math.min(w, lon);
    s = Math.min(s, lat);
    e = Math.max(e, lon);
    n = Math.max(n, lat);
  }
  return { w, s, e, n };
}

const bb = bboxOf(bastropRec);
const interior = [
  [(bb.w + bb.e) / 2, (bb.s + bb.n) / 2],
  [(bb.w + bb.e) / 2 + 0.01, (bb.s + bb.n) / 2 + 0.01],
];

// Search for expensive path: bbox overlaps Bastrop but no vertex/midpoint inside.
let expensiveCoords = null;
let expensiveMs = 0;
const bastropIdx = bastropOnly[0];
outer: for (let lat = bb.s; lat <= bb.n; lat += 0.02) {
  for (let lon = bb.w; lon <= bb.e; lon += 0.02) {
    const a = [lon, lat];
    const b = [lon + 0.015, lat + 0.008];
    if (pointInCountyGeometry(a[0], a[1], bastropRec.geometry)) continue;
    if (pointInCountyGeometry(b[0], b[1], bastropRec.geometry)) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInCountyGeometry(mid[0], mid[1], bastropRec.geometry)) continue;
    const lineBbox = {
      w: Math.min(a[0], b[0]),
      e: Math.max(a[0], b[0]),
      s: Math.min(a[1], b[1]),
      n: Math.max(a[1], b[1]),
    };
    if (lineBbox.e < bb.w || lineBbox.w > bb.e || lineBbox.n < bb.s || lineBbox.s > bb.n) {
      continue;
    }
    const sample = resolveWayCounties([a, b], bastropOnly);
    if (sample.unresolved) {
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) resolveWayCounties([a, b], bastropOnly);
      expensiveMs = (performance.now() - t0) / 100;
      expensiveCoords = [a, b];
      break outer;
    }
  }
}

// Along shared border: midpoint of bastrop eastern bbox edge sample
const alongBorder = [
  [bb.e - 0.001, (bb.s + bb.n) / 2 - 0.05],
  [bb.e - 0.001, (bb.s + bb.n) / 2 + 0.05],
];

const results = [
  bench("vertex-inside-bastrop-tiger", interior, index, 2000),
  bench("two-county-along-adjacent-bbox-edge", alongBorder, index, 500),
];
if (expensiveCoords) {
  results.push(
    bench("bastrop-bbox-overlap-full-ring-sweep", expensiveCoords, bastropOnly, 200),
  );
}

const report = {
  event: "f5.neighbor-fallback-tiger-benchmark",
  readOnly: true,
  inputs: {
    bastropPath,
    caldwellPath,
    bastropRingVertices: bastropRec.ringLen,
    caldwellRingVertices: caldwellRec.ringLen,
    bastropBbox: bb,
  },
  results,
  expensiveProbe: expensiveCoords
    ? { coords: expensiveCoords, msPerWayDirect: Number(expensiveMs.toFixed(4)) }
    : null,
};

writeFileSync(join(outDir, "neighbor_fallback_tiger.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
