#!/usr/bin/env node
/**
 * boundary-primitive-bastrop.mjs — S2-U2 batch persist for Bastrop cohort.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... TXGIO_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run boundary-primitive-bastrop -- \
 *       [--limit=500] [--offset=0] [--parcel=48021:34785] [--dry-run]
 */

import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { getSetbackTable } from "@hauska-engine/adapters";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { resolveSetbackTableRow } from "../src/property-reasoning/emit-setback-rule.ts";
import { setbackTableDescriptorFromAdapter } from "../src/property-reasoning/setback-table-from-adapter.ts";
import { BASTROP_CITY_BBOX } from "../src/road-intake/fetch-overpass-bbox.ts";
import {
  computeBoundaryEdgeAtoms,
  loadParcelAdjacencyIndexFromNeon,
  persistBoundaryEdges,
  roadAtomBodyToWarmSource,
} from "../src/boundary-primitive/index.ts";

const COUNTY_FIPS = "48021";

/** SURVIVOR = adapter bastrop-development-code (same overlay as depth-warm-bastrop-batch). */
const adapterSetbackTable = getSetbackTable("bastrop-development-code");
const setbackTableFromAdapter = setbackTableDescriptorFromAdapter(adapterSetbackTable);
if (!setbackTableFromAdapter?.rows?.length) {
  console.error(
    "FATAL: bastrop-development-code adapter setback table missing or empty.",
  );
  process.exit(1);
}
const descriptor = {
  ...bastropDescriptor,
  setbackTable: setbackTableFromAdapter,
};

function districtHasSetbackRow(district) {
  const row = resolveSetbackTableRow(descriptor.setbackTable, district);
  return !("kind" in row);
}

function resolvablePlaceTypeDistrictCodes() {
  const codes = new Set();
  for (const row of descriptor.setbackTable?.rows ?? []) {
    if (row.match_basis === "exact" || row.match_basis === "prefix") {
      codes.add(row.district_code);
    }
  }
  return [...codes].sort();
}

function isPlaceTypeDistrict(district, codes) {
  const normalized = district?.trim().split(/\s+/)[0] ?? "";
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return codes.some(
    (code) =>
      lower === code.toLowerCase() ||
      lower.startsWith(`${code.toLowerCase()}-`) ||
      lower.startsWith(`${code.toLowerCase()} `),
  );
}

function parseArgs(argv) {
  const out = {
    limit: 500,
    offset: 0,
    parcel: null,
    dryRun: false,
    placeTypeCohort: false,
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
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--place-type-cohort") out.placeTypeCohort = true;
    else if (a === "--city-cohort") out.cityCohort = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args.dryRun || process.env.BOUNDARY_PRIMITIVE_PERSIST !== "1";

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for persist.");
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || substrateUrl;
if (!substrateUrl || !txgioUrl) {
  console.error("FATAL: DATABASE_URL and TXGIO_DATABASE_URL required.");
  process.exit(1);
}

const t0 = performance.now();
const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
const txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });

/** @type {import('@hauska-engine/storage').StoragePort | null} */
let storageHandle = null;
if (!dryRun) {
  storageHandle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
}

console.log("Loading parcel adjacency index (one SELECT)...");
const loadT0 = performance.now();
const adjacencyIndex = await loadParcelAdjacencyIndexFromNeon(txSql, COUNTY_FIPS);
const loadMs = performance.now() - loadT0;
console.log(
  JSON.stringify({
    parcelsLoaded: adjacencyIndex.entries.size,
    loadWallMs: Math.round(loadMs),
    method: "one Neon SELECT + cell grid + 3m probe + PIP",
  }),
);

const roadRows = await sql`
  SELECT body
  FROM atoms
  WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY_FIPS}
    AND coalesce(body->>'status', 'active') = 'active'
`;
const roads = roadRows.map((r) => roadAtomBodyToWarmSource(r.body)).filter(Boolean);

const placeTypeDistrictCodes = resolvablePlaceTypeDistrictCodes();
const cityBbox = BASTROP_CITY_BBOX;

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

let cityParcelIds = null;
if (args.cityCohort && !args.parcel) {
  cityParcelIds = await loadCityParcelNodeIds(txSql, cityBbox);
}

const placeTypeSqlFilter = args.placeTypeCohort
  ? sql`AND split_part(body->>'district', ' ', 1) = ANY(${placeTypeDistrictCodes})`
  : sql``;

const parcelRows = args.parcel
  ? await sql`
      SELECT body->>'parcelNodeId' AS parcel_node_id,
             body->>'district' AS district
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
               body->>'district' AS district
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' = ANY(${cityParcelIds})
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
          ${placeTypeSqlFilter}
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `
    : await sql`
        SELECT body->>'parcelNodeId' AS parcel_node_id,
               body->>'district' AS district
        FROM atoms
        WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' LIKE ${COUNTY_FIPS + ":%"}
          AND NOT (body ? 'absence')
          AND coalesce(body->>'district', '') <> ''
          ${placeTypeSqlFilter}
        ORDER BY body->>'parcelNodeId'
        OFFSET ${args.offset}
        LIMIT ${args.limit}
      `;

const extractedAt = new Date().toISOString();
const effectiveDate = extractedAt.slice(0, 10);
let edgesWritten = 0;
let parcelsProcessed = 0;

for (const row of parcelRows) {
  const parcelNodeId = String(row.parcel_node_id);
  const district = String(row.district);
  if (args.placeTypeCohort && !isPlaceTypeDistrict(district, placeTypeDistrictCodes)) {
    continue;
  }
  if (!districtHasSetbackRow(district.trim().split(/\s+/)[0] ?? district)) {
    continue;
  }
  const entry = adjacencyIndex.entries.get(parcelNodeId);
  if (!entry) continue;

  const [, propId] = parcelNodeId.split(":");
  const atoms = computeBoundaryEdgeAtoms({
    parcelNodeId,
    countyFips: COUNTY_FIPS,
    propId,
    district,
    parcelRing: entry.ring,
    descriptor,
    adjacencyIndex,
    roads,
    situsAddress: entry.situsAddress ?? null,
    effectiveDate,
    extractedAt,
    sourceAdapter: descriptor.sourceAdapter,
    sourceUrl: descriptor.sourceUrl,
  });

  if (atoms.length === 0) continue;
  parcelsProcessed += 1;
  edgesWritten += atoms.length;

  if (!dryRun && storageHandle) {
    await persistBoundaryEdges(storageHandle.storage, atoms, { force: true });
  }
}

const wallMs = performance.now() - t0;
console.log(
  JSON.stringify({
    dryRun,
    placeTypeCohort: args.placeTypeCohort,
    cityCohort: args.cityCohort,
    cohortSize: parcelRows.length,
    parcelsProcessed,
    edgesWritten,
    wallMsTotal: Math.round(wallMs),
  }),
);

await sql.end({ timeout: 5 });
await txSql.end({ timeout: 5 });
if (storageHandle) await storageHandle.close();
