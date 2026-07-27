#!/usr/bin/env node
/**
 * ingest-caldwell-roads-cad.mjs — RECIPE-PROOF 48055: Caldwell CAD Road_Centerlines → road-nodes.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-caldwell-roads-cad
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import {
  caldwellCadRoadIntakeDescriptor,
  emitCaldwellCadRoadNode,
  parseCaldwellCadRoadFeature,
} from "../src/road-intake/emit-caldwell-cad-road-node.ts";
import { fetchCaldwellCadRoadFeatures } from "../src/road-intake/fetch-caldwell-cad-roads.ts";
import { caldwellCadIsAuthoritative } from "../src/road-intake/classify-caldwell-cad.ts";

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

const descriptor = caldwellCadRoadIntakeDescriptor();
const extractedAt = new Date().toISOString();
const t0 = performance.now();

async function loadFeatures() {
  const fixturePath = process.env.ROAD_INTAKE_FIXTURE?.trim();
  if (fixturePath) {
    let rawText = readFileSync(fixturePath, "utf8");
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
    const raw = JSON.parse(rawText);
    const features = (raw.features ?? raw).map((f) => ({
      objectId: Number(f.objectId ?? f.attributes?.OBJECTID ?? f.attributes?.objectid),
      attributes: f.attributes ?? {},
      centerline:
        f.centerline ??
        f.geometry?.paths?.[0]?.map(([x, y]) => [Number(x), Number(y)]) ??
        [],
    }));
    return { features, source: "fixture", fetchMs: 0, pagesFetched: 0 };
  }
  const fetched = await fetchCaldwellCadRoadFeatures();
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
let auth = 0;
let undef = 0;

async function flushBatch() {
  if (batch.length === 0) return;
  await handle.storage.writeRoadAtomsBatch(batch);
  for (const atom of batch) {
    emitted.push({
      roadNodeId: atom.roadNodeId,
      displayName: atom.displayName ?? null,
      provenance: atom.row?.provenance?.kind ?? null,
    });
  }
  batch = [];
}

for (const feature of features) {
  const obs = parseCaldwellCadRoadFeature(feature, extractedAt);
  if (!obs) continue;
  if (caldwellCadIsAuthoritative(obs.attributes)) auth += 1;
  else undef += 1;
  batch.push(emitCaldwellCadRoadNode(descriptor, obs));
  if (batch.length >= writeBatch) await flushBatch();
}
await flushBatch();
if (typeof handle.close === "function") await handle.close();

console.log(
  JSON.stringify(
    {
      event: "ingest-caldwell-roads-cad.done",
      countyFips: descriptor.countyFips,
      source: loaded.source,
      fetchMs: loaded.fetchMs,
      pagesFetched: loaded.pagesFetched ?? null,
      featuresSeen: features.length,
      emitted: emitted.length,
      provenanceSplit: {
        "county-roadway-authoritative": auth,
        "county-roadway-undefined": undef,
      },
      wallMs: Math.round(performance.now() - t0),
      sample: emitted.slice(0, 5),
    },
    null,
    2,
  ),
);
