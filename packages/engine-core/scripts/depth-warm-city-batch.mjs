#!/usr/bin/env node
/**
 * depth-warm-city-batch.mjs — unified registry-driven batch warm→verify→promote.
 *
 * Reads warmRunner config from a frozen JurisdictionRegistryRow (--row-id=REQUIRED).
 * Strategy branch: layer23 (Bastrop per-parcel record) vs descriptor-table (Elgin/Lockhart).
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... TXGIO_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run depth-warm-city-batch -- \
 *       --row-id=Bastrop [--limit=500] [--offset=0] [--promote] [--dry-run] ...
 *
 * Retired per-city scripts (depth-warm-bastrop-batch, -elgin-batch, -caldwell-batch)
 * are stubs that exit 2 and point here.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import elginDescriptor from "../src/property-reasoning/fixtures/descriptors/elgin_tx_descriptor.json" with { type: "json" };
import caldwellDescriptor from "../src/property-reasoning/fixtures/descriptors/caldwell_tx_descriptor.json" with { type: "json" };
import { resolveSetbackTableRow } from "../src/property-reasoning/emit-setback-rule.ts";
import { loadJurisdictionRegistryRowById } from "../src/registry/jurisdiction-registry.ts";
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../src/boundary-primitive/recompute-for-ring.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import {
  scrubLotLineRing,
  ringCentroidLngLat,
} from "../src/boundary-primitive/index.ts";
import { openRing, projectRing } from "../src/depth-warm/geometry.ts";
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import {
  bucketVerifyFailReasons,
  promoteHonestVerifyDecline,
} from "../src/depth-warm/honest-decline-promote.ts";
import {
  EnvelopeGroundTruthPromoteDeclineError,
  EnvelopeWriteThenVerifyMismatchError,
} from "../src/depth-warm/promote.ts";
import {
  assertWarmGateApplied,
  gateWarmCohort,
} from "../src/parcel-node/index.ts";
import { loadLayer23CityPropIds } from "./bastrop-layer23-roster.mjs";
import { loadDominantDistrictRoster } from "./bastrop-dominant-district-roster.mjs";
import { upsertCountyFacetLedger } from "./upsert-county-facet-ledger.mjs";
import {
  bulkLoadAlreadyPromotedSet,
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

const DESCRIPTOR_BY_ID = {
  bastrop_tx: bastropDescriptor,
  elgin_tx: elginDescriptor,
  caldwell_tx: caldwellDescriptor,
};

function loadDescriptor(descriptorId) {
  const descriptor = DESCRIPTOR_BY_ID[descriptorId];
  if (!descriptor) {
    throw new Error(`Unknown warmRunner.descriptorId: ${descriptorId}`);
  }
  return descriptor;
}

function resolvablePlaceTypeDistrictCodesFromDescriptor(descriptor) {
  const codes = new Set();
  for (const row of descriptor.setbackTable?.rows ?? []) {
    if (row.match_basis === "exact" || row.match_basis === "prefix") {
      codes.add(row.district_code);
    }
  }
  return [...codes].sort();
}

function districtHasSetbackRow(descriptor, district) {
  const row = resolveSetbackTableRow(descriptor.setbackTable, district);
  return !("kind" in row);
}

const FEET_PER_METER = 3.280839895;
/**
 * PARCEL-RING-SOURCE-DIVERGENCE tolerance (2026-08-07, Serve-Consistency
 * Principle ruling): BCAD (live CAD service) and txgio_parcel (StratMap-
 * derived, the geometry the product renders as the lot line) are
 * independently digitized sources that can drift by several feet on a
 * given parcel. txgio is the truth frame for everything the user sees;
 * BCAD's live ring is a parcel-currency cross-check only. When the two
 * disagree by more than this tolerance, the divergence is reported (never
 * silently absorbed) as a named observation — these parcels are R15
 * parcel-currency candidates, not an engine defect.
 */
const PARCEL_RING_SOURCE_DIVERGENCE_TOLERANCE_FT = 2;

/**
 * Max perpendicular deviation between two rings, sampled at every vertex
 * of BOTH rings against the nearest edge of the OTHER ring (a practical
 * two-sided Hausdorff-style bound, cheap to compute for parcel-scale
 * rings). Returns feet.
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

function isPlaceTypeDistrict(district, codes, aliases) {
  const normalized = normalizeDistrict(district, aliases);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return codes.some(
    (code) =>
      lower === code.toLowerCase() ||
      lower.startsWith(`${code.toLowerCase()}-`) ||
      lower.startsWith(`${code.toLowerCase()} `),
  );
}

/** Quarantined Block-13 — never re-warm (cert reference); Bastrop layer23 only. */
const DEFAULT_BLOCK13_QUARANTINE = [];

function parseArgs(argv) {
  const out = {
    rowId: null,
    limit: 500,
    offset: 0,
    promote: false,
    dryRun: false,
    parcel: null,
    cityCohort: false,
    placeTypeCohort: false,
    forceRepromote: false,
    forceOverwrite: false,
    layer23CityCohort: false,
    dominantDistrictCohort: false,
    diagnoseFailures: false,
    upsertLedger: false,
    refusedRosterOut: null,
    districtPrefix: null,
    excludeParcels: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--row-id") out.rowId = String(argv[++i] || "").trim();
    else if (a.startsWith("--row-id=")) out.rowId = a.slice("--row-id=".length).trim();
    else if (a === "--limit") out.limit = Number(argv[++i] || 500);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--offset") out.offset = Number(argv[++i] || 0);
    else if (a.startsWith("--offset=")) out.offset = Number(a.slice("--offset=".length));
    else if (a === "--parcel") out.parcel = String(argv[++i] || "").trim();
    else if (a.startsWith("--parcel=")) out.parcel = a.slice("--parcel=".length).trim();
    else if (a === "--district-prefix") out.districtPrefix = String(argv[++i] || "").trim();
    else if (a.startsWith("--district-prefix=")) {
      out.districtPrefix = a.slice("--district-prefix=".length).trim();
    }
    else if (a === "--exclude-parcel") {
      for (const id of String(argv[++i] || "").split(",")) {
        const t = id.trim();
        if (t) out.excludeParcels.add(t);
      }
    }
    else if (a.startsWith("--exclude-parcel=")) {
      for (const id of a.slice("--exclude-parcel=".length).split(",")) {
        const t = id.trim();
        if (t) out.excludeParcels.add(t);
      }
    }
    else if (a === "--promote") out.promote = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--city-cohort") out.cityCohort = true;
    else if (a === "--place-type-cohort") out.placeTypeCohort = true;
    else if (a === "--force-repromote") out.forceRepromote = true;
    else if (a === "--force-overwrite") out.forceOverwrite = true;
    else if (a === "--layer23-city-cohort") out.layer23CityCohort = true;
    else if (a === "--dominant-district-cohort") out.dominantDistrictCohort = true;
    else if (a === "--diagnose-failures") out.diagnoseFailures = true;
    else if (a === "--upsert-ledger") out.upsertLedger = true;
    else if (a === "--refused-roster-out") {
      out.refusedRosterOut = String(argv[++i] || "").trim() || null;
    }
    else if (a.startsWith("--refused-roster-out=")) {
      out.refusedRosterOut = a.slice("--refused-roster-out=".length).trim() || null;
    }
  }
  if (out.forceOverwrite) out.forceRepromote = true;
  return out;
}

function normalizeDistrict(raw, gisDistrictAliases) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = trimmed.split(/\s+/)[0];
  if (!prefix) return trimmed;
  if (gisDistrictAliases?.[prefix]) return gisDistrictAliases[prefix];
  return prefix;
}

async function loadCityParcelNodeIds(txSql, countyFips, bbox) {
  const rows = await txSql`
    SELECT prop_id
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND (south_lat + north_lat) / 2.0 >= ${bbox.south}
      AND (south_lat + north_lat) / 2.0 <= ${bbox.north}
      AND (west_lng + east_lng) / 2.0 >= ${bbox.west}
      AND (west_lng + east_lng) / 2.0 <= ${bbox.east}
  `;
  return rows.map((r) => `${countyFips}:${r.prop_id}`);
}

function approxUsd(wallMs, atomWrites) {
  const hours = wallMs / 3_600_000;
  return Number((hours * 0.25 * 0.16 + atomWrites * 0.000002).toFixed(6));
}

const args = parseArgs(process.argv.slice(2));

if (!args.rowId) {
  console.error("FATAL: --row-id=REQUIRED (registry rowId, e.g. Bastrop, Elgin, Lockhart).");
  process.exit(1);
}

const registryRow = loadJurisdictionRegistryRowById(args.rowId);
if (!registryRow?.warmRunner) {
  console.error(
    `FATAL: registry row ${args.rowId} missing or has no warmRunner config.`,
  );
  process.exit(1);
}

const warmRunner = registryRow.warmRunner;
const COUNTY_FIPS = registryRow.fips;
const setbackStrategy = warmRunner.setbackStrategy;
const isLayer23 = setbackStrategy === "layer23";
const isDescriptorTable = setbackStrategy === "descriptor-table";

const loadedDescriptor = loadDescriptor(warmRunner.descriptorId);
const baseDescriptor = isLayer23
  ? {
      ...loadedDescriptor,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
    }
  : loadedDescriptor;
const layer23CityKey = warmRunner.layer23CityKey ?? "bastrop-city-tx";
const gisDistrictAliases = warmRunner.gisDistrictAliases ?? null;

for (const id of warmRunner.block13Quarantine ?? DEFAULT_BLOCK13_QUARANTINE) {
  args.excludeParcels.add(id);
}

const dryRun = args.dryRun || !args.promote;

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for promote.");
  process.exit(1);
}

console.log(
  JSON.stringify({
    event: "depth-warm-city-batch.start",
    rowId: args.rowId,
    countyFips: COUNTY_FIPS,
    setbackStrategy,
    descriptorId: warmRunner.descriptorId,
    bulkBcad: warmRunner.bulkBcad,
    costEventName: warmRunner.costEventName,
    dryRun,
  }),
);

const substrateUrl = resolveSubstrateDatabaseUrl();
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || substrateUrl;
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}

const t0 = performance.now();
const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
// Dry-run must READ stored boundary primitives (SELECT-only) so compute
// matches apply; only WRITES/promotes stay gated on !dryRun.
let storageHandle = createPgStorage({
  databaseUrl: substrateUrl,
  maxConnections: dryRun ? 1 : 2,
});

const txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });

const cityBbox = warmRunner.cityBbox;
let cityParcelIds = null;
/** @type {{ count: number; where: string } | null} */
let cohortRosterMeta = null;
const useDominantDistrictCohort =
  isLayer23 &&
  (args.dominantDistrictCohort || args.layer23CityCohort) &&
  !args.parcel;
if (useDominantDistrictCohort) {
  if (args.layer23CityCohort && !args.dominantDistrictCohort) {
    console.warn(
      "DEPRECATED: --layer23-city-cohort replaced by --dominant-district-cohort (R26 dominant district)",
    );
  }
  if (!args.districtPrefix) {
    console.error("FATAL: --district-prefix required for dominant-district cohort");
    process.exit(1);
  }
  const roster = await loadDominantDistrictRoster(args.districtPrefix);
  cohortRosterMeta = {
    count: roster.parcelNodeIds.length,
    where: roster.where ?? `dominant-district:${args.districtPrefix} (${roster.source})`,
    cohortOrigin: roster.cohortOrigin ?? "legacy-atoms",
    layer23Count: roster.layer23Count ?? null,
  };
  cityParcelIds = roster.parcelNodeIds.filter((id) => !args.excludeParcels.has(id));
} else if (args.cityCohort && !args.parcel) {
  cityParcelIds = await loadCityParcelNodeIds(txSql, COUNTY_FIPS, cityBbox);
}

const placeTypeDistrictCodes = isLayer23
  ? [...(warmRunner.placeTypeDistrictPrefixes ?? [])]
  : resolvablePlaceTypeDistrictCodesFromDescriptor(loadedDescriptor);

const [denomRow] = await sql`
  SELECT count(*)::int AS n
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
    AND NOT (body ? 'absence')
    AND coalesce(body->>'district', '') <> ''
`;

const [placeTypeDenomRow] = await sql`
  SELECT count(*)::int AS n
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
    AND NOT (body ? 'absence')
    AND coalesce(body->>'district', '') <> ''
    AND split_part(body->>'district', ' ', 1) = ANY(${placeTypeDistrictCodes})
`;

const zoningFactDenominator = denomRow?.n ?? 0;
const placeTypeZoningDenominator = placeTypeDenomRow?.n ?? 0;
const extrapolationDenominator = args.placeTypeCohort
  ? placeTypeZoningDenominator
  : zoningFactDenominator;

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

const placeTypeSqlFilter = args.placeTypeCohort
  ? sql`AND split_part(body->>'district', ' ', 1) = ANY(${placeTypeDistrictCodes})`
  : sql``;

const districtPrefixFilter = args.districtPrefix
  ? sql`AND split_part(body->>'district', ' ', 1) = ${args.districtPrefix}`
  : sql``;

const excludeParcelIds = [...args.excludeParcels];
const excludeFilter = excludeParcelIds.length
  ? sql`AND body->>'parcelNodeId' <> ALL(${excludeParcelIds})`
  : sql``;

const useLayer23RegistryCohort =
  useDominantDistrictCohort && cohortRosterMeta?.cohortOrigin === "layer-23-registry";

/** @type {{ parcel_node_id: string; district: string | null; zoning_fact_did: string | null }[]} */
let parcelRows;

if (args.parcel) {
  parcelRows = await sql`
      SELECT body->>'parcelNodeId' AS parcel_node_id,
             body->>'district' AS district,
             atom_did AS zoning_fact_did
      FROM atoms
      WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ${args.parcel}
        AND NOT (body ? 'absence')
        AND coalesce(body->>'district', '') <> ''
      LIMIT 1
    `;
} else if (useLayer23RegistryCohort && cityParcelIds?.length) {
  const batchIds = cityParcelIds.slice(args.offset, args.offset + args.limit);
  const zfRows =
    batchIds.length === 0
      ? []
      : await sql`
          SELECT body->>'parcelNodeId' AS parcel_node_id,
                 body->>'district' AS district,
                 atom_did AS zoning_fact_did
          FROM atoms
          WHERE entity_type = 'zoning-fact'
            AND body->>'parcelNodeId' = ANY(${batchIds})
            AND NOT (body ? 'absence')
            AND coalesce(body->>'district', '') <> ''
        `;
  const zfById = new Map(zfRows.map((r) => [r.parcel_node_id, r]));
  parcelRows = batchIds.map((id) => {
    const zf = zfById.get(id);
    return {
      parcel_node_id: id,
      district: zf?.district ?? args.districtPrefix ?? null,
      zoning_fact_did: zf?.zoning_fact_did ?? null,
    };
  });
} else if (cityParcelIds) {
  parcelRows = await sql`
        SELECT body->>'parcelNodeId' AS parcel_node_id,
               body->>'district' AS district,
               atom_did AS zoning_fact_did
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' = ANY(${cityParcelIds})
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
          ${useDominantDistrictCohort ? sql`` : placeTypeSqlFilter}
          ${useDominantDistrictCohort ? sql`` : districtPrefixFilter}
          ${excludeFilter}
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `;
} else {
  parcelRows = await sql`
        SELECT body->>'parcelNodeId' AS parcel_node_id,
               body->>'district' AS district,
               atom_did AS zoning_fact_did
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
          ${placeTypeSqlFilter}
          ${districtPrefixFilter}
          ${excludeFilter}
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `;
}

function resolveWarmDistrict(row) {
  return useDominantDistrictCohort && args.districtPrefix
    ? normalizeDistrict(args.districtPrefix, gisDistrictAliases)
    : normalizeDistrict(row.district, gisDistrictAliases);
}

const parcelNodeIds = parcelRows.map((r) => r.parcel_node_id);
const propIds = [
  ...new Set(
    parcelNodeIds
      .map((id) => id.split(":")[1])
      .filter(Boolean),
  ),
];

const bulkT0 = performance.now();
const bulkLoads = await Promise.all([
  bulkLoadSitusByPropId(txSql, COUNTY_FIPS, propIds),
  warmRunner.bulkBcad
    ? bulkLoadBcadRingsByPropId(propIds)
    : Promise.resolve(new Map()),
  !args.forceRepromote && !args.forceOverwrite
    ? bulkLoadAlreadyPromotedSet(sql, parcelNodeIds)
    : Promise.resolve(new Set()),
  bulkLoadTxgioGeometryByPropId(txSql, COUNTY_FIPS, propIds),
  bulkLoadBoundaryEdgesByParcel(sql, parcelNodeIds),
  isLayer23 ? bulkLoadLayer23FeatureIndex() : Promise.resolve(new Map()),
]);
const [
  situsByPropId,
  bcadByPropId,
  alreadyPromotedSet,
  txgioGeomByPropId,
  boundaryEdgesByParcel,
  layer23Index,
] = bulkLoads;
const layer23DescriptorCache = isLayer23
  ? buildLayer23DescriptorCache(
      baseDescriptor,
      parcelRows,
      layer23CityKey,
      bcadByPropId,
      layer23Index,
      resolveWarmDistrict,
    )
  : null;
const bulkLoadMs = Math.round(performance.now() - bulkT0);

/**
 * C1/C5 WARM PREFLIGHT (invariant S3, src/parcel-node/warm-preflight-gate.ts).
 *
 * The cohort above is sized from `zoning-fact` presence — RECIPE eligibility.
 * That says which claim could be computed; it says nothing about whether the
 * PARCEL the claim is about is established. Before this gate, a parcel with no
 * parcel-node anchor, a typed-absence anchor, a synthetic `_feature-*` key, or
 * an anchor retired by a county re-acquisition would be warmed and promoted as
 * though its geometry were settled.
 *
 * The warm set is the INTERSECTION of recipe eligibility and parcel-node
 * eligibility. Refusals are named and counted, never silent drops.
 */
const parcelNodeAnchorRows = await sql`
  SELECT body FROM atoms
  WHERE entity_type = 'parcel-node'
    AND body->>'parcelNodeId' = ANY(${parcelNodeIds})
`;
const parcelNodeAnchors = new Map(
  parcelNodeAnchorRows
    .filter((r) => r.body?.parcelNodeId)
    .map((r) => [
      r.body.parcelNodeId,
      {
        parcelNodeId: r.body.parcelNodeId,
        status: r.body.status === "retired" ? "retired" : "active",
        geometryLoaded: r.body.geometryLoaded === true,
        absenceKind: r.body.absence?.kind ?? null,
        keyKind: r.body.keyKind ?? null,
        geometryStoreRef: r.body.geometryStoreRef ?? null,
      },
    ]),
);

const warmGate = gateWarmCohort(parcelNodeIds, parcelNodeAnchors);
const warmGateVerdict = assertWarmGateApplied(parcelNodeIds.length, warmGate.tally);
if (!warmGateVerdict.ok) {
  console.error(
    JSON.stringify({
      event: "depth-warm.warm-gate-bypass",
      problem: warmGateVerdict.problem,
    }),
  );
  process.exit(1);
}
const warmEligibleIds = new Set(warmGate.eligible);

console.log(
  JSON.stringify({
    event: "depth-warm.parcel-node-preflight",
    county: COUNTY_FIPS,
    recipeCohort: parcelNodeIds.length,
    anchorsFound: parcelNodeAnchors.size,
    warmEligible: warmGate.tally.passed,
    declined: warmGate.tally.declined,
    declinesByCode: warmGate.tally.byCode,
    sample: warmGate.declined.slice(0, 5),
    note: "warm set is the INTERSECTION of zoning-fact recipe eligibility and parcel-node eligibility (C1/C5)",
  }),
);

let liveHttpCallsInLoop = 0;

const loopT0 = performance.now();

const stats = {
  cohortSize: parcelRows.length,
  zoningFactDenominator,
  placeTypeZoningDenominator,
  placeTypeDistrictCodes,
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
      "superseded-prop-id": 0,
      "front-orientation-unresolved": 0,
      "no-zoning-fact-stamp": 0,
      "ground-truth-promote-decline": 0,
      "write-then-verify-mismatch": 0,
      // C1/C5 parcel-node preflight refusals (invariant S3).
      "no-parcel-node-anchor": 0,
      "parcel-node-absence": 0,
      "parcel-node-key-unresolved": 0,
      "parcel-node-retired": 0,
      "parcel-node-geometry-incomplete": 0,
      "parcel-node-pointer-mismatch": 0,
      other: 0,
  },
  parcelNodePreflight: {
    recipeCohort: parcelNodeIds.length,
    anchorsFound: parcelNodeAnchors.size,
    warmEligible: warmGate.tally.passed,
    declined: warmGate.tally.declined,
    byCode: warmGate.tally.byCode,
  },
  failureBuckets: {},
  honestDeclines: 0,
  atomWrites: 0,
  wallMsPerParcel: [],
  /**
   * PARCEL-RING-SOURCE-DIVERGENCE observations (Serve-Consistency Principle,
   * 2026-08-07) — report-only, never gates promote. Parcels here are R15
   * parcel-currency candidates: BCAD's live ring and txgio's served ring
   * disagree by more than PARCEL_RING_SOURCE_DIVERGENCE_TOLERANCE_FT.
   */
  parcelRingSourceDivergences: [],
};

const sampleOutcomes = [];
const failureSamples = [];
/** @type {{ parcelNodeId: string; reason: string }[]} */
const refusedParcels = [];

/** @param {string} parcelNodeId @param {string} reason */
function recordRefusedParcel(parcelNodeId, reason) {
  refusedParcels.push({ parcelNodeId, reason });
}

/** @param {string} bucket @param {string} parcelNodeId @param {string[]} reasons */
function recordEarlyDecline(bucket, parcelNodeId, reasons) {
  stats.declines[bucket in stats.declines ? bucket : "other"]++;
  stats.failureBuckets[bucket] = (stats.failureBuckets[bucket] ?? 0) + 1;
  recordRefusedParcel(parcelNodeId, bucket);
  if (args.diagnoseFailures && failureSamples.length < 30) {
    failureSamples.push({ parcelNodeId, bucket, reasons: reasons.slice(0, 3) });
  }
}

for (const row of parcelRows) {
  const parcelT0 = performance.now();
  const parcelNodeId = row.parcel_node_id;
  const district =
    useDominantDistrictCohort && args.districtPrefix
      ? normalizeDistrict(args.districtPrefix, gisDistrictAliases)
      : normalizeDistrict(row.district, gisDistrictAliases);
  if (!district) continue;

  // C5 ORDERING: the parcel-node anchor is checked BEFORE recipe prerequisites.
  // The statewide factory establishes that the parcel exists; only then may the
  // jurisdiction factory compute a claim about it. Reversing this is how a
  // zoning-fact alone ends up promoting a parcel with no established geometry.
  if (!warmEligibleIds.has(parcelNodeId)) {
    const refusal = warmGate.declined.find((d) => d.parcelNodeId === parcelNodeId);
    recordEarlyDecline(refusal?.declineCode ?? "no-parcel-node-anchor", parcelNodeId, [
      refusal?.reason ?? "parcel-node preflight refused this parcel",
    ]);
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  if (!row.zoning_fact_did) {
    recordEarlyDecline("no-zoning-fact-stamp", parcelNodeId, [
      isLayer23
        ? "layer-23 roster parcel missing zoning-fact atom (substrate stamp required before promote)"
        : "zoning-fact atom missing substrate stamp required before promote",
    ]);
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  if (args.placeTypeCohort && !isPlaceTypeDistrict(row.district, placeTypeDistrictCodes, gisDistrictAliases)) {
    stats.declines["no-setback-row"]++;
    recordRefusedParcel(parcelNodeId, "no-setback-row");
    stats.processed++;
    continue;
  }

  const propId = parcelNodeId.split(":")[1];
  const situsAddress = propId ? (situsByPropId.get(propId) ?? null) : null;

  /** @type {{ ok: true; descriptor: typeof baseDescriptor; governingDistrict?: string } | { ok: false; reason: string; code?: string }} */
  let warmDescriptorResult;
  if (isDescriptorTable) {
    if (!districtHasSetbackRow(baseDescriptor, district)) {
      warmDescriptorResult = {
        ok: false,
        reason: "no descriptor setback row",
        code: "no-setback-row",
      };
    } else {
      warmDescriptorResult = { ok: true, descriptor: baseDescriptor };
    }
  } else {
    warmDescriptorResult = layer23DescriptorCache.get(parcelNodeId);
  }

  if (!warmDescriptorResult?.ok) {
    const reason = warmDescriptorResult?.reason ?? "no per-parcel layer-23 setback row";
    recordEarlyDecline("no-setback-row", parcelNodeId, [reason]);
    stats.processed++;
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor: baseDescriptor,
        verifyReasons: [reason],
        declineCode: warmDescriptorResult?.code ?? "no-setback-row",
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
    continue;
  }

  const warmDistrict =
    isLayer23 && warmDescriptorResult.governingDistrict
      ? warmDescriptorResult.governingDistrict
      : district;
  const activeDescriptor = warmDescriptorResult.descriptor;

  let currencyResult = null;
  if (propId && warmRunner.bulkBcad) {
    currencyResult = parcelCurrencyFromBcadMap(propId, bcadByPropId);
    if (!currencyResult.ok) {
      recordEarlyDecline("superseded-prop-id", parcelNodeId, [currencyResult.reason]);
      stats.processed++;
      stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
      if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
        await promoteHonestVerifyDecline(storageHandle.storage, {
          parcelNodeId,
          zoningFactAtomDid: row.zoning_fact_did,
          descriptor: activeDescriptor,
          verifyReasons: [currencyResult.reason],
          declineCode: "superseded-prop-id",
        });
        stats.honestDeclines++;
        stats.atomWrites++;
      }
      continue;
    }
  }

  if (!args.forceRepromote && !args.forceOverwrite) {
    if (alreadyPromotedSet.has(parcelNodeId)) {
      stats.declines["already-promoted"]++;
      stats.processed++;
      continue;
    }
  }

  const txgioGeom = propId ? txgioGeomByPropId.get(propId) : null;
  const geom = txgioGeom?.ring
    ? { ring: txgioGeom.ring, sourceRef: `txgio-parcel:${COUNTY_FIPS}:${propId}` }
    : null;
  // SERVE-CONSISTENCY PRINCIPLE (2026-08-07, master planner ruling — amends
  // the Ground-Truth Frame Law): one ring per parcel governs everything the
  // user sees. The PRODUCT displays txgio_parcel geometry as the lot line
  // (the same geometry geomResolver.resolve loads here) — that is the truth
  // frame, not BCAD's live CAD ring. BCAD and txgio are independently
  // digitized sources (CAD-vs-StratMap) that can drift by several feet on a
  // given parcel (verified: 48021:31299, ~4.6ft) — grading the served
  // envelope against BCAD when the product renders txgio produces a
  // "correct vs the wrong reference" defect, not a geometry defect. So:
  // rawParcelRing is pinned to geom.ring (txgio) ONCE here and MUST NOT be
  // reassigned by any later BCAD re-fetch (the ringSwapped branches below
  // legitimately swap the WORKING/scrub-feeding ring to BCAD when boundary-
  // edge counts disagree, but that is a currency/geometry-source decision
  // for the inset computation only — it must never redefine the truth
  // frame the ground-truth predicate and write-then-verify measure
  // against). BCAD is demoted to its proper role: a parcel-currency
  // cross-check instrument (see the PARCEL-RING-SOURCE-DIVERGENCE
  // observation below).
  const rawParcelRing =
    geom?.ring && geom.ring.length >= 3
      ? geom.ring
      : currencyResult?.ok
        ? currencyResult.ring
        : null;
  let parcelRing =
    geom?.ring && geom.ring.length >= 3
      ? geom.ring
      : currencyResult?.ok
        ? scrubLotLineRing(currencyResult.ring)
        : null;
  if (!parcelRing || parcelRing.length < 3) {
    stats.declines["no-geometry"]++;
    recordRefusedParcel(parcelNodeId, "no-geometry");
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  /** @type {import('@hauska-engine/atoms').BoundaryEdgeAtomInstance[] | null} */
  let boundaryEdges = boundaryEdgesFromBulkMap(boundaryEdgesByParcel, parcelNodeId);

  // PARCEL-RING-SOURCE-DIVERGENCE check (Serve-Consistency Principle): every
  // time BCAD geometry is fetched for this parcel (as a currency/working-
  // ring source below), compare it against rawParcelRing (txgio — the
  // truth frame) and record a report-only observation when they disagree
  // beyond tolerance. This NEVER changes rawParcelRing itself — BCAD stays
  // demoted to a currency cross-check, never the truth frame.
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

  // CONSTRUCT FROM THE TRUTH FRAME (2026-08-07, master planner ruling —
  // fixes the actual defect the Serve-Consistency Principle amendment
  // (PR #273) left in place: rawParcelRing was correctly pinned to txgio,
  // but parcelRingWorking — the ring the OFFSET/ENVELOPE was actually built
  // from — was still being swapped to scrubLotLineRing(BCAD ring) on
  // --force-repromote or a boundary-edge-count mismatch. That is exactly
  // the re-apply path this session's fixes are verified through, so the
  // served envelope kept reading BCAD-frame numbers even though
  // rawParcelRing (verification only) correctly pointed at txgio. BCAD now
  // exits the envelope-construction path ENTIRELY — a live BCAD fetch may
  // still run (for the PARCEL-RING-SOURCE-DIVERGENCE report only, never to
  // build parcelRingWorking), and any re-scrub uses rawParcelRing (txgio,
  // already fetched above) as its source. One frame — txgio — from source
  // to store, no exceptions.
  let parcelRingWorking = parcelRing;
  let ringSwapped = false;
  if (args.forceRepromote && propId && warmRunner.bulkBcad) {
    const bcadHit = bcadByPropId.get(normalizePropId(propId));
    if (bcadHit?.ring) recordParcelRingSourceDivergence(bcadHit.ring);
    if (rawParcelRing) {
      parcelRingWorking = scrubLotLineRing(rawParcelRing);
      ringSwapped = true;
    }
  } else if (boundaryEdges?.length) {
    const ringVerts = openRing(parcelRingWorking).length;
    if (boundaryEdges.length !== ringVerts) {
      const bcadHit = propId && warmRunner.bulkBcad ? bcadByPropId.get(normalizePropId(propId)) : null;
      if (bcadHit?.ring) recordParcelRingSourceDivergence(bcadHit.ring);
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

  // R28 winding gate — the stored primitive's per-edge inward normals + role→
  // edgeIndex mapping were built against the ORIGINAL (TXGIO) ring. When the
  // BCAD ring is swapped in (--force-repromote or count-mismatch), the swap may
  // reverse winding at equal vertex count, so applying stored normals by
  // edgeIndex lands them on the WRONG edges → offset never closes → inset null.
  // Fail closed: before insetting, assert the stored normals agree (dot ≈ 1.0)
  // with the working ring's per-edge normals; if not (or the ring was swapped),
  // RECOMPUTE the primitive against the working ring so edgeIndex→edge→normal is
  // correct for its winding. Never silently inset with mismatched normals.
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
        // Recompute could not reconcile the primitive to the ring — drop to the
        // road-label inset path rather than inset with mismatched normals.
        boundaryEdges = null;
      }
    }
  }

  const labelResult = labelEdgesFromRoads({
    parcelRing: parcelRingWorking,
    roads,
    situsAddress,
  });

  // R30 — re-warm must RE-DERIVE edge roles from current road-nodes + situs,
  // not reuse stale promoted roles from the stored boundary primitive.
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
        descriptor: activeDescriptor,
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
      district: warmDistrict,
      parcelRing: parcelRingWorking,
      // GROUND-TRUTH FRAME LAW — threaded through to WarmCandidate.rawParcelRing
      // so promote's checkEnvelopeGroundTruth gate (and any write-then-verify
      // read-back check) measures against the true source ring, never the
      // scrubbed working ring.
      rawParcelRing,
      descriptor: activeDescriptor,
      roads,
      edgeLabels: labelResult.ok ? labelResult.edgeLabels : [],
      boundaryEdges: boundaryEdges ?? undefined,
      zoningFactAtomDid: row.zoning_fact_did,
      storage: dryRun ? undefined : storageHandle?.storage,
      promote: !dryRun,
      situsAddress,
    });
  } catch (err) {
    let declineKey = "other";
    if (err instanceof EnvelopeGroundTruthPromoteDeclineError) {
      declineKey = "ground-truth-promote-decline";
    } else if (err instanceof EnvelopeWriteThenVerifyMismatchError) {
      declineKey = "write-then-verify-mismatch";
    }
    stats.declines[declineKey]++;
    recordRefusedParcel(parcelNodeId, declineKey);
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
    recordRefusedParcel(parcelNodeId, bucket);
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
    if (args.forceOverwrite && !dryRun && storageHandle?.storage) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor: activeDescriptor,
        verifyReasons: reasons,
        declineCode: bucket,
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
  }
}

const loopMsTotal = Math.round(performance.now() - loopT0);
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
  event: warmRunner.costEventName,
  rowId: args.rowId,
  countyFips: COUNTY_FIPS,
  jurisdiction: warmRunner.jurisdictionLabel ?? args.rowId,
  setbackStrategy,
  dryRun,
  cohort: {
    offset: args.offset,
    limit: args.limit,
    processed: stats.processed,
    zoningFactDenominator,
    placeTypeZoningDenominator,
    placeTypeDistrictCodes,
    placeTypeCohort: args.placeTypeCohort,
    extrapolationDenominator,
    cityCohort: args.cityCohort || useDominantDistrictCohort,
    dominantDistrictCohort: useDominantDistrictCohort,
    layer23CityCohort: args.layer23CityCohort,
    cohortRoster: cohortRosterMeta,
    cityParcelUniverse: cityParcelIds?.length ?? null,
    cityBbox: args.cityCohort && !useDominantDistrictCohort ? cityBbox : null,
    districtPrefix: args.districtPrefix,
    excludeParcels: excludeParcelIds,
    forceOverwrite: args.forceOverwrite,
    bulkBcad: warmRunner.bulkBcad,
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
  // Serve-Consistency Principle (2026-08-07) — report-only, never gates
  // promote. Empty array when no parcel this run needed a BCAD re-fetch, or
  // every re-fetched BCAD ring agreed with txgio within tolerance.
  parcelRingSourceDivergences: stats.parcelRingSourceDivergences,
  cost: {
    wallMsTotal,
    bulkLoadMs,
    loopMsTotal,
    liveHttpCallsInLoop,
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
      "usd = 0.25 CU × $0.16/hr wall + $0.000002/atom-write; extrapolation = usdPerParcel × extrapolationDenominator (place-type when --place-type-cohort). bulkLoadMs is pre-loop acquisition; loopMsTotal is compute-only parcel loop; liveHttpCallsInLoop must be 0.",
  },
  sampleOutcomes,
  failureSamples: args.diagnoseFailures ? failureSamples : undefined,
};

console.log(JSON.stringify(costJson, null, 2));

const refusedRosterPath =
  args.refusedRosterOut ??
  `${warmRunner.refusedRosterPrefix}-${dryRun ? "dry" : "apply"}.json`;
const refusedRosterArtifact = {
  event: "R4-depth-refused-roster",
  rowId: args.rowId,
  countyFips: COUNTY_FIPS,
  dryRun,
  refusedCount: refusedParcels.length,
  parcels: refusedParcels,
};
writeFileSync(refusedRosterPath, `${JSON.stringify(refusedRosterArtifact, null, 2)}\n`, {
  encoding: "utf8",
});
console.log(
  JSON.stringify({
    event: "R4-depth-refused-roster.written",
    path: refusedRosterPath,
    refusedCount: refusedParcels.length,
  }),
);

if (args.upsertLedger && !dryRun && cohortRosterMeta) {
  const ledgerUrl = txgioUrl;
  const ledgerResult = await upsertCountyFacetLedger({
    countyFips: COUNTY_FIPS,
    databaseUrl: ledgerUrl,
    rosterSize: cohortRosterMeta.count - excludeParcelIds.length,
    promotedCount: stats.promoted,
    honestDeclineCount: stats.honestDeclines,
    districtPrefix: args.districtPrefix,
    costUsd: Number(usdSample.toFixed(4)),
  });
  console.log(JSON.stringify({ event: "county-facet-ledger.upserted", ...ledgerResult }, null, 2));
}

await sql.end({ timeout: 5 });
await txSql.end({ timeout: 5 });
if (storageHandle) await storageHandle.close();

process.exit(costJson.cost.flaggedOverCostGate ? 2 : 0);
