// Dump the block13 regression roster's live-resolved grading inputs into a
// repo fixture (2026-08-07, master planner directive: "CRITICAL PROCESS
// ADDITION ... build a block13 OFFLINE fixture ... so the block13
// measurement path runs in CI forever and this class of prod-only
// regression becomes impossible"). READ-ONLY.
//
// For each of the 7 frozen BLOCK13_ROSTER parcels, captures exactly the
// values gradeAgainstKeyResolved (cert-grade-core.ts) needs: ring,
// insetRing, boundaryEdges, zoningFact, setbackRule, situsAddress — plus
// the road-node subset actually within proximity of these parcels (not the
// full county roster, to keep the fixture small).
//
//   DATABASE_URL=... CORTEX_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
//     pnpm --filter @hauska-engine/engine-core exec tsx scripts/dump-block13-offline-fixture.mjs
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { fetchBcadParcelRings, scrubLotLineRing, BASTROP_BCAD_PARCELS_URL } from "../src/boundary-primitive/index.js";
import { BLOCK13_ROSTER } from "../src/registry/cert-grade-core.js";
import { readBoundaryEdgesForParcel, BoundaryPrimitiveMissingError } from "../src/boundary-primitive/read.js";
import { createPgStorage } from "@hauska-engine/storage";
import { openRing, projectRing } from "../src/depth-warm/geometry.js";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.js";

const COUNTY = "48021";
const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1";

const url = resolveSubstrateDatabaseUrl();
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || process.env.CORTEX_DATABASE_URL?.trim() || url;
const sql = postgres(url, { ssl: "require", max: 4, prepare: false });
const txSql = postgres(txgioUrl, { ssl: "require", max: 4, prepare: false });
const storage = createPgStorage({ databaseUrl: url, maxConnections: 2 });

const roadRows = await sql`
  SELECT body FROM atoms WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY}
    AND coalesce(body->>'status', 'active') = 'active'
`;
// Convert to the SAME WarmRoadSource shape block13-cert-grade.mjs builds
// (roadAtomToWarmSource) up front — the fixture stores this final shape
// directly, not raw atom bodies, so the offline test never re-derives the
// conversion and stays byte-faithful to the live path.
const allRoads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

const out = { fixtureVersion: 1, generatedAt: new Date().toISOString(), parcels: {} };
const usedRoadWayIds = new Set();

try {
  for (const parcelNodeId of BLOCK13_ROSTER) {
    const propId = parcelNodeId.split(":")[1];

    const [situsRow] = await txSql`
      SELECT situs_address FROM txgio_parcel
      WHERE county_fips = ${COUNTY} AND prop_id = ${propId} LIMIT 1
    `;
    const situsAddress = situsRow?.situs_address?.trim() ?? null;

    const bcad = await fetchBcadParcelRings([propId], fetch, BASTROP_BCAD_PARCELS_URL, "prop_id");
    const bcadRing = bcad[0]?.ring;
    const ring = bcadRing ? scrubLotLineRing(bcadRing) : null;
    if (!ring) throw new Error(`${parcelNodeId}: no BCAD ring`);

    const [zfRow] = await sql`
      SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const [envRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const insetRing = envRow?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0] ?? null;
    if (!insetRing?.length) throw new Error(`${parcelNodeId}: no promoted envelope geojson`);

    const [srRow] = await sql`
      SELECT body FROM atoms WHERE entity_type = 'setback-rule'
        AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;

    let boundaryEdges = null;
    try {
      boundaryEdges = await readBoundaryEdgesForParcel(storage.storage, parcelNodeId);
    } catch (e) {
      if (!(e instanceof BoundaryPrimitiveMissingError)) throw e;
    }

    // Record which road osmWayIds are actually within proximity of this
    // parcel's ring so the fixture's road subset stays small (not the full
    // ~14k county roster) while remaining faithful to what labelEdgesFromRoads
    // actually sees for these 7 parcels.
    const proj = projectRing(ring);
    if (proj) {
      // Cheap degrees-space bounding-box pre-filter (roughly 400m margin at
      // this latitude) BEFORE any per-point meters-space distance check —
      // the naive O(roads x roadPoints x ringPoints) hypot scan over the
      // full ~14k-road county roster was slow enough to look hung. This
      // keeps the fixture faithful (same 300m proximity test) while making
      // the dump tractable.
      const DEG_MARGIN = 0.004; // ~400m in longitude/latitude degrees at this latitude
      const lons = ring.map((c) => c[0]);
      const lats = ring.map((c) => c[1]);
      const minLon = Math.min(...lons) - DEG_MARGIN;
      const maxLon = Math.max(...lons) + DEG_MARGIN;
      const minLat = Math.min(...lats) - DEG_MARGIN;
      const maxLat = Math.max(...lats) + DEG_MARGIN;

      for (const road of allRoads) {
        if (!road.polyline?.length) continue;
        let bboxNear = false;
        for (const [lng, lat] of road.polyline) {
          if (lng >= minLon && lng <= maxLon && lat >= minLat && lat <= maxLat) {
            bboxNear = true;
            break;
          }
        }
        if (!bboxNear) continue;
        for (const [lng, lat] of road.polyline) {
          const x = (lng - proj.originLng) * proj.mPerDegLng;
          const y = (lat - proj.originLat) * proj.mPerDegLat;
          const near = proj.points.some((p) => Math.hypot(p.x - x, p.y - y) < 300);
          if (near) {
            usedRoadWayIds.add(road.osmWayId);
            break;
          }
        }
      }
    }

    out.parcels[parcelNodeId] = {
      situsAddress,
      ring,
      insetRing,
      zoningFact: zfRow?.body ?? null,
      setbackRule: srRow?.body ?? null,
      boundaryEdges: boundaryEdges ? boundaryEdges.map((e) => ({ ...e })) : null,
    };
    console.error(`${parcelNodeId}: captured (ring ${openRing(ring).length}v, boundaryEdges ${boundaryEdges?.length ?? 0})`);
  }

  out.roads = allRoads.filter((r) => usedRoadWayIds.has(r.osmWayId));
  console.error(`roads: ${out.roads.length} of ${allRoads.length} converted WarmRoadSource roads kept (proximity-filtered)`);
} finally {
  await sql.end();
  await txSql.end();
}

const outPath = new URL("../src/registry/__fixtures__/block13-offline.json", import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.error(`wrote ${outPath.pathname}`);
