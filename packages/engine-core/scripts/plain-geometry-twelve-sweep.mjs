#!/usr/bin/env node
/**
 * Saga closing-method plain geometry sweep:
 * envelope-edge midpoint → nearest txgio parcel-edge distance, local metric frame.
 * Independent of block13-cert-grade / R32 index-matched path.
 */
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const engineCore = "P:/hauska-engine/packages/engine-core";
const { projectRing, metersToFeet, openRing } = await import(
  pathToFileURL(path.join(engineCore, "src/depth-warm/geometry.ts")).href
);
const { exteriorRingFromGeoJson } = await import(
  pathToFileURL(path.join(engineCore, "src/boundary-primitive/adjacency-grid.ts")).href
);

/** Project ring vertices into an existing parcel frame (metres) — same frame for both rings. */
function projectRingInFrame(ring, frame) {
  const open = openRing(ring);
  if (!open.length) return null;
  return open.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

const TOL_FT = 1.6;
const SF1_SETBACKS_FT = [5, 15, 25];

function minDistPointToRingEdgesM(p, ringPts) {
  let best = Infinity;
  const n = ringPts.length;
  for (let i = 0; i < n; i++) {
    const a = ringPts[i];
    const b = ringPts[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let cx, cy;
    if (len2 < 1e-12) {
      cx = a.x;
      cy = a.y;
    } else {
      let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      cx = a.x + t * abx;
      cy = a.y + t * aby;
    }
    best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
  }
  return best;
}

function nearestSetbackMember(measuredFt, members) {
  let best = members[0];
  let bestDelta = Math.abs(measuredFt - best);
  for (const m of members) {
    const d = Math.abs(measuredFt - m);
    if (d < bestDelta) {
      bestDelta = d;
      best = m;
    }
  }
  return { member: best, deltaFt: bestDelta };
}

function ringMidpointM(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const propIds = readFileSync("P:/doc_repo/_inbox/2026-08-06_T1_operator_twelve_prop_ids.txt", "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^\d+$/.test(l));

const atomsSql = postgres(process.env.DATABASE_URL, { max: 1 });
const txSql = postgres(process.env.TXGIO_DATABASE_URL, { max: 1 });

const results = {};

for (const propId of propIds) {
  const parcelNodeId = `48021:${propId}`;
  const [txRow] = await txSql`
    SELECT geometry FROM txgio_parcel
    WHERE county_fips = '48021' AND prop_id = ${propId}
    ORDER BY ingested_at DESC NULLS LAST
    LIMIT 1
  `;
  const txRing = txRow?.geometry ? exteriorRingFromGeoJson(txRow.geometry) : null;
  if (!txRing?.length) {
    results[parcelNodeId] = { error: "no-txgio-ring" };
    continue;
  }

  const [envRow] = await atomsSql`
    SELECT body FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
      AND COALESCE(body->>'status', 'active') = 'active'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `;
  const envCoords = envRow?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
  if (!envCoords?.length) {
    results[parcelNodeId] = { error: "no-envelope-geojson" };
    continue;
  }

  const parcelRing = openRing(txRing);
  const envRing = openRing(envCoords);
  const parcelProj = projectRing(parcelRing);
  if (!parcelProj) {
    results[parcelNodeId] = { error: "degenerate-parcel-ring" };
    continue;
  }
  const envPoints = projectRingInFrame(envRing, parcelProj);
  if (!envPoints?.length) {
    results[parcelNodeId] = { error: "degenerate-envelope-ring" };
    continue;
  }

  const edgeFt = [];
  let allPass = true;
  const n = envPoints.length;
  for (let i = 0; i < n; i++) {
    const a = envPoints[i];
    const b = envPoints[(i + 1) % n];
    const mid = ringMidpointM(a, b);
    const distM = minDistPointToRingEdgesM(mid, parcelProj.points);
    const measuredFt = Number(metersToFeet(distM).toFixed(1));
    const { member, deltaFt } = nearestSetbackMember(measuredFt, SF1_SETBACKS_FT);
    const pass = deltaFt <= TOL_FT;
    if (!pass) allPass = false;
    edgeFt.push({ edgeIndex: i, measuredFt, nearestMember: member, deltaFt: Number(deltaFt.toFixed(2)), pass });
  }

  results[parcelNodeId] = {
    apn: propId,
    edgeCount: edgeFt.length,
    insetFeetSlash: edgeFt.map((e) => e.measuredFt).join("/"),
    edges: edgeFt,
    allEdgesWithin1_6ft: allPass,
    pass: allPass,
  };
}

const passCount = Object.values(results).filter((r) => r.pass).length;
const out = {
  when: new Date().toISOString(),
  instrument: "saga-closing-method",
  method: "envelope-edge midpoint to nearest txgio parcel edge, local equirectangular metric (single parcel frame via projectRing + projectRingInFrame)",
  toleranceFt: TOL_FT,
  setbackMembersFt: SF1_SETBACKS_FT,
  rosterSize: propIds.length,
  pass: passCount,
  fail: propIds.length - passCount,
  label: `${passCount}/${propIds.length}`,
  parcels: results,
  defectNote: "Prior _inbox/2026-08-07_T1_bastrop_plain_geometry_sweep.json used block13 R32 cert-grade — wrong instrument.",
};

writeFileSync("P:/doc_repo/_inbox/2026-08-08_T1_plain_geometry_twelve_saga_method.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ label: out.label, pass: out.pass, fail: out.fail }, null, 2));

await atomsSql.end({ timeout: 5 });
await txSql.end({ timeout: 5 });
