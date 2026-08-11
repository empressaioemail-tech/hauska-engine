#!/usr/bin/env node
/**
 * ingest-tx-building-footprints.mjs — statewide Microsoft ML footprint load (P2-4).
 *
 * Streams Texas.geojson.zip once, assigns county_fips via centroid-in-county-bbox
 * (txgio_parcel roster), replace-loads tx_building_footprint.
 *
 *   BUILDING_FOOTPRINT_INGEST_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-tx-building-footprints [--apply]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

import {
  FOOTPRINT_WRITER_ADAPTER,
  ML_FOOTPRINT_SOURCE_CITATION,
  ML_FOOTPRINT_SOURCE_VINTAGE,
  ensureTexasMlZipCached,
  streamTexasMlFeatures,
} from "../src/building-footprint/index.ts";
import {
  bboxArea,
  bboxContainsPoint,
  bboxFromRing,
  geometryOuterRing,
  ringCentroid,
  ringToFootprintGeometry,
} from "../src/building-footprint/geo.ts";

const BATCH_SIZE = 2000;
const INSERT_COLUMNS = [
  "footprint_row_id",
  "footprint_id",
  "geometry",
  "west_lng",
  "south_lat",
  "east_lng",
  "north_lat",
  "county_fips",
  "source",
  "source_tier",
  "source_vintage",
  "source_citation",
];
const SOURCE = FOOTPRINT_WRITER_ADAPTER;

function parseArgs(argv) {
  const out = { apply: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

if (process.env.BUILDING_FOOTPRINT_INGEST_PATH !== "1") {
  console.error("FATAL: BUILDING_FOOTPRINT_INGEST_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required.");
  process.exit(1);
}

function parseMlFeature(feat, seq) {
  const ring = geometryOuterRing(feat.geometry);
  if (!ring) return null;
  const bbox = bboxFromRing(ring);
  if (!bbox) return null;
  const geometry = ringToFootprintGeometry(ring);
  const rawId = feat.properties?.id ?? feat.id ?? `ml-${seq}`;
  const footprintId = String(rawId);
  return {
    footprint_row_id: `ml:${footprintId}`,
    footprint_id: footprintId,
    geometry,
    ...bbox,
    source: SOURCE,
    source_tier: "ml-derived",
    source_vintage: ML_FOOTPRINT_SOURCE_VINTAGE,
    source_citation: ML_FOOTPRINT_SOURCE_CITATION,
  };
}

function assignCountyFips(centroid, countyBboxes) {
  const matches = countyBboxes.filter((c) => bboxContainsPoint(c, centroid));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].countyFips;
  matches.sort((a, b) => bboxArea(a) - bboxArea(b));
  return matches[0].countyFips;
}

async function loadCountyBboxes(sql) {
  // tx_county_boundary has all 254 TX counties; txgio_parcel only ~196 loaded.
  const rows = await sql`
    SELECT county_fips,
           west_lng::float8 AS west_lng,
           south_lat::float8 AS south_lat,
           east_lng::float8 AS east_lng,
           north_lat::float8 AS north_lat
    FROM tx_county_boundary
    WHERE state_fips = '48'
    ORDER BY county_fips
  `;
  return rows.map((r) => ({
    countyFips: r.county_fips,
    westLng: Number(r.west_lng),
    southLat: Number(r.south_lat),
    eastLng: Number(r.east_lng),
    northLat: Number(r.north_lat),
  }));
}

async function postgisGeomAvailable(sql) {
  try {
    const ext = await sql`
      SELECT extname FROM pg_extension WHERE extname = 'postgis'
    `;
    if (ext.length === 0) return false;
    const col = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tx_building_footprint'
        AND column_name = 'geom'
    `;
    return col.length > 0;
  } catch {
    return false;
  }
}

async function insertBatch(sql, batch) {
  if (batch.length === 0) return;

  const insertRows = batch.map((r) => ({
    footprint_row_id: r.footprint_row_id,
    footprint_id: r.footprint_id,
    geometry: sql.json(r.geometry),
    west_lng: r.westLng,
    south_lat: r.southLat,
    east_lng: r.eastLng,
    north_lat: r.northLat,
    county_fips: r.county_fips,
    source: r.source,
    source_tier: r.source_tier,
    source_vintage: r.source_vintage,
    source_citation: r.source_citation,
  }));

  await sql`
    INSERT INTO tx_building_footprint ${sql(insertRows, ...INSERT_COLUMNS)}
    ON CONFLICT (footprint_row_id) DO UPDATE SET
      footprint_id = EXCLUDED.footprint_id,
      geometry = EXCLUDED.geometry,
      west_lng = EXCLUDED.west_lng,
      south_lat = EXCLUDED.south_lat,
      east_lng = EXCLUDED.east_lng,
      north_lat = EXCLUDED.north_lat,
      county_fips = EXCLUDED.county_fips,
      source = EXCLUDED.source,
      source_tier = EXCLUDED.source_tier,
      source_vintage = EXCLUDED.source_vintage,
      source_citation = EXCLUDED.source_citation,
      ingested_at = now()
  `;
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

let featuresScanned = 0;
let rowsLoaded = 0;
let countyFipsPopulated = 0;
let skippedNoCounty = 0;
let skippedInvalid = 0;
let sourceBytes = 0;

const t0 = performance.now();

try {
  const reg = await sql`SELECT to_regclass('public.tx_building_footprint') AS reg`;
  if (reg[0]?.reg == null) {
    throw new Error("tx_building_footprint table missing — run apply migration first");
  }

  const countyBboxes = await loadCountyBboxes(sql);
  const cached = await ensureTexasMlZipCached();
  sourceBytes = cached.bytesOnDisk;

  const usePostgisGeom = false; // GiST column exists; geom backfill is a separate pass at 10.7M scale.

  if (args.apply) {
    await sql`DELETE FROM tx_building_footprint`;
  }

  let batch = [];

  for await (const feat of streamTexasMlFeatures({ zipPath: cached.zipPath })) {
    featuresScanned += 1;
    if (featuresScanned % 500_000 === 0) {
      console.error(
        JSON.stringify({
          event: "tx-building-footprint.ingest-progress",
          featuresScanned,
          rowsLoaded,
          skippedNoCounty,
        }),
      );
    }

    const rec = parseMlFeature(feat, featuresScanned);
    if (!rec) {
      skippedInvalid += 1;
      continue;
    }

    const ring = geometryOuterRing(rec.geometry);
    if (!ring) {
      skippedInvalid += 1;
      continue;
    }
    const centroid = ringCentroid(ring);
    const countyFips = assignCountyFips(centroid, countyBboxes);
    if (!countyFips) {
      skippedNoCounty += 1;
      continue;
    }

    rec.county_fips = countyFips;
    countyFipsPopulated += 1;

    if (args.apply) {
      batch.push(rec);
      if (batch.length >= BATCH_SIZE) {
        await insertBatch(sql, batch);
        rowsLoaded += batch.length;
        batch = [];
      }
    } else {
      rowsLoaded += 1;
    }
  }

  if (args.apply && batch.length > 0) {
    await insertBatch(sql, batch, usePostgisGeom);
    rowsLoaded += batch.length;
  }

  const loadWallMs = Math.round(performance.now() - t0);
  const report = {
    event: args.apply
      ? "tx-building-footprint.ingest-apply"
      : "tx-building-footprint.ingest-dry-run",
    rowsLoaded,
    sourceBytes,
    loadWallMs,
    featuresScanned,
    countyFipsPopulated,
    skippedNoCounty,
    skippedInvalid,
    gistIndexPopulated: usePostgisGeom,
    countyBboxCount: countyBboxes.length,
  };

  if (args.apply) {
    const countRow = await sql`SELECT count(*)::int AS n FROM tx_building_footprint`;
    report.rowsInTable = countRow[0]?.n ?? 0;
  }

  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
} finally {
  await sql.end({ timeout: 10 });
}
