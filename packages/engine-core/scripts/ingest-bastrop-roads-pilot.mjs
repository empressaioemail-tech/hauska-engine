#!/usr/bin/env node
/**
 * ingest-bastrop-roads-pilot.mjs — R1 INTAKE: OSM roads → road-node atoms (27c WDLL 3).
 *
 * Fixture mode (CI / offline): ROAD_INTAKE_FIXTURE=path/to.json (default: pilot fixture)
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-bastrop-roads-pilot
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

const descriptor = bastropRoadIntakeDescriptor();
const extractedAt = new Date().toISOString();
const t0 = performance.now();

function loadElements() {
  const fixturePath = process.env.ROAD_INTAKE_FIXTURE?.trim() || DEFAULT_FIXTURE;
  const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
  return raw.elements ?? [];
}

const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 1 });
const elements = loadElements();
const emitted = [];

for (const element of elements) {
  const obs = parseOsmWayElement(element, extractedAt);
  if (!obs) continue;
  const atom = emitRoadNode(descriptor, obs);
  await handle.storage.writeRoadAtom(atom);
  emitted.push({
    roadNodeId: atom.roadNodeId,
    displayName: atom.displayName ?? null,
    atomDid: atom.atomDid,
  });
}

const elapsedMs = Math.round(performance.now() - t0);
const report = {
  sprint: "R1-road-node",
  countyFips: descriptor.countyFips,
  ingested: emitted.length,
  roads: emitted,
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
