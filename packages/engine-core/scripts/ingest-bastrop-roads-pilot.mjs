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

// GUARD (2026-07-28): this script ALWAYS reads fixture input. A fixture road
// (the fixture "Spring Street" way) was once seeded into the PRODUCTION
// store by running this against a live DATABASE_URL, poisoning frontage /
// front-edge anchors. Fixture input never writes to a non-local database
// unless ALLOW_FIXTURE_INGEST=1 is set explicitly.
function isLocalDatabaseUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
if (!isLocalDatabaseUrl(substrateUrl) && process.env.ALLOW_FIXTURE_INGEST !== "1") {
  console.error(
    "FATAL: refusing to ingest FIXTURE road data into a non-local database. " +
      "This pilot script always reads fixture input; pointing it at a live DATABASE_URL " +
      "seeds fake roads into production (the 2026-07 fixture Spring Street incident). " +
      "Set ALLOW_FIXTURE_INGEST=1 only if you are deliberately seeding a non-local sandbox.",
  );
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
