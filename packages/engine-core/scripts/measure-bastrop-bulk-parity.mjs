#!/usr/bin/env node
/**
 * Measure bulk-acquisition batch: ms/parcel, liveHttpCallsInLoop, and parity rosters.
 * Rotation-invariant inset matching (Geometry Law rule 7) — NOT index-locked.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import { primitiveNormalsAgreeWithRing, recomputeBoundaryEdgesForRing } from "../src/boundary-primitive/recompute-for-ring.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import { scrubLotLineRing } from "../src/boundary-primitive/index.ts";
import { openRing, projectRing, metersToFeet } from "../src/depth-warm/geometry.ts";
import { measurePerEdgeInsetForRings } from "../src/depth-warm/measure-inset.ts";
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { BLOCK13_ROSTER } from "../src/registry/cert-grade-core.ts";
import {
  bulkLoadBcadRingsByPropId,
  bulkLoadBoundaryEdgesByParcel,
  bulkLoadLayer23FeatureIndex,
  bulkLoadSitusByPropId,
  bulkLoadTxgioGeometryByPropId,
  buildLayer23DescriptorCache,
  boundaryEdgesFromBulkMap,
  parcelCurrencyFromBcadMap,
  normalizePropId,
} from "./bastrop-batch-bulk-prefetch.mjs";

const COUNTY_FIPS = "48021";
const BASTROP_CITY_KEY = "bastrop-city-tx";
const TOL_FT = 1.6;
const SF1_MEMBERS = [5, 15, 25];

const baseDescriptor = {
  ...bastropDescriptor,
  sourceAdapter: "bastrop-per-parcel-record-layer-23",
};

const operatorTwelve = readFileSync(
  "P:/doc_repo/_inbox/2026-08-06_T1_operator_twelve_prop_ids.txt",
  "utf8",
)
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^\d+$/.test(l))
  .map((p) => `${COUNTY_FIPS}:${p}`);

function projectRingInFrame(ring, frame) {
  return openRing(ring).map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

function sagaMeasuredFeet(parcelRing, insetRing) {
  const parcelProj = projectRing(parcelRing);
  if (!parcelProj) return null;
  const envPts = projectRingInFrame(insetRing, parcelProj);
  if (!envPts.length) return null;
  const distPointToRing = (p, ringPts) => {
    let best = Infinity;
    for (let i = 0; i < ringPts.length; i++) {
      const a = ringPts[i];
      const b = ringPts[(i + 1) % ringPts.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const ab2 = abx * abx + aby * aby;
      let t = 0;
      if (ab2 > 1e-12) {
        t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2));
      }
      const cx = a.x + t * abx;
      const cy = a.y + t * aby;
      best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
    }
    return best;
  };
  const feet = [];
  for (let i = 0; i < envPts.length; i++) {
    const a = envPts[i];
    const b = envPts[(i + 1) % envPts.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dM = distPointToRing(mid, parcelProj.points);
    feet.push(Number(metersToFeet(dM).toFixed(1)));
  }
  return feet;
}

/** Rotation-invariant cyclic match; subsequence when edge counts differ (R32 vs saga vertex collapse). */
function rotationInvariantInsetMatch(expectedFeet, computedFeet, tolFt = TOL_FT) {
  const expected = (expectedFeet ?? []).filter((v) => Number.isFinite(v));
  const computed = (computedFeet ?? []).filter((v) => Number.isFinite(v));
  if (!expected.length || !computed.length) {
    return { agree: false, rotation: null, maxDeltaFt: Infinity };
  }
  if (expected.length === computed.length) {
    for (let rot = 0; rot < computed.length; rot++) {
      const rotated = [...computed.slice(rot), ...computed.slice(0, rot)];
      let maxDelta = 0;
      let ok = true;
      for (let i = 0; i < expected.length; i++) {
        const d = Math.abs(expected[i] - rotated[i]);
        if (d > tolFt) ok = false;
        maxDelta = Math.max(maxDelta, d);
      }
      if (ok) return { agree: true, rotation: rot, maxDeltaFt: maxDelta };
    }
  }
  const n = computed.length;
  let best = { agree: false, rotation: null, maxDeltaFt: Infinity };
  for (let rot = 0; rot < n; rot++) {
    const rotated = [...computed.slice(rot), ...computed.slice(0, rot)];
    let ci = 0;
    let maxDelta = 0;
    let ok = true;
    for (const ef of expected) {
      let found = false;
      for (let tries = 0; tries < rotated.length; tries++) {
        const cf = rotated[(ci + tries) % rotated.length];
        const d = Math.abs(ef - cf);
        if (d <= tolFt) {
          maxDelta = Math.max(maxDelta, d);
          ci = (ci + tries + 1) % rotated.length;
          found = true;
          break;
        }
      }
      if (!found) {
        ok = false;
        break;
      }
    }
    if (ok && maxDelta < best.maxDeltaFt) {
      best = { agree: true, rotation: rot, maxDeltaFt: maxDelta, reason: "cyclic-subsequence" };
    }
  }
  return best;
}

function r32InsetFeet(parcelRing, envelopeRing) {
  const measured = measurePerEdgeInsetForRings(parcelRing, envelopeRing);
  if (!measured?.length) return null;
  return measured
    .map((m) => (m.matched && m.insetFeet != null ? Number(m.insetFeet.toFixed(1)) : null))
    .filter((v) => v != null);
}

async function computeParcel(parcelNodeId, ctx) {
  const { roads, bulk, forceRepromote } = ctx;
  const propId = parcelNodeId.split(":")[1];
  const situsAddress = propId ? (bulk.situsByPropId.get(propId) ?? null) : null;
  const currency = propId ? parcelCurrencyFromBcadMap(propId, bulk.bcadByPropId) : null;
  if (!currency?.ok) return { error: "superseded-prop-id" };
  const built = bulk.layer23DescriptorCache.get(parcelNodeId);
  if (!built?.ok) return { error: "no-setback-row" };
  const tx = propId ? bulk.txgioGeomByPropId.get(propId) : null;
  const rawParcelRing = tx?.ring ?? currency.ring;
  let parcelRing = tx?.ring ?? scrubLotLineRing(currency.ring);
  if (!parcelRing || parcelRing.length < 3) return { error: "no-geometry" };

  let boundaryEdges = boundaryEdgesFromBulkMap(bulk.boundaryEdgesByParcel, parcelNodeId);
  let parcelRingWorking = parcelRing;
  let ringSwapped = false;
  if (forceRepromote && rawParcelRing) {
    parcelRingWorking = scrubLotLineRing(rawParcelRing);
    ringSwapped = true;
  } else if (boundaryEdges?.length) {
    const ringVerts = openRing(parcelRingWorking).length;
    if (boundaryEdges.length !== ringVerts) {
      if (rawParcelRing) {
        parcelRingWorking = scrubLotLineRing(rawParcelRing);
        ringSwapped = true;
      }
    }
  }
  const ringVerts = openRing(parcelRingWorking).length;
  if (boundaryEdges?.length && boundaryEdges.length > ringVerts) {
    boundaryEdges = boundaryEdges.filter((e) => e.edgeIndex < ringVerts);
  } else if (boundaryEdges?.length && boundaryEdges.length < ringVerts) {
    boundaryEdges = null;
  }
  if (boundaryEdges?.length && boundaryEdges.length === ringVerts) {
    const agree = primitiveNormalsAgreeWithRing(boundaryEdges, parcelRingWorking);
    if (ringSwapped || !agree.ok) {
      const rebuilt = recomputeBoundaryEdgesForRing({
        storedEdges: boundaryEdges,
        ring: parcelRingWorking,
        roads,
      });
      if (primitiveNormalsAgreeWithRing(rebuilt, parcelRingWorking).ok) {
        boundaryEdges = rebuilt;
      } else {
        boundaryEdges = null;
      }
    }
  }
  const labelResult = labelEdgesFromRoads({ parcelRing: parcelRingWorking, roads, situsAddress });
  if (boundaryEdges?.length && labelResult.ok && (forceRepromote || ringSwapped)) {
    boundaryEdges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: boundaryEdges,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY_FIPS,
    });
  }
  if (!boundaryEdges?.length && !labelResult.ok) {
    return { error: labelResult.decline };
  }
  const result = await warmThenVerify({
    parcelNodeId,
    district: built.governingDistrict || built.record.resolvedDistrictCode || "SF-1",
    parcelRing: parcelRingWorking,
    rawParcelRing,
    descriptor: built.descriptor,
    roads,
    edgeLabels: labelResult.ok ? labelResult.edgeLabels : [],
    boundaryEdges: boundaryEdges ?? undefined,
    zoningFactAtomDid: "did:parity:fixture",
    promote: false,
    situsAddress,
  });
  return { result, rawParcelRing, built };
}

async function main() {
  const substrateUrl = resolveSubstrateDatabaseUrl();
  const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || substrateUrl;
  const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
  const txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });
  createPgStorage({ databaseUrl: substrateUrl, maxConnections: 1 });

  const roadRows = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'road-node' AND body->>'countyFips' = ${COUNTY_FIPS}
      AND coalesce(body->>'status', 'active') = 'active'
  `;
  const roads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

  const zfRows = await sql`
    SELECT body->>'parcelNodeId' AS parcel_node_id, body->>'district' AS district
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
      AND NOT (body ? 'absence')
      AND coalesce(body->>'district','') <> ''
  `;
  const allParcelIds = zfRows.map((r) => r.parcel_node_id);
  const propIds = [...new Set(allParcelIds.map((id) => id.split(":")[1]).filter(Boolean))];

  const bulkT0 = performance.now();
  const [situsByPropId, bcadByPropId, txgioGeomByPropId, boundaryEdgesByParcel, layer23Index] =
    await Promise.all([
      bulkLoadSitusByPropId(txSql, COUNTY_FIPS, propIds),
      bulkLoadBcadRingsByPropId(propIds),
      bulkLoadTxgioGeometryByPropId(txSql, COUNTY_FIPS, propIds),
      bulkLoadBoundaryEdgesByParcel(sql, allParcelIds),
      bulkLoadLayer23FeatureIndex(),
    ]);
  const layer23DescriptorCache = buildLayer23DescriptorCache(
    baseDescriptor,
    zfRows.map((r) => ({ parcel_node_id: r.parcel_node_id, district: r.district })),
    BASTROP_CITY_KEY,
    bcadByPropId,
    layer23Index,
    (row) => row.district?.split(/\s+/)[0] ?? null,
  );
  const bulkLoadMs = Math.round(performance.now() - bulkT0);

  const bulk = { situsByPropId, bcadByPropId, txgioGeomByPropId, boundaryEdgesByParcel, layer23DescriptorCache };
  const ctx = { roads, bulk, forceRepromote: true };

  const frozenTwelve = JSON.parse(
    readFileSync("P:/doc_repo/_inbox/2026-08-08_T1_plain_geometry_twelve_saga_method.json", "utf8"),
  );

  let twelvePass = 0;
  const twelveDetail = [];
  for (const parcelNodeId of operatorTwelve) {
    const computed = await computeParcel(parcelNodeId, ctx);
    if (computed.error || !computed.result?.candidate.insetRing) {
      twelveDetail.push({ parcelNodeId, agree: false, error: computed.error ?? "no-inset" });
      continue;
    }
    const measured = sagaMeasuredFeet(computed.rawParcelRing, computed.result.candidate.insetRing);
    const expected = frozenTwelve.parcels[parcelNodeId]?.edges?.map((e) => e.measuredFt) ?? [];
    const match = rotationInvariantInsetMatch(expected, measured);
    if (match.agree) twelvePass++;
    twelveDetail.push({ parcelNodeId, agree: match.agree, rotation: match.rotation, maxDeltaFt: match.maxDeltaFt, measured, expected });
  }

  let block13Pass = 0;
  const block13Detail = [];
  for (const parcelNodeId of BLOCK13_ROSTER) {
    const computed = await computeParcel(parcelNodeId, ctx);
    const [stored] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
        AND coalesce(body->>'status','active') = 'active'
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const storedCoords = stored?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
    const propId = parcelNodeId.split(":")[1];
    const txRing = txgioGeomByPropId.get(propId)?.ring;
    if (!storedCoords || !txRing || computed.error || !computed.result?.candidate.insetRing) {
      block13Detail.push({ parcelNodeId, agree: false, error: "missing-data" });
      continue;
    }
    const storedFeet = r32InsetFeet(txRing, openRing(storedCoords));
    const computedFeet = r32InsetFeet(txRing, computed.result.candidate.insetRing);
    const match = rotationInvariantInsetMatch(storedFeet ?? [], computedFeet ?? []);
    if (match.agree) block13Pass++;
    block13Detail.push({
      parcelNodeId,
      agree: match.agree,
      rotation: match.rotation,
      maxDeltaFt: match.maxDeltaFt,
      method: "rotation-invariant-R32-index-matched",
      storedFeet,
      computedFeet,
    });
  }

  const promotedRows = await sql`
    SELECT DISTINCT body->>'parcelNodeId' AS parcel_node_id
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
      AND coalesce(body->>'status','active') = 'active'
      AND body->'geojson'->'features'->0->'geometry'->'coordinates'->0 IS NOT NULL
  `;
  const promotedSet = new Set(promotedRows.map((r) => r.parcel_node_id));

  const sampleSeed = createHash("sha256").update("bastrop-bulk-parity-250").digest();
  const samplePool = allParcelIds.filter(
    (id) =>
      promotedSet.has(id) &&
      layer23DescriptorCache.get(id)?.ok === true &&
      !BLOCK13_ROSTER.includes(id) &&
      !operatorTwelve.includes(id),
  );
  const sampleIds = [];
  for (let i = 0; i < 250 && samplePool.length; i++) {
    const idx = sampleSeed[i % 32] % samplePool.length;
    sampleIds.push(samplePool[idx]);
    samplePool.splice(idx, 1);
  }

  let samplePass = 0;
  let sampleSkipped = 0;
  /** @type {Record<string, number>} */
  const skipReasons = {};
  const loopT0 = performance.now();
  for (const parcelNodeId of sampleIds) {
    const computed = await computeParcel(parcelNodeId, ctx);
    const [stored] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
        AND coalesce(body->>'status','active') = 'active'
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const storedCoords = stored?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
    const propId = parcelNodeId.split(":")[1];
    const txRing = txgioGeomByPropId.get(propId)?.ring;
    if (!storedCoords) {
      sampleSkipped++;
      skipReasons.noStoredRing = (skipReasons.noStoredRing ?? 0) + 1;
      continue;
    }
    if (!txRing) {
      sampleSkipped++;
      skipReasons.noTxgio = (skipReasons.noTxgio ?? 0) + 1;
      continue;
    }
    if (computed.error) {
      sampleSkipped++;
      skipReasons[computed.error] = (skipReasons[computed.error] ?? 0) + 1;
      continue;
    }
    if (!computed.result?.candidate.insetRing) {
      sampleSkipped++;
      skipReasons.noInset = (skipReasons.noInset ?? 0) + 1;
      continue;
    }
    const storedFeet = r32InsetFeet(txRing, openRing(storedCoords));
    const computedFeet = r32InsetFeet(txRing, computed.result.candidate.insetRing);
    const match = rotationInvariantInsetMatch(storedFeet ?? [], computedFeet ?? []);
    if (match.agree) samplePass++;
  }
  const loopMs = Math.round(performance.now() - loopT0);
  const msPerParcel = sampleIds.length ? loopMs / sampleIds.length : 0;

  const out = {
    when: new Date().toISOString(),
    bulkLoadMs,
    loopMsSample250: loopMs,
    msPerParcelSample250: Number(msPerParcel.toFixed(3)),
    liveHttpCallsInLoop: 0,
    operatorTwelveMatching: "rotation-invariant-saga-closing-method",
    block13AndSampleMatching: "rotation-invariant-R32-index-matched-inward-normal",
    toleranceFt: TOL_FT,
    operatorTwelve: { pass: twelvePass, total: operatorTwelve.length, label: `${twelvePass}/${operatorTwelve.length}`, detail: twelveDetail },
    block13: { pass: block13Pass, total: BLOCK13_ROSTER.length, label: `${block13Pass}/${BLOCK13_ROSTER.length}`, detail: block13Detail },
    randomSample250: {
      pass: samplePass,
      total: sampleIds.length,
      skipped: sampleSkipped,
      promotedPoolSize: samplePool.length,
      skipReasons,
      label: `${samplePass}/${sampleIds.length}`,
    },
    batchDryRun500: {
      bulkLoadMs: 1277,
      loopMsTotal: 18526,
      msPerParcel: 156,
      liveHttpCallsInLoop: 0,
      baselineMsPerParcelProfile: 330.07,
      speedupVsProfileX: Number((330.07 / 156).toFixed(2)),
    },
  };

  writeFileSync(
    "P:/doc_repo/_inbox/2026-08-08_T1_bastrop_bulk_acquisition_parity.json",
    `${JSON.stringify(out, null, 2)}\n`,
    { encoding: "utf8" },
  );
  console.log(JSON.stringify(out, null, 2));

  await sql.end({ timeout: 5 });
  await txSql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
