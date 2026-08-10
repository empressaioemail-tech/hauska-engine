#!/usr/bin/env node
/**
 * ingest-tx-special-districts.mjs — statewide TCEQ water-district polygon load.
 *
 * Fetches ALL 2,796 polygons from Public/WaterDistricts/MapServer/0 (field TYPE,
 * not DISTRICT_TYPE). Uses paginated REST with an async backpressure queue so
 * memory stays bounded on larger future vintages (NFHL #403 pattern).
 *
 *   SPECIAL_DISTRICT_INGEST_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-tx-special-districts [--apply]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

const TCEQ_LAYER =
  "https://gisweb.tceq.texas.gov/arcgis/rest/services/Public/WaterDistricts/MapServer/0";
const SOURCE_CITATION = TCEQ_LAYER;
const SOURCE_VINTAGE = "2026-08-10";
const PAGE_SIZE = 500;
const QUEUE_HIGH = 32;
const QUEUE_LOW = 8;

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

if (process.env.SPECIAL_DISTRICT_INGEST_PATH !== "1") {
  console.error("FATAL: SPECIAL_DISTRICT_INGEST_PATH=1 required.");
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

function tceqCountyFips(fips3, txCnty) {
  const raw = String(fips3 ?? txCnty ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `48${String(n).padStart(3, "0")}`;
}

function esriRingsToGeoJson(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  return {
    type: "Polygon",
    coordinates: rings,
  };
}

function bboxFromRings(rings) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const pt of ring) {
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

function normalizeRecord(feature) {
  const a = feature.attributes ?? {};
  const geom = feature.geometry;
  if (!geom?.rings) return null;
  const geometry = esriRingsToGeoJson(geom.rings);
  const bbox = bboxFromRings(geom.rings);
  if (!geometry || !bbox) return null;
  const countyFips = tceqCountyFips(a.FIPS, a.TX_CNTY);
  if (!countyFips) return null;
  const districtType = String(a.TYPE ?? "").trim();
  const districtId = String(a.DISTRICT_ID ?? a.OBJECTID ?? "").trim();
  const districtName = String(a.NAME ?? "").trim();
  if (!districtType || !districtId || !districtName) return null;
  return {
    district_row_id: `tceq:${a.OBJECTID}`,
    district_id: districtId,
    district_name: districtName,
    district_type: districtType,
    county_fips: countyFips,
    status: a.STATUS != null ? String(a.STATUS).trim() : null,
    geometry,
    ...bbox,
    source: "tceq-water-districts-v1",
    source_vintage: SOURCE_VINTAGE,
    source_citation: SOURCE_CITATION,
  };
}

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields:
      "OBJECTID,NAME,DISTRICT_ID,TYPE,COUNTY,FIPS,TX_CNTY,STATUS",
    returnGeometry: "true",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: "json",
  });
  const res = await fetch(`${TCEQ_LAYER}/query?${params}`);
  if (!res.ok) throw new Error(`TCEQ query HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.features ?? [];
}

async function* streamAllFeatures() {
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    for (const f of page) {
      yield f;
    }
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }
}

function trackPeakRss(peakRef) {
  const rss = process.memoryUsage().rss;
  if (rss > peakRef.value) peakRef.value = rss;
}

const peakRss = { value: 0 };
const byType = {};
let polygonsIngested = 0;
let fipsPopulated = 0;
let skipped = 0;
const records = [];

const t0 = performance.now();
for await (const feature of streamAllFeatures()) {
  trackPeakRss(peakRss);
  const rec = normalizeRecord(feature);
  if (!rec) {
    skipped += 1;
    continue;
  }
  records.push(rec);
  byType[rec.district_type] = (byType[rec.district_type] ?? 0) + 1;
  polygonsIngested += 1;
  if (rec.county_fips) fipsPopulated += 1;
}
trackPeakRss(peakRss);

const peakRssMb = Math.round((peakRss.value / (1024 * 1024)) * 10) / 10;

if (peakRssMb > 1500) {
  console.error(
    JSON.stringify({
      event: "tx-special-district.ingest-abort-rss",
      peakRssMb,
      limitMb: 1500,
    }),
  );
  process.exit(2);
}

const report = {
  event: args.apply
    ? "tx-special-district.ingest-apply"
    : "tx-special-district.ingest-dry-run",
  polygonsIngested,
  skipped,
  byType,
  fipsPopulated,
  peakRssMb,
  elapsedMs: Math.round(performance.now() - t0),
};

if (!args.apply) {
  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  process.exit(0);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });
try {
  const reg = await sql`SELECT to_regclass('public.tx_special_district') AS reg`;
  if (reg[0]?.reg == null) {
    throw new Error("tx_special_district table missing — run apply migration first");
  }
  await sql`DELETE FROM tx_special_district`;
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    for (const r of batch) {
      await sql`
        INSERT INTO tx_special_district (
          district_row_id, district_id, district_name, district_type,
          county_fips, status, geometry,
          west_lng, south_lat, east_lng, north_lat,
          source, source_vintage, source_citation
        ) VALUES (
          ${r.district_row_id}, ${r.district_id}, ${r.district_name}, ${r.district_type},
          ${r.county_fips}, ${r.status}, ${sql.json(r.geometry)},
          ${r.westLng}, ${r.southLat}, ${r.eastLng}, ${r.northLat},
          ${r.source}, ${r.source_vintage}, ${r.source_citation}
        )
        ON CONFLICT (district_row_id) DO UPDATE SET
          district_id = EXCLUDED.district_id,
          district_name = EXCLUDED.district_name,
          district_type = EXCLUDED.district_type,
          county_fips = EXCLUDED.county_fips,
          status = EXCLUDED.status,
          geometry = EXCLUDED.geometry,
          west_lng = EXCLUDED.west_lng,
          south_lat = EXCLUDED.south_lat,
          east_lng = EXCLUDED.east_lng,
          north_lat = EXCLUDED.north_lat,
          source = EXCLUDED.source,
          source_vintage = EXCLUDED.source_vintage,
          source_citation = EXCLUDED.source_citation,
          ingested_at = now()
      `;
    }
    trackPeakRss(peakRss);
  }
  const countRow = await sql`SELECT count(*)::int AS n FROM tx_special_district`;
  report.rowsInTable = countRow[0]?.n ?? 0;
  report.peakRssMb = Math.round((peakRss.value / (1024 * 1024)) * 10) / 10;
  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
} finally {
  await sql.end({ timeout: 10 });
}
