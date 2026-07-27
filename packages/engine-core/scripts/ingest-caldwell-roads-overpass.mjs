#!/usr/bin/env node
/**
 * ingest-caldwell-roads-overpass.mjs — RECIPE-PROOF 48055: Lockhart OSM → road-nodes.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-caldwell-roads-overpass
 *
 * Default scope = lockhart-city (CAD city-street population sparse).
 * Win32 TLS: fetch via scripts/fetch-caldwell-overpass-fixture.ps1 then ROAD_INTAKE_FIXTURE=.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import { emitRoadNode, parseOsmWayElement } from "../src/road-intake/emit-road-node.ts";
import { caldwellOsmRoadIntakeDescriptor } from "../src/road-intake/emit-caldwell-cad-road-node.ts";
import {
  fetchCaldwellRoadsForIngest,
  resolveCaldwellRoadIngestBbox,
} from "../src/road-intake/fetch-overpass-bbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(
  HERE,
  "../src/road-intake/fixtures/caldwell-overpass-lockhart-city-bbox.json",
);

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

const descriptor = caldwellOsmRoadIntakeDescriptor();
const extractedAt = new Date().toISOString();
const t0 = performance.now();

async function loadElements() {
  const fixturePath =
    process.env.ROAD_INTAKE_FIXTURE?.trim() ||
    (process.env.ROAD_INTAKE_USE_DEFAULT_FIXTURE === "1" ? DEFAULT_FIXTURE : "");
  if (fixturePath) {
    let rawText = readFileSync(fixturePath, "utf8");
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
    const raw = JSON.parse(rawText);
    return {
      elements: raw.elements ?? [],
      source: "fixture",
      fetchMs: 0,
      bbox: null,
      scope: raw.scope ?? null,
    };
  }
  const resolved = resolveCaldwellRoadIngestBbox();
  const fetched = await fetchCaldwellRoadsForIngest();
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
      classification: atom.classification,
    });
  }
  batch = [];
}

for (const el of elements) {
  const obs = parseOsmWayElement(el, extractedAt);
  if (!obs) continue;
  batch.push(emitRoadNode(descriptor, obs));
  if (batch.length >= writeBatch) await flushBatch();
}
await flushBatch();
if (typeof handle.close === "function") await handle.close();

console.log(
  JSON.stringify(
    {
      event: "ingest-caldwell-roads-overpass.done",
      countyFips: descriptor.countyFips,
      source: loaded.source,
      scope: loaded.scope,
      bbox: loaded.bbox,
      fetchMs: loaded.fetchMs,
      waysSeen: elements.length,
      emitted: emitted.length,
      wallMs: Math.round(performance.now() - t0),
      sample: emitted.slice(0, 5),
    },
    null,
    2,
  ),
);
