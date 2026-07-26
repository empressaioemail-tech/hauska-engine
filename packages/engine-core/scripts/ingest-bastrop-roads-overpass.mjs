#!/usr/bin/env node
/**
 * ingest-bastrop-roads-overpass.mjs — R4: live Overpass bbox → road-node atoms (27c WDLL 7).
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-bastrop-roads-overpass
 *
 * Offline / CI fixture fallback:
 *   ROAD_INTAKE_FIXTURE=path/to/overpass-export.json \
 *     pnpm --filter @hauska-engine/engine-core run ingest-bastrop-roads-overpass
 *
 * Env:
 *   BASTROP_ROAD_INGEST_SCOPE=city|county|county-tiled  (default city — full BASTROP_CITY_BBOX)
 *   BASTROP_ROAD_BBOX=south,west,north,east             (optional override)
 *   ROAD_INGEST_BATCH=100                               (write batch size)
 *   ROAD_INGEST_LIMIT=N                                 (cap ways ingested; 0 = all)
 *
 * Win32 live Overpass TLS dead-end: fetch via scripts/fetch-bastrop-overpass-fixture.ps1
 * then ROAD_INTAKE_FIXTURE=path/to.json pnpm ... ingest-bastrop-roads-overpass
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import {
  bastropRoadIntakeDescriptor,
  emitRoadNode,
  parseOsmWayElement,
} from "../src/road-intake/index.ts";
import {
  fetchBastropRoadsForIngest,
  resolveBastropRoadIngestBbox,
} from "../src/road-intake/fetch-overpass-bbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(HERE, "../src/road-intake/fixtures/bastrop-road-pilot.json");

if (process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for road-node writes.");
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}

const writeBatch = Math.max(1, Number(process.env.ROAD_INGEST_BATCH || 100));
const ingestLimit = Number(process.env.ROAD_INGEST_LIMIT || 0);

const descriptor = bastropRoadIntakeDescriptor();
const extractedAt = new Date().toISOString();
const t0 = performance.now();

async function loadElements() {
  const fixturePath = process.env.ROAD_INTAKE_FIXTURE?.trim();
  if (fixturePath) {
    let rawText = readFileSync(fixturePath, "utf8");
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
    const raw = JSON.parse(rawText);
    return { elements: raw.elements ?? [], source: "fixture", fetchMs: 0, bbox: null };
  }
  const resolved = resolveBastropRoadIngestBbox();
  const fetched = await fetchBastropRoadsForIngest();
  return {
    elements: fetched.elements,
    source: "overpass-live",
    fetchMs: fetched.elapsedMs,
    bbox: fetched.bbox,
    scope: fetched.scope ?? resolved.scope,
    tilesFetched: fetched.tilesFetched ?? null,
  };
}

const loaded = await loadElements();
let elements = loaded.elements;
if (ingestLimit > 0) {
  elements = elements.slice(0, ingestLimit);
}

const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
const emitted = [];
let batch = [];

async function flushBatch() {
  if (batch.length === 0) return;
  await handle.storage.writeRoadAtomsBatch(batch);
  for (const atom of batch) {
    emitted.push({
      roadNodeId: atom.roadNodeId,
      displayName: atom.displayName ?? null,
      atomDid: atom.atomDid,
    });
  }
  batch = [];
}

for (const element of elements) {
  const obs = parseOsmWayElement(element, extractedAt);
  if (!obs) continue;
  batch.push(emitRoadNode(descriptor, obs));
  if (batch.length >= writeBatch) {
    await flushBatch();
  }
}
await flushBatch();

const elapsedMs = Math.round(performance.now() - t0);
const report = {
  event: "R4-road-ingest.done",
  sprint: "R4-bastrop-roads",
  countyFips: descriptor.countyFips,
  source: loaded.source,
  bbox: loaded.bbox,
  scope: loaded.scope ?? null,
  tilesFetched: loaded.tilesFetched ?? null,
  overpassFetchMs: loaded.fetchMs,
  waysParsed: elements.length,
  ingested: emitted.length,
  elapsedMs,
  tallyHint:
    "SELECT count(*) FROM atoms WHERE entity_type='road-node' AND body->>'roadNodeId' LIKE '48021:road:%';",
};

console.log(JSON.stringify(report, null, 2));

if (emitted.length === 0) {
  console.error("FATAL: no road nodes ingested.");
  process.exit(1);
}

await handle.close();
