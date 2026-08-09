#!/usr/bin/env node
/**
 * Measure neighbor-county fallback resolver cost on a two-county index (F5 H3).
 */
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

import {
  buildCountyBoundaryIndex,
  resolveWayCounties,
} from "../src/road-intake/way-to-county.ts";

function loadCounty(path, fips, name) {
  const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const feat = doc.type === "FeatureCollection" ? doc.features[0] : doc;
  return {
    countyFips: fips,
    countyName: name,
    geometry: feat.geometry,
  };
}

const bastropPath =
  process.argv[2] || "P:/tmp/statewide-roads/bastrop_48021_county.geojson";
const caldwellPath =
  process.argv[3] || "P:/tmp/statewide-roads/caldwell_48055_county.geojson";

const index = buildCountyBoundaryIndex([
  loadCounty(bastropPath, "48021", "Bastrop"),
  loadCounty(caldwellPath, "48055", "Caldwell"),
]);

const interior = [
  [-97.5, 30.1],
  [-97.45, 30.12],
];

const neighborFallback = [
  [-97.15, 30.05],
  [-97.12, 30.06],
];

function bench(label, coords, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    resolveWayCounties(coords, index);
  }
  const ms = (performance.now() - t0) / n;
  const sample = resolveWayCounties(coords, index);
  console.log(
    JSON.stringify({
      label,
      msPerWay: Number(ms.toFixed(4)),
      hits: sample.hits.length,
      bases: sample.hits.map((h) => h.basis),
    }),
  );
}

bench("vertex-inside", interior, 5000);
bench("neighbor-county-fallback", neighborFallback, 500);

// Expensive path: bbox overlaps real 1243-vertex Bastrop ring but no vertex/midpoint inside.
const bastropOnly = buildCountyBoundaryIndex([
  loadCounty(bastropPath, "48021", "Bastrop"),
]);
const bboxOverlapOutside = [
  [-97.85, 30.55],
  [-97.84, 30.56],
];
function benchIndex(label, coords, index, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    resolveWayCounties(coords, index);
  }
  const ms = (performance.now() - t0) / n;
  const sample = resolveWayCounties(coords, index);
  console.log(
    JSON.stringify({
      label,
      msPerWay: Number(ms.toFixed(4)),
      hits: sample.hits.length,
      unresolved: sample.unresolved,
      bases: sample.hits.map((h) => h.basis),
    }),
  );
}
benchIndex("bastrop-bbox-outside-full-ring-sweep", bboxOverlapOutside, bastropOnly, 200);
