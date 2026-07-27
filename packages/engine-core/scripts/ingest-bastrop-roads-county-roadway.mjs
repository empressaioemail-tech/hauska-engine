#!/usr/bin/env node
/**
 * ingest-bastrop-roads-county-roadway.mjs — S2-F: Bastrop_County_Roadway → road-node atoms.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-bastrop-roads-county-roadway
 *
 * Win32 live ArcGIS TLS dead-end: fetch via PowerShell to fixture JSON
 * then ROAD_INTAKE_FIXTURE=path/to.json pnpm ... ingest-bastrop-roads-county-roadway
 *
 * Env:
 *   ROAD_INTAKE_FIXTURE=path/to/county-roadway-export.json  (offline/CI)
 *   ROAD_INGEST_BATCH=100
 *   ROAD_INGEST_LIMIT=N  (0 = all)
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import {
  bastropCountyRoadwayDescriptor,
  emitCountyRoadwayRoadNode,
  parseBastropRoadwayFeature,
} from "../src/road-intake/emit-county-roadway-node.ts";
import { fetchBastropCountyRoadwayFeatures } from "../src/road-intake/fetch-bastrop-county-roadway.ts";

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

const descriptor = bastropCountyRoadwayDescriptor();
const extractedAt = new Date().toISOString();
const t0 = performance.now();

async function loadFeatures() {
  const fixturePath = process.env.ROAD_INTAKE_FIXTURE?.trim();
  if (fixturePath) {
    let rawText = readFileSync(fixturePath, "utf8");
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
    const raw = JSON.parse(rawText);
    const features = (raw.features ?? raw).map((f) => ({
      objectId: Number(f.objectId ?? f.attributes?.objectid),
      attributes: f.attributes ?? {},
      centerline:
        f.centerline ??
        f.geometry?.paths?.[0]?.map(([x, y]) => [Number(x), Number(y)]) ??
        [],
    }));
    return { features, source: "fixture", fetchMs: 0, pagesFetched: 0 };
  }
  const fetched = await fetchBastropCountyRoadwayFeatures();
  return {
    features: fetched.features,
    source: "arcgis-live",
    fetchMs: fetched.elapsedMs,
    pagesFetched: fetched.pagesFetched,
  };
}

const loaded = await loadFeatures();
let features = loaded.features;
if (ingestLimit > 0) {
  features = features.slice(0, ingestLimit);
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
      provenanceKind: atom.row.provenance.kind,
      countyOwner:
        atom.row.provenance.kind === "county-roadway-authoritative"
          ? atom.row.provenance.countyOwner
          : null,
      atomDid: atom.atomDid,
    });
  }
  batch = [];
}

for (const feature of features) {
  const obs = parseBastropRoadwayFeature(feature, extractedAt);
  if (!obs) continue;
  batch.push(emitCountyRoadwayRoadNode(descriptor, obs));
  if (batch.length >= writeBatch) {
    await flushBatch();
  }
}
await flushBatch();

const elapsedMs = Math.round(performance.now() - t0);
const report = {
  event: "S2F-county-roadway-ingest.done",
  sprint: "S2-F-bastrop-county-roadway",
  countyFips: descriptor.countyFips,
  source: loaded.source,
  arcgisFetchMs: loaded.fetchMs,
  pagesFetched: loaded.pagesFetched ?? null,
  segmentsParsed: features.length,
  ingested: emitted.length,
  elapsedMs,
  sample: emitted.slice(0, 3),
  cityOwnedSample: emitted.find((e) => e.countyOwner === "City") ?? null,
  tallyHint:
    "SELECT count(*) FILTER (WHERE body->'row'->'provenance'->>'kind'='county-roadway-authoritative') AS roadway_auth, count(*) FILTER (WHERE body->'row'->'provenance'->>'kind'='county-roadway-undefined') AS roadway_undef, count(*) FILTER (WHERE body->'row'->'provenance'->>'kind'='county-surveyed-2016') AS surveyed, count(*) FILTER (WHERE body->'row'->'provenance'->>'kind'='approximate-assumed-per-class') AS osm, count(*) AS total FROM atoms WHERE entity_type='road-node' AND body->>'countyFips'='48021';",
};

console.log(JSON.stringify(report, null, 2));

if (emitted.length === 0) {
  console.error("FATAL: no county roadway road nodes ingested.");
  process.exit(1);
}

await handle.close();
