#!/usr/bin/env node
/**
 * depth-warm-elgin-batch.mjs — R4 batch warm→verify→promote with cost instrumentation.
 *
 * Elgin (48021, Bastrop-county side): descriptor-backed setbacks, city bbox from AGOL
 * Elgin_Zoning FeatureServer/0 extent. Road-nodes loaded from existing 48021 county
 * substrate (no ingest-elgin-roads in this PR).
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... TXGIO_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run depth-warm-elgin-batch -- \
 *       --limit=500 [--offset=0] [--promote] [--dry-run] [--city-cohort] \
 *       [--parcel=48021:...] [--force-overwrite] [--force-repromote] \
 *       [--diagnose-failures] [--upsert-ledger]
 *
 * --force-overwrite: re-process already-promoted parcels; on verify-fail or early
 * decline, persist an honest-decline envelope (R27) instead of skipping.
 * Implies --force-repromote (R28 boundary-edge recompute + R30 role re-derive).
 */

import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import elginDescriptor from "../src/property-reasoning/fixtures/descriptors/elgin_tx_descriptor.json" with { type: "json" };
import { resolveSetbackTableRow } from "../src/property-reasoning/emit-setback-rule.ts";
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import {
  readBoundaryEdgesForParcel,
  BoundaryPrimitiveMissingError,
} from "../src/boundary-primitive/read.ts";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../src/boundary-primitive/recompute-for-ring.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import {
  fetchBcadParcelRings,
  scrubLotLineRing,
} from "../src/boundary-primitive/index.ts";
import { openRing, projectRing } from "../src/depth-warm/geometry.ts";
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { ELGIN_CITY_BBOX } from "../src/road-intake/fetch-overpass-bbox.ts";
import { TxgioDatabaseParcelGeometryResolver } from "../src/parcel-terrain/parcel-geometry-resolver.ts";
import {
  bucketVerifyFailReasons,
  promoteHonestVerifyDecline,
} from "../src/depth-warm/honest-decline-promote.ts";
import { upsertCountyFacetLedger } from "./upsert-county-facet-ledger.mjs";

const COUNTY_FIPS = "48021";
const descriptor = elginDescriptor;

const FEET_PER_METER = 3.280839895;
/**
 * PARCEL-RING-SOURCE-DIVERGENCE tolerance (2026-08-07, Serve-Consistency
 * Principle ruling): BCAD (live CAD service) and txgio_parcel (StratMap-
 * derived, the geometry the product renders as the lot line) are
 * independently digitized sources that can drift by several feet on a
 * given parcel. txgio is the truth frame for everything the user sees;
 * BCAD's live ring is a parcel-currency cross-check only.
 */
const PARCEL_RING_SOURCE_DIVERGENCE_TOLERANCE_FT = 2;

/**
 * Max perpendicular deviation between two rings, sampled at every vertex
 * of BOTH rings against the nearest edge of the OTHER ring. Returns feet.
 */
function maxRingDeviationFt(ringA, ringB) {
  const projA = projectRing(ringA);
  if (!projA) return null;
  const toLocal = (ring) =>
    openRing(ring).map(([lng, lat]) => ({
      x: (lng - projA.originLng) * projA.mPerDegLng,
      y: (lat - projA.originLat) * projA.mPerDegLat,
    }));
  const a = toLocal(ringA);
  const b = toLocal(ringB);
  if (a.length < 2 || b.length < 2) return null;

  const distPointToSegment = (p, s0, s1) => {
    const abx = s1.x - s0.x;
    const aby = s1.y - s0.y;
    const apx = p.x - s0.x;
    const apy = p.y - s0.y;
    const ab2 = abx * abx + aby * aby;
    if (ab2 < 1e-12) return Math.hypot(apx, apy);
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
    return Math.hypot(p.x - (s0.x + t * abx), p.y - (s0.y + t * aby));
  };
  const oneSidedMax = (from, to) => {
    let max = 0;
    for (const p of from) {
      let nearest = Infinity;
      for (let i = 0; i < to.length; i++) {
        const d = distPointToSegment(p, to[i], to[(i + 1) % to.length]);
        if (d < nearest) nearest = d;
      }
      if (nearest > max) max = nearest;
    }
    return max;
  };
  const maxM = Math.max(oneSidedMax(a, b), oneSidedMax(b, a));
  return maxM * FEET_PER_METER;
}

function districtHasSetbackRow(district) {
  const row = resolveSetbackTableRow(descriptor.setbackTable, district);
  return !("kind" in row);
}

function parseArgs(argv) {
  const out = {
    limit: 500,
    offset: 0,
    promote: false,
    dryRun: false,
    parcel: null,
    cityCohort: false,
    forceRepromote: false,
    forceOverwrite: false,
    diagnoseFailures: false,
    upsertLedger: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = Number(argv[++i] || 500);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--offset") out.offset = Number(argv[++i] || 0);
    else if (a.startsWith("--offset=")) out.offset = Number(a.slice("--offset=".length));
    else if (a === "--parcel") out.parcel = String(argv[++i] || "").trim();
    else if (a.startsWith("--parcel=")) out.parcel = a.slice("--parcel=".length).trim();
    else if (a === "--promote") out.promote = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--city-cohort") out.cityCohort = true;
    else if (a === "--force-repromote") out.forceRepromote = true;
    else if (a === "--force-overwrite") out.forceOverwrite = true;
    else if (a === "--diagnose-failures") out.diagnoseFailures = true;
    else if (a === "--upsert-ledger") out.upsertLedger = true;
  }
  if (out.forceOverwrite) out.forceRepromote = true;
  return out;
}

/**
 * Leading token; R-4 stays R-4 on atoms. GIS Zone_Code "A" → canonical R-4
 * (ELGIN_REGISTRY_ROW.railPerParcel.districtValueByPrefix maps R-4 → "A").
 */
function normalizeDistrict(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = trimmed.split(/\s+/)[0];
  if (prefix === "A") return "R-4";
  return prefix || trimmed;
}

async function loadCityParcelNodeIds(txSql, bbox) {
  const rows = await txSql`
    SELECT prop_id
    FROM txgio_parcel
    WHERE county_fips = ${COUNTY_FIPS}
      AND (south_lat + north_lat) / 2.0 >= ${bbox.south}
      AND (south_lat + north_lat) / 2.0 <= ${bbox.north}
      AND (west_lng + east_lng) / 2.0 >= ${bbox.west}
      AND (west_lng + east_lng) / 2.0 <= ${bbox.east}
  `;
  return rows.map((r) => `${COUNTY_FIPS}:${r.prop_id}`);
}

function approxUsd(wallMs, atomWrites) {
  const hours = wallMs / 3_600_000;
  return Number((hours * 0.25 * 0.16 + atomWrites * 0.000002).toFixed(6));
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args.dryRun || !args.promote;

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for promote.");
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || substrateUrl;
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}

const t0 = performance.now();
const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
let storageHandle = createPgStorage({
  databaseUrl: substrateUrl,
  maxConnections: dryRun ? 1 : 2,
});

const geomResolver = new TxgioDatabaseParcelGeometryResolver({ databaseUrl: txgioUrl });
const txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });

const cityBbox = ELGIN_CITY_BBOX;
let cityParcelIds = null;
if (args.cityCohort && !args.parcel) {
  cityParcelIds = await loadCityParcelNodeIds(txSql, cityBbox);
}

const [denomRow] = await sql`
  SELECT count(*)::int AS n
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
    AND NOT (body ? 'absence')
    AND coalesce(body->>'district', '') <> ''
`;

const zoningFactDenominator = denomRow?.n ?? 0;
const extrapolationDenominator = zoningFactDenominator;

const roadRows = await sql`
  SELECT body
  FROM atoms
  WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY_FIPS}
    AND coalesce(body->>'status', 'active') = 'active'
`;
const roads = roadRows
  .map((r) => roadAtomToWarmSource(r.body))
  .filter(Boolean);

const parcelRows = args.parcel
  ? await sql`
      SELECT body->>'parcelNodeId' AS parcel_node_id,
             body->>'district' AS district,
             atom_did AS zoning_fact_did
      FROM atoms
      WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ${args.parcel}
        AND NOT (body ? 'absence')
        AND coalesce(body->>'district', '') <> ''
      LIMIT 1
    `
  : cityParcelIds
    ? await sql`
        SELECT body->>'parcelNodeId' AS parcel_node_id,
               body->>'district' AS district,
               atom_did AS zoning_fact_did
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' = ANY(${cityParcelIds})
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `
    : await sql`
        SELECT body->>'parcelNodeId' AS parcel_node_id,
               body->>'district' AS district,
               atom_did AS zoning_fact_did
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `;

const stats = {
  cohortSize: parcelRows.length,
  zoningFactDenominator,
  roadsLoaded: roads.length,
  processed: 0,
  promoted: 0,
  verifyPass: 0,
  verifyFail: 0,
  declines: {
    "no-geometry": 0,
    "no-road-adjacency": 0,
    "invalid-parcel-ring": 0,
    "no-roads-available": 0,
    "already-promoted": 0,
    "no-setback-row": 0,
    "no-boundary-primitive": 0,
    other: 0,
  },
  failureBuckets: {},
  honestDeclines: 0,
  atomWrites: 0,
  wallMsPerParcel: [],
  parcelRingSourceDivergences: [],
};

const sampleOutcomes = [];
const failureSamples = [];

/** @param {string} bucket @param {string} parcelNodeId @param {string[]} reasons */
function recordEarlyDecline(bucket, parcelNodeId, reasons) {
  stats.declines[bucket in stats.declines ? bucket : "other"]++;
  stats.failureBuckets[bucket] = (stats.failureBuckets[bucket] ?? 0) + 1;
  if (args.diagnoseFailures && failureSamples.length < 30) {
    failureSamples.push({ parcelNodeId, bucket, reasons: reasons.slice(0, 3) });
  }
}

for (const row of parcelRows) {
  const parcelNodeId = row.parcel_node_id;
  const district = normalizeDistrict(row.district);
  if (!district) continue;

  const parcelT0 = performance.now();
  const propId = parcelNodeId.split(":")[1];

  if (!districtHasSetbackRow(district)) {
    recordEarlyDecline("no-setback-row", parcelNodeId, ["no descriptor setback row"]);
    stats.processed++;
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor,
        verifyReasons: ["no descriptor setback row"],
        declineCode: "no-setback-row",
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
    continue;
  }

  if (!args.forceRepromote && !args.forceOverwrite) {
    const [existing] = await sql`
      SELECT 1 FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
      LIMIT 1
    `;
    if (existing) {
      stats.declines["already-promoted"]++;
      stats.processed++;
      continue;
    }
  }

  /** @type {string | null} */
  let situsAddress = null;
  if (propId) {
    const [situsRow] = await txSql`
      SELECT situs_address FROM txgio_parcel
      WHERE county_fips = ${COUNTY_FIPS} AND prop_id = ${propId}
      LIMIT 1
    `;
    const raw =
      typeof situsRow?.situs_address === "string" ? situsRow.situs_address.trim() : "";
    situsAddress = raw || null;
  }

  const geom = await geomResolver.resolve(parcelNodeId);
  const rawParcelRing =
    geom?.ring && geom.ring.length >= 3 ? geom.ring : null;
  const parcelRing =
    rawParcelRing ? scrubLotLineRing(rawParcelRing) : null;
  if (!parcelRing || parcelRing.length < 3) {
    stats.declines["no-geometry"]++;
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  /** @type {import('@hauska-engine/atoms').BoundaryEdgeAtomInstance[] | null} */
  let boundaryEdges = null;
  if (storageHandle?.storage) {
    try {
      boundaryEdges = await readBoundaryEdgesForParcel(
        storageHandle.storage,
        parcelNodeId,
      );
    } catch (err) {
      if (!(err instanceof BoundaryPrimitiveMissingError)) throw err;
    }
  }

  function recordParcelRingSourceDivergence(bcadRing) {
    if (!rawParcelRing || !bcadRing) return;
    const deviationFt = maxRingDeviationFt(rawParcelRing, bcadRing);
    if (deviationFt != null && deviationFt > PARCEL_RING_SOURCE_DIVERGENCE_TOLERANCE_FT) {
      stats.parcelRingSourceDivergences.push({
        parcelNodeId,
        event: "PARCEL-RING-SOURCE-DIVERGENCE",
        deviationFt: Number(deviationFt.toFixed(2)),
        toleranceFt: PARCEL_RING_SOURCE_DIVERGENCE_TOLERANCE_FT,
        note: "BCAD (live CAD) vs txgio_parcel (served truth frame) ring geometry disagree beyond tolerance — R15 parcel-currency candidate, not an engine defect.",
      });
    }
  }

  let parcelRingWorking = parcelRing;
  let ringSwapped = false;
  if (args.forceRepromote && propId) {
    try {
      const bcad = await fetchBcadParcelRings([propId]);
      if (bcad[0]?.ring) recordParcelRingSourceDivergence(bcad[0].ring);
    } catch {
      /* divergence report is best-effort */
    }
    if (rawParcelRing) {
      parcelRingWorking = scrubLotLineRing(rawParcelRing);
      ringSwapped = true;
    }
  } else if (boundaryEdges?.length) {
    const ringVerts = openRing(parcelRingWorking).length;
    if (boundaryEdges.length !== ringVerts) {
      try {
        const bcad = await fetchBcadParcelRings([propId]);
        if (bcad[0]?.ring) recordParcelRingSourceDivergence(bcad[0].ring);
      } catch {
        /* divergence report is best-effort */
      }
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
      const rebuiltAgree = primitiveNormalsAgreeWithRing(rebuilt, parcelRingWorking);
      if (rebuiltAgree.ok) {
        boundaryEdges = rebuilt;
      } else {
        boundaryEdges = null;
      }
    }
  }

  const labelResult = labelEdgesFromRoads({
    parcelRing: parcelRingWorking,
    roads,
    situsAddress,
  });

  if (
    boundaryEdges?.length &&
    labelResult.ok &&
    (args.forceRepromote || ringSwapped)
  ) {
    boundaryEdges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: boundaryEdges,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY_FIPS,
    });
  }

  if (!boundaryEdges?.length && !labelResult.ok) {
    const key = labelResult.decline in stats.declines ? labelResult.decline : "other";
    recordEarlyDecline(key, parcelNodeId, [`label declined: ${labelResult.decline}`]);
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor,
        verifyReasons: [`label declined: ${labelResult.decline}`],
        declineCode: key,
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
    continue;
  }

  let result;
  try {
    result = await warmThenVerify({
      parcelNodeId,
      district,
      parcelRing: parcelRingWorking,
      rawParcelRing,
      descriptor,
      roads,
      edgeLabels: labelResult.ok ? labelResult.edgeLabels : [],
      boundaryEdges: boundaryEdges ?? undefined,
      zoningFactAtomDid: row.zoning_fact_did,
      storage: dryRun ? undefined : storageHandle?.storage,
      promote: !dryRun,
      situsAddress,
    });
  } catch (err) {
    stats.declines.other++;
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    if (sampleOutcomes.length < 8) {
      sampleOutcomes.push({
        parcelNodeId,
        verifyPass: false,
        reasons: [String(err?.message ?? err)].slice(0, 3),
      });
    }
    continue;
  }

  stats.processed++;
  stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));

  if (result.verify.pass) {
    stats.verifyPass++;
    if (!dryRun && result.promoted) {
      stats.promoted++;
      stats.atomWrites += 2;
    }
    if (sampleOutcomes.length < 5) {
      sampleOutcomes.push({
        parcelNodeId,
        verifyPass: true,
        buildableAreaSqFt: result.candidate.buildableAreaSqFt,
        insetFeet: result.candidate.insetFeetPerEdge,
      });
    }
  } else {
    stats.verifyFail++;
    const reasons = [
      ...result.verify.gates.geometry.reasons,
      ...result.verify.gates.roadClassification.reasons,
      ...result.verify.gates.setbackEdgeDistance.reasons,
      ...result.verify.gates.frontOrientation.reasons,
      ...result.verify.gates.r32PerEdgeInset.reasons,
      ...result.verify.gates.facesAnswer.reasons,
    ];
    const bucket = bucketVerifyFailReasons(reasons);
    stats.failureBuckets[bucket] = (stats.failureBuckets[bucket] ?? 0) + 1;
    if (args.diagnoseFailures && failureSamples.length < 30) {
      failureSamples.push({ parcelNodeId, bucket, reasons: reasons.slice(0, 3) });
    }
    if (sampleOutcomes.length < 8) {
      sampleOutcomes.push({
        parcelNodeId,
        verifyPass: false,
        reasons: reasons.slice(0, 3),
        bucket,
      });
    }
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor,
        verifyReasons: reasons,
        declineCode: bucket,
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
  }
}

const wallMsTotal = Math.round(performance.now() - t0);
const sampleN = stats.wallMsPerParcel.length;
const msPerParcel = sampleN > 0
  ? Math.round(stats.wallMsPerParcel.reduce((a, b) => a + b, 0) / sampleN)
  : 0;
const usdSample = approxUsd(wallMsTotal, stats.atomWrites);
const usdPerParcel = stats.processed > 0 ? usdSample / stats.processed : 0;
const extrapolatedJurisdictionUsd = Number(
  (usdPerParcel * extrapolationDenominator).toFixed(4),
);
const extrapolatedWallHours = (msPerParcel * extrapolationDenominator) / 3_600_000;

const costJson = {
  event: "RECIPE-PROOF-48021-elgin-depth-cost.done",
  countyFips: COUNTY_FIPS,
  jurisdiction: "elgin_tx",
  dryRun,
  cohort: {
    offset: args.offset,
    limit: args.limit,
    processed: stats.processed,
    zoningFactDenominator,
    extrapolationDenominator,
    cityCohort: args.cityCohort,
    cityParcelUniverse: cityParcelIds?.length ?? null,
    cityBbox: args.cityCohort ? cityBbox : null,
    forceOverwrite: args.forceOverwrite,
  },
  roadsLoaded: stats.roadsLoaded,
  outcomes: {
    promoted: stats.promoted,
    verifyPass: stats.verifyPass,
    verifyFail: stats.verifyFail,
    honestDeclines: stats.honestDeclines,
    declines: stats.declines,
    failureBuckets: stats.failureBuckets,
  },
  parcelRingSourceDivergences: stats.parcelRingSourceDivergences,
  cost: {
    wallMsTotal,
    msPerParcel,
    usdPerParcel: Number(usdPerParcel.toFixed(6)),
    sampleProcessed: stats.processed,
    atomWrites: stats.atomWrites,
    usdSampleTotal: usdSample,
    extrapolatedJurisdictionUsd,
    extrapolatedWallHours: Number(extrapolatedWallHours.toFixed(2)),
    costGateUsd: 200,
    humanReviewMinutesGate: 60,
    flaggedOverCostGate: extrapolatedJurisdictionUsd > 200,
    note:
      "usd = 0.25 CU × $0.16/hr wall + $0.000002/atom-write; extrapolation = usdPerParcel × extrapolationDenominator",
  },
  sampleOutcomes,
  failureSamples: args.diagnoseFailures ? failureSamples : undefined,
};

console.log(JSON.stringify(costJson, null, 2));

if (args.upsertLedger && !dryRun && args.cityCohort && cityParcelIds?.length) {
  const ledgerResult = await upsertCountyFacetLedger({
    countyFips: COUNTY_FIPS,
    databaseUrl: txgioUrl,
    rosterSize: cityParcelIds.length,
    promotedCount: stats.promoted,
    honestDeclineCount: stats.honestDeclines,
    districtPrefix: "elgin-city-cohort",
    costUsd: Number(usdSample.toFixed(4)),
  });
  console.log(JSON.stringify({ event: "county-facet-ledger.upserted", ...ledgerResult }, null, 2));
}

await sql.end({ timeout: 5 });
await txSql.end({ timeout: 5 });
if (storageHandle) await storageHandle.close();

process.exit(costJson.cost.flaggedOverCostGate ? 2 : 0);
