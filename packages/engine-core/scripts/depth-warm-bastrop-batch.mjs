#!/usr/bin/env node
/**
 * depth-warm-bastrop-batch.mjs — R4 batch warm→verify→promote with cost instrumentation.
 *
 * Depth-over-breadth: only parcels with zoning-fact district present.
 * Honest declines on geometry/road gaps; promote only verify-pass.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... TXGIO_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run depth-warm-bastrop-batch -- \
 *       --limit=500 [--offset=0] [--promote] [--dry-run] [--city-cohort] [--place-type-cohort]
 *
 * Pilot cohort default (--limit=500) with extrapolation to full zoning-fact universe.
 * --place-type-cohort: only SF-1/SF-2/SF-3/RR (BDC Euclidean rows); excludes
 * conditional districts without setback rows (MU/GC/… honest no-setback-row).
 */

import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { buildBastropPerParcelSetbackDescriptor } from "../src/property-reasoning/bastrop-per-parcel-setback.ts";
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
  assertParcelCurrencyInBcad,
  ringCentroidLngLat,
} from "../src/boundary-primitive/index.ts";
import { openRing, projectRing } from "../src/depth-warm/geometry.ts";
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { BASTROP_CITY_BBOX } from "../src/road-intake/fetch-overpass-bbox.ts";
import { TxgioDatabaseParcelGeometryResolver } from "../src/parcel-terrain/parcel-geometry-resolver.ts";
import {
  bucketVerifyFailReasons,
  promoteHonestVerifyDecline,
} from "../src/depth-warm/honest-decline-promote.ts";
import { loadLayer23CityPropIds } from "./bastrop-layer23-roster.mjs";
import { loadDominantDistrictRoster } from "./bastrop-dominant-district-roster.mjs";
import { upsertCountyFacetLedger } from "./upsert-county-facet-ledger.mjs";

const COUNTY_FIPS = "48021";
const BASTROP_CITY_KEY = "bastrop-city-tx";

/** Base descriptor — per-parcel layer 23 overlays setbackTable per parcel (STEP 1). */
const baseDescriptor = {
  ...bastropDescriptor,
  sourceAdapter: "bastrop-per-parcel-record-layer-23",
};

/** BDC + downtown conditional districts served from per-parcel layer 23. */
const BASTROP_PER_PARCEL_DISTRICT_PREFIXES = [
  "SF-1",
  "SF-2",
  "SF-3",
  "RR",
  "MU",
  "GC",
  "PI",
  "IND",
  "OS",
  "P/OS",
  "P-OS",
  "PDD",
];

function resolvablePlaceTypeDistrictCodes() {
  return [...BASTROP_PER_PARCEL_DISTRICT_PREFIXES];
}

async function districtHasPerParcelSetbackRow(parcelNodeId, district, centroidLngLat) {
  const built = await buildBastropPerParcelSetbackDescriptor(
    baseDescriptor,
    parcelNodeId,
    district,
    BASTROP_CITY_KEY,
    undefined,
    centroidLngLat,
  );
  return built.ok;
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

function isPlaceTypeDistrict(district, codes) {
  const normalized = normalizeDistrict(district);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return codes.some(
    (code) =>
      lower === code.toLowerCase() ||
      lower.startsWith(`${code.toLowerCase()}-`) ||
      lower.startsWith(`${code.toLowerCase()} `),
  );
}

/** Quarantined Block-13 — never re-warm (cert reference). */
const BLOCK13_QUARANTINE = new Set([
  "48021:34145",
  "48021:34121",
  "48021:34153",
  "48021:34137",
  "48021:34169",
  "48021:34177",
  "48021:34161",
]);

function parseArgs(argv) {
  const out = {
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
    districtPrefix: null,
    excludeParcels: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = Number(argv[++i] || 500);
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
  }
  if (out.forceOverwrite) out.forceRepromote = true;
  for (const id of BLOCK13_QUARANTINE) out.excludeParcels.add(id);
  return out;
}

function normalizeDistrict(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = trimmed.split(/\s+/)[0];
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

const cityBbox = BASTROP_CITY_BBOX;
let cityParcelIds = null;
/** @type {{ count: number; where: string } | null} */
let cohortRosterMeta = null;
const useDominantDistrictCohort =
  (args.dominantDistrictCohort || args.layer23CityCohort) && !args.parcel;
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
  cityParcelIds = await loadCityParcelNodeIds(txSql, cityBbox);
}

const placeTypeDistrictCodes = resolvablePlaceTypeDistrictCodes();

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
      other: 0,
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

/** @param {string} bucket @param {string} parcelNodeId @param {string[]} reasons */
function recordEarlyDecline(bucket, parcelNodeId, reasons) {
  stats.declines[bucket in stats.declines ? bucket : "other"]++;
  stats.failureBuckets[bucket] = (stats.failureBuckets[bucket] ?? 0) + 1;
  if (args.diagnoseFailures && failureSamples.length < 30) {
    failureSamples.push({ parcelNodeId, bucket, reasons: reasons.slice(0, 3) });
  }
}

for (const row of parcelRows) {
  const parcelT0 = performance.now();
  const parcelNodeId = row.parcel_node_id;
  const district =
    useDominantDistrictCohort && args.districtPrefix
      ? normalizeDistrict(args.districtPrefix)
      : normalizeDistrict(row.district);
  if (!district) continue;

  if (!row.zoning_fact_did) {
    recordEarlyDecline("no-zoning-fact-stamp", parcelNodeId, [
      "layer-23 roster parcel missing zoning-fact atom (substrate stamp required before promote)",
    ]);
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

  if (args.placeTypeCohort && !isPlaceTypeDistrict(row.district, placeTypeDistrictCodes)) {
    stats.declines["no-setback-row"]++;
    stats.processed++;
    continue;
  }

  const propId = parcelNodeId.split(":")[1];
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
  /** @type {[number, number] | undefined} */
  let centroidLngLat;
  /** @type {import('../src/boundary-primitive/parcel-currency.ts').ParcelCurrencyResult | null} */
  let currencyResult = null;
  if (propId) {
    currencyResult = await assertParcelCurrencyInBcad(propId);
    if (!currencyResult.ok) {
      recordEarlyDecline("superseded-prop-id", parcelNodeId, [currencyResult.reason]);
      stats.processed++;
      stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
      if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
        await promoteHonestVerifyDecline(storageHandle.storage, {
          parcelNodeId,
          zoningFactAtomDid: row.zoning_fact_did,
          descriptor: baseDescriptor,
          verifyReasons: [currencyResult.reason],
          declineCode: "superseded-prop-id",
        });
        stats.honestDeclines++;
        stats.atomWrites++;
      }
      continue;
    }
    centroidLngLat = ringCentroidLngLat(currencyResult.ring);
  }

  if (!(await districtHasPerParcelSetbackRow(parcelNodeId, district, centroidLngLat))) {
    recordEarlyDecline("no-setback-row", parcelNodeId, ["no per-parcel layer-23 setback row"]);
    stats.processed++;
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor: baseDescriptor,
        verifyReasons: ["no per-parcel layer-23 setback row"],
        declineCode: "no-setback-row",
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
    continue;
  }

  const builtDescriptor = await buildBastropPerParcelSetbackDescriptor(
    baseDescriptor,
    parcelNodeId,
    district,
    BASTROP_CITY_KEY,
    undefined,
    centroidLngLat,
  );
  if (!builtDescriptor.ok) {
    recordEarlyDecline("no-setback-row", parcelNodeId, [builtDescriptor.reason]);
    stats.processed++;
    if (args.forceOverwrite && !dryRun && storageHandle?.storage && row.zoning_fact_did) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor: baseDescriptor,
        verifyReasons: [builtDescriptor.reason],
        declineCode: builtDescriptor.code ?? "no-setback-row",
      });
      stats.honestDeclines++;
      stats.atomWrites++;
    }
    continue;
  }
  // R26 — key the warm inset on the DOMINANT-area district (per-parcel record),
  // not the stamped sliver, so edge resolution matches the single per-parcel row.
  const warmDistrict = builtDescriptor.governingDistrict || district;

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

  const geom = await geomResolver.resolve(parcelNodeId);
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
    stats.processed++;
    stats.wallMsPerParcel.push(Math.round(performance.now() - parcelT0));
    continue;
  }

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

  let parcelRingWorking = parcelRing;
  let ringSwapped = false;
  if (args.forceRepromote && propId) {
    try {
      const bcad = await fetchBcadParcelRings([propId]);
      if (bcad[0]?.ring) {
        recordParcelRingSourceDivergence(bcad[0].ring);
        parcelRingWorking = scrubLotLineRing(bcad[0].ring);
        ringSwapped = true;
      }
    } catch {
      /* fall back */
    }
  } else if (boundaryEdges?.length) {
    const ringVerts = openRing(parcelRingWorking).length;
    if (boundaryEdges.length !== ringVerts) {
      try {
        const bcad = await fetchBcadParcelRings([propId]);
        if (bcad[0]?.ring) {
          recordParcelRingSourceDivergence(bcad[0].ring);
          parcelRingWorking = scrubLotLineRing(bcad[0].ring);
          ringSwapped = true;
        }
      } catch {
        /* fall back */
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
        descriptor: builtDescriptor.descriptor,
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
      descriptor: builtDescriptor.descriptor,
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
    if (args.forceOverwrite && !dryRun && storageHandle?.storage) {
      await promoteHonestVerifyDecline(storageHandle.storage, {
        parcelNodeId,
        zoningFactAtomDid: row.zoning_fact_did,
        descriptor: builtDescriptor.descriptor,
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
  event: "R4-depth-cost.done",
  countyFips: COUNTY_FIPS,
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
      "usd = 0.25 CU × $0.16/hr wall + $0.000002/atom-write; extrapolation = usdPerParcel × extrapolationDenominator (place-type when --place-type-cohort)",
  },
  sampleOutcomes,
  failureSamples: args.diagnoseFailures ? failureSamples : undefined,
  wdll9Note: {
    parcel: "48021:33512 (714 Spring St)",
    status: "PARTIAL",
    detail:
      "ROW still approximate-assumed-per-class (v1 OSM centerline + assumed width). " +
      "Aerial alignment: parcel ring from txgio_parcel; Spring Street OSM way within ~15m of southern front edge index 5.",
  },
};

console.log(JSON.stringify(costJson, null, 2));

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
