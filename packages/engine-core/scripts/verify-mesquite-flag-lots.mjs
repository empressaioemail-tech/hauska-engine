#!/usr/bin/env node
/** Live verify Mesquite flag lots 48021:80577 / 80578 edge roles after refresh. */
import postgres from "postgres";
import { roadAtomBodyToWarmSource } from "../src/boundary-primitive/index.ts";
import { loadParcelAdjacencyIndexFromNeon } from "../src/boundary-primitive/load-parcel-index.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { prepareBoundaryEdgesForExport } from "../src/site-plan/prepare-boundary-edges-for-export.ts";

const PARCELS = ["48021:80577", "48021:80578"];
const COUNTY_FIPS = "48021";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });
const txSql = postgres(process.env.TXGIO_DATABASE_URL ?? process.env.DATABASE_URL, { ssl: "require" });

async function verifyOne(parcelNodeId) {
  const adjacencyIndex = await loadParcelAdjacencyIndexFromNeon(txSql, COUNTY_FIPS);
  const entry = adjacencyIndex.entries.get(parcelNodeId);
  if (!entry) return { parcelNodeId, error: "not in adjacency index" };
  const ring = entry.ring;

  const storedRows = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'parcelNodeId' = ${parcelNodeId}
      AND COALESCE(body->>'status','active') = 'active'
    ORDER BY (body->>'edgeIndex')::int
  `;
  const storedEdges = storedRows.map((r) => r.body);

  const srRow = await sql`
    SELECT body FROM atoms WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' = ${parcelNodeId}
      AND COALESCE(body->>'status','active') = 'active'
    ORDER BY body->>'fetchedAt' DESC LIMIT 1
  `;
  const setbackRule = srRow[0]?.body ?? null;

  const roadRows = await sql`
    SELECT body FROM atoms WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${COUNTY_FIPS}
      AND COALESCE(body->>'status','active') = 'active'
  `;
  const warmRoads = roadRows.map((r) => roadAtomToWarmSource(r.body) ?? roadAtomBodyToWarmSource(r.body)).filter(Boolean);

  const beforeFront = storedEdges.find((e) => e.role === "front")?.edgeIndex;
  const beforeRear = storedEdges.find((e) => e.role === "rear")?.edgeIndex;

  const prepared = await prepareBoundaryEdgesForExport({
    parcelNodeId,
    storedEdges,
    ringWgs84: ring,
    roads: warmRoads,
    situsAddress: entry.situsAddress,
    setback: setbackRule,
  });

  const refreshed = prepared.edges ?? [];
  const afterFront = refreshed.find((e) => e.role === "front")?.edgeIndex;
  const afterRear = refreshed.find((e) => e.role === "rear")?.edgeIndex;

  return {
    parcelNodeId,
    situs: entry.situsAddress,
    before: { front: beforeFront, rear: beforeRear, roles: storedEdges.map((e) => `${e.edgeIndex}:${e.role}`) },
    after: { front: afterFront, rear: afterRear, roles: refreshed.map((e) => `${e.edgeIndex}:${e.role}`) },
    flags: {
      recomputed: prepared.recomputedForRingWinding,
      relabeled: prepared.relabeledFromRoads,
      valuesRefreshed: prepared.setbackValuesRefreshed,
    },
    roleChanged: beforeFront !== afterFront || beforeRear !== afterRear,
  };
}

async function main() {
  const results = [];
  for (const p of PARCELS) results.push(await verifyOne(p));
  console.log(JSON.stringify(results, null, 2));
  await sql.end();
  await txSql.end();
}

main().catch((e) => { console.error(e); process.exit(2); });
