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
 *       --limit=500 [--offset=0] [--promote] [--dry-run] [--city-cohort] [--parcel=48021:...]
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
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { ELGIN_CITY_BBOX } from "../src/road-intake/fetch-overpass-bbox.ts";
import { TxgioDatabaseParcelGeometryResolver } from "../src/parcel-terrain/parcel-geometry-resolver.ts";

const COUNTY_FIPS = "48021";
const descriptor = elginDescriptor;

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
  }
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
let storageHandle = null;
if (!dryRun) {
  storageHandle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
}

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
  atomWrites: 0,
  wallMsPerParcel: [],
};

const sampleOutcomes = [];

for (const row of parcelRows) {
  const parcelNodeId = row.parcel_node_id;
  const district = normalizeDistrict(row.district);
  if (!district) continue;

  if (!districtHasSetbackRow(district)) {
    stats.declines["no-setback-row"]++;
    stats.processed++;
    continue;
  }

  const parcelT0 = performance.now();

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

  const geom = await geomResolver.resolve(parcelNodeId);
  if (!geom?.ring || geom.ring.length < 3) {
    stats.declines["no-geometry"]++;
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  const labelResult = labelEdgesFromRoads({
    parcelRing: geom.ring,
    roads,
  });

  /** @type {import('@hauska-engine/atoms').BoundaryEdgeAtomInstance[] | null} */
  let boundaryEdges = null;
  if (!dryRun && storageHandle?.storage) {
    try {
      boundaryEdges = await readBoundaryEdgesForParcel(
        storageHandle.storage,
        parcelNodeId,
      );
    } catch (err) {
      if (!(err instanceof BoundaryPrimitiveMissingError)) throw err;
    }
  }

  if (!boundaryEdges?.length && !labelResult.ok) {
    const key = labelResult.decline in stats.declines ? labelResult.decline : "other";
    stats.declines[key]++;
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  let result;
  try {
    result = await warmThenVerify({
      parcelNodeId,
      district,
      parcelRing: geom.ring,
      descriptor,
      roads,
      edgeLabels: labelResult.ok ? labelResult.edgeLabels : [],
      boundaryEdges: boundaryEdges ?? undefined,
      zoningFactAtomDid: row.zoning_fact_did,
      storage: dryRun ? undefined : storageHandle?.storage,
      promote: !dryRun,
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
    if (sampleOutcomes.length < 8) {
      sampleOutcomes.push({
        parcelNodeId,
        verifyPass: false,
        reasons: [
          ...result.verify.gates.geometry.reasons,
          ...result.verify.gates.roadClassification.reasons,
          ...result.verify.gates.setbackEdgeDistance.reasons,
        ].slice(0, 3),
      });
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
  },
  roadsLoaded: stats.roadsLoaded,
  outcomes: {
    promoted: stats.promoted,
    verifyPass: stats.verifyPass,
    verifyFail: stats.verifyFail,
    declines: stats.declines,
  },
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
};

console.log(JSON.stringify(costJson, null, 2));

await sql.end({ timeout: 5 });
await txSql.end({ timeout: 5 });
if (storageHandle) await storageHandle.close();

process.exit(costJson.cost.flaggedOverCostGate ? 2 : 0);
