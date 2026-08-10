#!/usr/bin/env node
/**
 * Measure peak RSS while streaming Texas ML footprints for a county bbox.
 * Usage: ML_FOOTPRINT_CACHE_DIR=P:/tmp/ml-footprint-cache node scripts/probe-ml-footprint-rss.mjs --county=48021
 */

import { performance } from "node:perf_hooks";

import {
  loadMlFootprintsForBbox,
  probeMlFootprintsForBbox,
} from "../src/building-footprint/index.ts";

const COUNTY_BBOX = {
  "48021": {
    westLng: -97.64910865299998,
    southLat: 29.78656314600005,
    eastLng: -97.02448493599996,
    northLat: 30.419501661000027,
  },
  "48113": {
    westLng: -97.03869264399998,
    southLat: 32.54500737300003,
    eastLng: -96.51702546099995,
    northLat: 32.98966462000004,
  },
};

function parseCounty(argv) {
  for (const a of argv) {
    if (a.startsWith("--county=")) return a.slice("--county=".length);
    if (a === "--county") return argv[argv.indexOf(a) + 1];
  }
  return null;
}

const county = parseCounty(process.argv.slice(2));
const bbox = COUNTY_BBOX[county ?? ""];
if (!bbox) {
  console.error("FATAL: --county=48021|48113 required (hardcoded txgio bbox anchors)");
  process.exit(1);
}

const probeOnly = process.argv.includes("--probe-only");
const cacheDir = process.env.ML_FOOTPRINT_CACHE_DIR?.trim() || "P:/tmp/ml-footprint-cache";
process.env.ML_FOOTPRINT_CACHE_DIR = cacheDir;

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}, 50);

const t0 = performance.now();
const loader = probeOnly ? probeMlFootprintsForBbox : loadMlFootprintsForBbox;
const result = await loader({ bbox, cacheDir, probeOnly: probeOnly || undefined });
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);

console.log(
  JSON.stringify(
    {
      event: "ml-footprint-rss-probe",
      county,
      bbox,
      cacheDir,
      probeOnly,
      partitionsStreamed: result.partitionsStreamed,
      featuresScanned: result.featuresScanned,
      featuresRead: result.featuresRead,
      featuresCollected: result.features.length,
      peakQueueDepth: result.peakQueueDepth,
      peakRssMb: Math.round((peakRss / (1024 * 1024)) * 10) / 10,
      wallMs: Math.round(performance.now() - t0),
      sourceLabel: result.sourceLabel,
    },
    null,
    2,
  ),
);
