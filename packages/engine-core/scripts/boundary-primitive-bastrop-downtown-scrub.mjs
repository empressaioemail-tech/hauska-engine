#!/usr/bin/env node
/**
 * boundary-primitive-bastrop-downtown-scrub.mjs — F3 lot-line geometry scrub
 * for the BDC downtown drill manifest ONLY (36 parcels).
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... TXGIO_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run boundary-primitive-bastrop-downtown-scrub -- \
 *       [--dry-run] [--parcel=48021:34073]
 *
 * Rescrubs rings from authoritative BCAD public geometry, snaps shared lot lines,
 * rebuilds boundary primitive + property-boundary-edge atoms. Does NOT re-warm
 * buildable-envelope atoms (STEP 4).
 */

import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { getSetbackTable } from "@hauska-engine/adapters";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { resolveSetbackTableRow } from "../src/property-reasoning/emit-setback-rule.ts";
import { setbackTableDescriptorFromAdapter } from "../src/property-reasoning/setback-table-from-adapter.ts";
import {
  buildParcelAdjacencyIndex,
  computeBoundaryEdgeAtoms,
  fetchBcadParcelRings,
  persistBoundaryEdges,
  roadAtomBodyToWarmSource,
  scrubParcelCohortEntries,
} from "../src/boundary-primitive/index.ts";
import { DOWNTOWN_DRILL_MANIFEST_PROP_IDS } from "../src/boundary-primitive/fixtures/bastropDowntownDrill.ts";

const COUNTY_FIPS = "48021";

const adapterSetbackTable = getSetbackTable("bastrop-development-code");
const setbackTableFromAdapter = setbackTableDescriptorFromAdapter(adapterSetbackTable);
if (!setbackTableFromAdapter?.rows?.length) {
  console.error("FATAL: bastrop-development-code adapter setback table missing or empty.");
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

function parseArgs(argv) {
  const out = { parcel: null, dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--parcel=")) out.parcel = a.slice("--parcel=".length).trim();
    else if (a === "--parcel") out.parcel = String(argv[argv.indexOf(a) + 1] ?? "").trim();
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

const manifestPropIds = args.parcel
  ? [args.parcel.split(":")[1] ?? args.parcel]
  : [...DOWNTOWN_DRILL_MANIFEST_PROP_IDS];

const t0 = performance.now();
console.log(JSON.stringify({ step: "fetch-bcad", propCount: manifestPropIds.length }));

const bcadRows = await fetchBcadParcelRings(manifestPropIds);
const bcadByProp = new Map(bcadRows.map((r) => [r.propId, r]));

/** @type {import('@hauska-engine/storage').StoragePort | null} */
let storageHandle = null;
/** @type {import('postgres').Sql | null} */
let sql = null;
/** @type {import('postgres').Sql | null} */
let txSql = null;

if (substrateUrl) {
  sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
  if (!dryRun) {
    storageHandle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
  }
}
if (txgioUrl) {
  txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });
}

const situsByProp = new Map();
if (txSql) {
  const situsRows = await txSql`
    SELECT prop_id, situs_address
    FROM txgio_parcel
    WHERE county_fips = ${COUNTY_FIPS}
      AND prop_id = ANY(${manifestPropIds.map(String)})
  `;
  for (const row of situsRows) {
    const raw = typeof row.situs_address === "string" ? row.situs_address.trim() : "";
    if (raw) situsByProp.set(String(row.prop_id), raw);
  }
}

const cohortEntries = [];
const diagnosis = [];

for (const propId of manifestPropIds) {
  const bcad = bcadByProp.get(String(propId));
  if (!bcad) {
    diagnosis.push({ prop_id: propId, root_cause: "bcad-fetch-miss", fix: "skipped", pass: false });
    continue;
  }
  const beforeVerts = bcad.ring[0] ? bcad.ring.length - 1 : 0;
  cohortEntries.push({
    countyFips: COUNTY_FIPS,
    propId: String(propId),
    parcelNodeId: `${COUNTY_FIPS}:${propId}`,
    situsAddress: situsByProp.get(String(propId)) ?? null,
    ring: bcad.ring,
    westLng: bcad.westLng,
    southLat: bcad.southLat,
    eastLng: bcad.eastLng,
    northLat: bcad.northLat,
  });
  diagnosis.push({
    prop_id: propId,
    root_cause: beforeVerts > 6 ? "extra-lot-line-vertices" : "bcad-authoritative-rescrub",
    fix: "bcad-fetch+lot-line-scrub+snap",
    pass: true,
  });
}

const scrubbedEntries = scrubParcelCohortEntries(cohortEntries);
for (const entry of scrubbedEntries) {
  const hit = diagnosis.find((d) => String(d.prop_id) === entry.propId);
  if (hit) {
    const afterVerts = entry.ring.length > 0 ? entry.ring.length - 1 : 0;
    hit.after_vertex_count = afterVerts;
  }
}

const adjacencyIndex = buildParcelAdjacencyIndex(COUNTY_FIPS, scrubbedEntries);

let roadRows = [];
if (sql) {
  roadRows = await sql`
    SELECT body
    FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${COUNTY_FIPS}
      AND coalesce(body->>'status', 'active') = 'active'
  `;
}
const roads = roadRows.map((r) => roadAtomBodyToWarmSource(r.body)).filter(Boolean);

let parcelRows = [];
if (sql) {
  const nodeIds = scrubbedEntries.map((e) => e.parcelNodeId);
  parcelRows = await sql`
    SELECT body->>'parcelNodeId' AS parcel_node_id,
           body->>'district' AS district
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ANY(${nodeIds})
      AND NOT (body ? 'absence')
      AND coalesce(body->>'district', '') <> ''
  `;
}

const extractedAt = new Date().toISOString();
const effectiveDate = extractedAt.slice(0, 10);
let edgesWritten = 0;
let parcelsProcessed = 0;

for (const row of parcelRows) {
  const parcelNodeId = String(row.parcel_node_id);
  const district = String(row.district);
  if (!districtHasSetbackRow(district.trim().split(/\s+/)[0] ?? district)) continue;

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
    bcadFetched: bcadRows.length,
    cohortScrubbed: scrubbedEntries.length,
    parcelsProcessed,
    edgesWritten,
    wallMsTotal: Math.round(wallMs),
    diagnosisSample: diagnosis.filter((d) => [34073, 34081, 105054].includes(Number(d.prop_id))),
  }),
);

if (sql) await sql.end({ timeout: 5 });
if (txSql) await txSql.end({ timeout: 5 });
if (storageHandle) await storageHandle.close();
