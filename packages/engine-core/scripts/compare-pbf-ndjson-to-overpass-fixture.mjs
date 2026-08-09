#!/usr/bin/env node
/**
 * compare-pbf-ndjson-to-overpass-fixture.mjs
 *
 * Prove one-county PBF extract against a committed Overpass fixture.
 * Default: Bastrop city bbox ∩ PBF county NDJSON vs bastrop-overpass-city-bbox.json.
 *
 * Does NOT tune filters after first compare — divergence IS the finding.
 *
 *   node scripts/compare-pbf-ndjson-to-overpass-fixture.mjs \
 *     --ndjson P:/tmp/.../bastrop.ndjson \
 *     --fixture .../bastrop-overpass-city-bbox.json \
 *     --out P:/doc_repo/_inbox/2026-08-09_STATEWIDE_ROADS_bastrop_compare.json
 */

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BASTROP_CITY_BBOX } from "../src/road-intake/fetch-overpass-bbox.ts";
import {
  emitRoadNode,
  parseOsmWayElement,
  roadIntakeDescriptorFromCountyRegistry,
} from "../src/road-intake/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(
  HERE,
  "../src/road-intake/fixtures/bastrop-overpass-city-bbox.json",
);

function parseArgs(argv) {
  const out = {
    ndjson: null,
    fixture: DEFAULT_FIXTURE,
    out: null,
    south: BASTROP_CITY_BBOX.south,
    west: BASTROP_CITY_BBOX.west,
    north: BASTROP_CITY_BBOX.north,
    east: BASTROP_CITY_BBOX.east,
    countyFips: "48021",
    countyName: "Bastrop County",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--ndjson") {
      out.ndjson = next;
      i++;
    } else if (a === "--fixture") {
      out.fixture = next;
      i++;
    } else if (a === "--out") {
      out.out = next;
      i++;
    } else if (a === "--county-fips") {
      out.countyFips = next;
      i++;
    } else if (a === "--help") {
      console.log("see file header");
      process.exit(0);
    }
  }
  if (!out.ndjson) {
    console.error("FATAL: --ndjson required");
    process.exit(1);
  }
  return out;
}

function wayIntersectsBbox(geometry, bbox) {
  for (const g of geometry ?? []) {
    const lon = g.lon;
    const lat = g.lat;
    if (
      lat >= bbox.south &&
      lat <= bbox.north &&
      lon >= bbox.west &&
      lon <= bbox.east
    ) {
      return true;
    }
  }
  return false;
}

function loadFixtureHighwayMap(fixturePath) {
  let text = readFileSync(fixturePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const raw = JSON.parse(text);
  const map = new Map();
  for (const el of raw.elements ?? []) {
    if (el?.type !== "way") continue;
    const hw = el.tags?.highway;
    if (!hw) continue;
    map.set(Number(el.id), {
      highway: String(hw),
      name: el.tags?.name ?? null,
    });
  }
  return map;
}

async function loadPbfCityIntersect(ndjsonPath, bbox) {
  const map = new Map();
  let countyWays = 0;
  const rl = createInterface({
    input: createReadStream(ndjsonPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const el = JSON.parse(line);
    if (el?.type !== "way" || !el.tags?.highway) continue;
    countyWays += 1;
    if (!wayIntersectsBbox(el.geometry, bbox)) continue;
    map.set(Number(el.id), {
      highway: String(el.tags.highway),
      name: el.tags.name ?? null,
      countyHits: el.countyHits ?? [],
      element: el,
    });
  }
  return { map, countyWays };
}

const args = parseArgs(process.argv);
const bbox = {
  south: args.south,
  west: args.west,
  north: args.north,
  east: args.east,
};

const fixtureMap = loadFixtureHighwayMap(args.fixture);
const { map: pbfMap, countyWays } = await loadPbfCityIntersect(args.ndjson, bbox);

const onlyFixture = [];
const onlyPbf = [];
const tagMismatches = [];
let intersection = 0;

for (const [id, fx] of fixtureMap) {
  const pb = pbfMap.get(id);
  if (!pb) {
    onlyFixture.push(id);
    continue;
  }
  intersection += 1;
  if (pb.highway !== fx.highway) {
    tagMismatches.push({ id, fixture: fx.highway, pbf: pb.highway });
  }
}
for (const id of pbfMap.keys()) {
  if (!fixtureMap.has(id)) onlyPbf.push(id);
}

// Dry-emit first intersection way through product emitRoadNode path.
const sampleId = [...fixtureMap.keys()].find((id) => pbfMap.has(id));
let sampleEmit = null;
if (sampleId != null) {
  const el = pbfMap.get(sampleId).element;
  const extractedAt = new Date().toISOString();
  const obs = parseOsmWayElement(
    {
      type: "way",
      id: el.id,
      tags: el.tags,
      geometry: el.geometry,
    },
    extractedAt,
  );
  const descriptor = roadIntakeDescriptorFromCountyRegistry({
    countyFips: args.countyFips,
    countyName: args.countyName,
  });
  if (obs) {
    const atom = emitRoadNode(descriptor, obs);
    sampleEmit = {
      roadNodeId: atom.roadNodeId,
      osmWayId: atom.osmWayId,
      sourceAdapter: atom.sourceAdapter,
      expectedRoadNodeId: `${args.countyFips}:road:${sampleId}`,
    };
  }
}

const report = {
  comparison: "pbf_county_ndjson_x_city_bbox vs overpass fixture",
  ndjson: args.ndjson,
  fixture: args.fixture,
  cityBbox: bbox,
  counts: {
    pbfCountyHighwayWays: countyWays,
    pbfIntersectingCityBbox: pbfMap.size,
    cityFixtureHighwayWays: fixtureMap.size,
    intersection,
    onlyInCityFixture: onlyFixture.length,
    onlyInPbfCityBbox: onlyPbf.length,
    highwayTagMismatchesOnIntersection: tagMismatches.length,
  },
  samples: {
    onlyInCityFixture_first30: onlyFixture.slice(0, 30),
    onlyInPbfCityBbox_first30: onlyPbf.slice(0, 30),
    tagMismatch_first20: tagMismatches.slice(0, 20),
  },
  sampleEmit,
  verdictHints: {
    citySubsetOfPbfCityBbox: onlyFixture.length === 0,
    recallVsCity: fixtureMap.size === 0 ? null : intersection / fixtureMap.size,
    precisionVsCity: pbfMap.size === 0 ? null : intersection / pbfMap.size,
  },
  note: "If diverges from prior Overpass path — report, do not tune to agree.",
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (args.out) {
  writeFileSync(args.out, text, { encoding: "utf8" });
}
console.log(text);
