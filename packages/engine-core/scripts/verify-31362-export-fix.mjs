#!/usr/bin/env node
/**
 * Live verify: 48021:31362 export fix (read-only, no persist).
 * Confirms prepareBoundaryEdgesForExport + composeSitePlanModel produce
 * front=south/Higgins, F25/S5/R25, sheet==card setbacks.
 */
import postgres from "postgres";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { prepareBoundaryEdgesForExport } from "../src/site-plan/prepare-boundary-edges-for-export.ts";
import { boundaryEdgesToGeometryInput } from "../src/site-plan/author.ts";
import { loadParcelAdjacencyIndexFromNeon } from "../src/boundary-primitive/load-parcel-index.ts";

const PARCEL_NODE_ID = "48021:31362";
const COUNTY_FIPS = "48021";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });
const txSql = postgres(process.env.TXGIO_DATABASE_URL ?? process.env.DATABASE_URL, { ssl: "require" });

function edgeBearing(ring, edgeIndex) {
  const n = ring.length - 1;
  const [lng1, lat1] = ring[edgeIndex];
  const [lng2, lat2] = ring[(edgeIndex + 1) % n];
  const dx = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dy = lat2 - lat1;
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  if (deg >= 135 && deg < 225) return "south";
  if (deg >= 315 || deg < 45) return "north";
  if (deg >= 45 && deg < 135) return "east";
  return "west";
}

async function main() {
  const adjacencyIndex = await loadParcelAdjacencyIndexFromNeon(txSql, COUNTY_FIPS);
  const entry = adjacencyIndex.entries.get(PARCEL_NODE_ID);
  if (!entry) throw new Error("parcel not in adjacency index");
  const ring = entry.ring;

  const storedRows = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'parcelNodeId' = ${PARCEL_NODE_ID}
      AND COALESCE(body->>'status','active') = 'active'
    ORDER BY (body->>'edgeIndex')::int
  `;
  const storedEdges = storedRows.map((r) => r.body);

  const srRow = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' = ${PARCEL_NODE_ID}
      AND COALESCE(body->>'status','active') = 'active'
    ORDER BY body->>'fetchedAt' DESC LIMIT 1
  `;
  const setbackRule = srRow[0]?.body ?? null;

  const envRow = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${PARCEL_NODE_ID}
      AND COALESCE(body->>'status','active') = 'active'
    ORDER BY body->>'fetchedAt' DESC LIMIT 1
  `;
  const envelope = envRow[0]?.body ?? null;

  const roadRows = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${COUNTY_FIPS}
      AND COALESCE(body->>'status','active') = 'active'
  `;
  const warmRoads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

  console.log("=== BEFORE (stored primitive) ===");
  for (const e of storedEdges) {
    const sb = "kind" in e.setback ? e.setback.kind : e.setback.feet;
    console.log(`edge ${e.edgeIndex} role=${e.role} setback=${sb} sourceAdapter=${e.sourceAdapter}`);
  }

  const prepared = await prepareBoundaryEdgesForExport({
    parcelNodeId: PARCEL_NODE_ID,
    storedEdges,
    ringWgs84: ring,
    roads: warmRoads,
    situsAddress: entry.situsAddress,
    setback: setbackRule,
    notSpecified: null,
  });

  console.log("\n=== AFTER prepareBoundaryEdgesForExport ===");
  console.log(JSON.stringify({
    recomputedForRingWinding: prepared.recomputedForRingWinding,
    relabeledFromRoads: prepared.relabeledFromRoads,
    setbackValuesRefreshed: prepared.setbackValuesRefreshed,
    reason: prepared.reason ?? null,
  }));

  const refreshed = prepared.edges ?? [];
  const frontEdge = refreshed.find((e) => e.role === "front");
  const frontBearing = frontEdge ? edgeBearing(ring, frontEdge.edgeIndex) : "none";

  console.log("\n=== REFRESHED EDGES ===");
  for (const e of refreshed) {
    const sb = "kind" in e.setback ? e.setback.kind : e.setback.feet;
    const bear = edgeBearing(ring, e.edgeIndex);
    console.log(`edge ${e.edgeIndex} (${bear}) role=${e.role} setback=${sb} frontBasis=${e.frontBasis ?? "-"}`);
  }

  const geom = boundaryEdgesToGeometryInput(refreshed);
  const frontSeg = geom.find((g) => g.role === "front");
  const sideSegs = geom.filter((g) => g.role === "side");

  console.log("\n=== CARD vs SHEET SETBACKS ===");
  console.log("card (setback-rule):", setbackRule ? {
    front: setbackRule.front,
    side: setbackRule.side,
    rear: setbackRule.rear,
    sideCorner: setbackRule.sideCornerFt,
    sourceAdapter: setbackRule.sourceAdapter,
  } : null);
  console.log("sheet front insetFeet:", frontSeg?.insetFeet, "setbackAbsent:", frontSeg?.setbackAbsent);
  console.log("sheet side insetFeet (sample):", sideSegs[0]?.insetFeet);
  console.log("front edge compass:", frontBearing, "(expect south for Higgins St)");

  console.log("\n=== BUILDABLE ===");
  console.log("card envelope areaSqFt:", envelope?.outcome?.areaSqFt ?? envelope?.areaSqFt ?? "n/a");
  console.log("card envelope kind:", envelope?.outcome?.kind ?? "n/a");

  const pass =
    frontBearing === "south" &&
    frontSeg &&
    frontSeg.insetFeet === 25 &&
    !frontSeg.setbackAbsent &&
    sideSegs.every((s) => s.insetFeet === 5 && !s.setbackAbsent) &&
    setbackRule?.front === 25;

  console.log("\n=== VERDICT ===", pass ? "PASS" : "FAIL");
  await sql.end();
  await txSql.end();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
