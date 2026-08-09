#!/usr/bin/env node
/**
 * Simulate PBF apply against live Bastrop road inventory (F5 H5 checkpoint).
 * READ-ONLY: SELECT only on atoms; no INSERT/UPDATE/DELETE. Writes a local JSON report.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  emitRoadNode,
  parseOsmWayElement,
  roadIntakeDescriptorFromCountyRegistry,
} from "../src/road-intake/index.ts";
import {
  decideRoadSupersede,
  ROAD_ADAPTERS_PROTECTED_FROM_PBF,
  ROAD_PBF_SOURCE_ADAPTER,
} from "../src/road-intake/road-supersede.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(HERE, "../../../.tmp-f5-bastrop-supersede");
mkdirSync(outDir, { recursive: true });

const { resolveSubstrateDatabaseUrl } = await import("@hauska-engine/storage");
const url = resolveSubstrateDatabaseUrl();
if (!url) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}

const sql = postgres(url, { max: 2, max_lifetime: 60 });

const rows = await sql`
  SELECT atom_did, body->>'sourceAdapter' AS source_adapter, body->>'roadNodeId' AS road_node_id
  FROM atoms
  WHERE entity_type = 'road-node'
    AND body->>'countyFips' = '48021'
    AND COALESCE(body->>'status', 'active') = 'active'
`;

const inventory = {
  totalActive48021: rows.length,
  byAdapter: {},
  protected7249Adapters: {
    "road-intake-osm-overpass": 0,
    "road-intake-elgin-osm": 0,
  },
  protectedAllPbfAdapters: 0,
};

for (const row of rows) {
  const adapter = String(row.source_adapter ?? "unknown");
  inventory.byAdapter[adapter] = (inventory.byAdapter[adapter] ?? 0) + 1;
  if (adapter === "road-intake-osm-overpass") {
    inventory.protected7249Adapters["road-intake-osm-overpass"] += 1;
  }
  if (adapter === "road-intake-elgin-osm") {
    inventory.protected7249Adapters["road-intake-elgin-osm"] += 1;
  }
  if (ROAD_ADAPTERS_PROTECTED_FROM_PBF.has(adapter)) {
    inventory.protectedAllPbfAdapters += 1;
  }
}

const descriptor = roadIntakeDescriptorFromCountyRegistry({
  countyFips: "48021",
  countyName: "Bastrop County",
});

const sampleWay = parseOsmWayElement(
  {
    type: "way",
    id: 999000001,
    tags: { highway: "residential", name: "Simulated PBF Way" },
    geometry: [
      { lon: -97.32, lat: 30.12 },
      { lon: -97.31, lat: 30.13 },
    ],
  },
  new Date().toISOString(),
);
if (!sampleWay) {
  console.error("FATAL: sample way parse failed");
  process.exit(1);
}
const incoming = emitRoadNode(descriptor, sampleWay);

let wouldSkip = 0;
let wouldUpsert = 0;
let wouldSkip7249 = 0;
let wouldUpsert7249 = 0;
const upsertViolations = [];

for (const row of rows) {
  const adapter = String(row.source_adapter);
  const d = decideRoadSupersede(
    { sourceAdapter: incoming.sourceAdapter, versionStamp: incoming.versionStamp },
    {
      atomDid: row.atom_did,
      sourceAdapter: adapter,
      versionStamp: undefined,
      status: "active",
    },
  );
  if (ROAD_ADAPTERS_PROTECTED_FROM_PBF.has(adapter)) {
    if (d.action === "skip-protected") wouldSkip += 1;
    else {
      wouldUpsert += 1;
      upsertViolations.push({ atomDid: row.atom_did, adapter, action: d.action });
    }
  }
  if (adapter === "road-intake-osm-overpass" || adapter === "road-intake-elgin-osm") {
    if (d.action === "skip-protected") wouldSkip7249 += 1;
    else wouldUpsert7249 += 1;
  }
}

const protected7249 =
  inventory.protected7249Adapters["road-intake-osm-overpass"] +
  inventory.protected7249Adapters["road-intake-elgin-osm"];

const report = {
  event: "f5.bastrop-supersede-simulation",
  readOnly: true,
  sqlOperations: ["SELECT atom_did, source_adapter, road_node_id FROM atoms WHERE ..."],
  incomingAdapter: ROAD_PBF_SOURCE_ADAPTER,
  inventory,
  simulation: {
    protected7249Rows: protected7249,
    wouldSkip7249: wouldSkip7249,
    wouldUpsert7249: wouldUpsert7249,
    protectedAllPbfRows: inventory.protectedAllPbfAdapters,
    wouldSkipAllProtected: wouldSkip,
    wouldUpsertAllProtected: wouldUpsert,
    upsertViolations,
    pass7249: wouldUpsert7249 === 0 && wouldSkip7249 === protected7249,
    passAllProtected: wouldUpsert === 0 && wouldSkip === inventory.protectedAllPbfAdapters,
  },
};

writeFileSync(join(outDir, "bastrop_supersede_simulation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await sql.end({ timeout: 5 });

if (!report.simulation.pass7249 || !report.simulation.passAllProtected) process.exit(1);
