#!/usr/bin/env node
/**
 * ingest-tx-rrc-staging.mjs — statewide RRC well + pipeline staging load (P2-3).
 *
 * Streams paginated REST (1,000 cap/page) into Postgres without holding the full
 * layer in memory. County assignment for wells is a ONE-TIME post-load batched
 * join: txgio_parcel bbox prefilter + point-in-polygon (geo.ts).
 *
 * PostGIS is NOT used — geometry stored as jsonb + bbox btree indexes only.
 *
 *   RRC_STAGING_INGEST_PATH=1 \
 *   DEPLOYMENT_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-tx-rrc-staging [--apply]
 *
 * Flags: --wells-only, --pipelines-only, --skip-county-join. Dry-run streams
 * first page only.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

import { resolveWellStatus } from "../src/well-fact/symnum.ts";

const RRC_ROOT =
  "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";
const WELLS_LAYER = `${RRC_ROOT}/1`;
const ORPHAN_LAYER = `${RRC_ROOT}/2`;
const PIPELINES_LAYER = `${RRC_ROOT}/13`;

const SOURCE = "rrc-public-viewer-v1";
/** Data vintage is UNKNOWN at source; observedAt is the fetch timestamp. */
const SOURCE_VINTAGE = "UNKNOWN";
const PAGE_SIZE = 1000;
const INSERT_BATCH = 1000;
const LOG_EVERY_PAGES = 50;

const WELL_OUT_FIELDS =
  "OBJECTID,UNIQID,API,GIS_API5,GIS_WELL_NUMBER,SYMNUM,GIS_SYMBOL_DESCRIPTION,RELIAB,GIS_LOCATION_SOURCE,GIS_LAT83,GIS_LONG83";
const PIPELINE_OUT_FIELDS =
  "OBJECTID,P5_NUM,T4PERMIT,OPERATOR,SYSTEM_NAME,COMMODITY,COMMODITY_DESCRIPTION,SYSTEM_TYPE,STATUS,DIAMETER,INTERSTATE,COUNTY_FIPS,COUNTY_NAME";

function parseArgs(argv) {
  const out = {
    apply: false,
    wellsOnly: false,
    pipelinesOnly: false,
    skipCountyJoin: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--wells-only") out.wellsOnly = true;
    else if (a === "--pipelines-only") out.pipelinesOnly = true;
    else if (a === "--skip-county-join") out.skipCountyJoin = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  if (out.wellsOnly && out.pipelinesOnly) {
    console.error("FATAL: --wells-only and --pipelines-only are mutually exclusive.");
    process.exit(1);
  }
  return out;
}

if (process.env.RRC_STAGING_INGEST_PATH !== "1") {
  console.error("FATAL: RRC_STAGING_INGEST_PATH=1 required.");
  process.exit(1);
}

/** Windows Node often cannot verify the RRC GIS cert chain; public gov REST only. */
if (process.env.RRC_STAGING_TLS_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const args = parseArgs(process.argv.slice(2));
const loadWells = !args.pipelinesOnly;
const loadPipelines = !args.wellsOnly;
const observedAt = new Date().toISOString();

const poolUrl =
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!poolUrl) {
  console.error("FATAL: DEPLOYMENT_DATABASE_URL or CORTEX_DATABASE_URL required.");
  process.exit(1);
}

function rrcCountyFips(fips3) {
  const raw = String(fips3 ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `48${String(n).padStart(3, "0")}`;
}

function bboxFromPoint(lng, lat) {
  return { westLng: lng, southLat: lat, eastLng: lng, northLat: lat };
}

function bboxFromLineCoordinates(coords) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lng = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
      return;
    }
    for (const child of c) walk(child);
  };
  walk(coords);
  if (!Number.isFinite(west)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

function normalizeWellFeature(feature, orphanApis) {
  const p = feature.properties ?? {};
  const geom = feature.geometry;
  if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) return null;
  const lng = Number(p.GIS_LONG83 ?? geom.coordinates[0]);
  const lat = Number(p.GIS_LAT83 ?? geom.coordinates[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const objectId = Number(p.OBJECTID);
  if (!Number.isFinite(objectId)) return null;
  const symnum = Number(p.SYMNUM ?? 0);
  const symbolDescription =
    p.GIS_SYMBOL_DESCRIPTION != null ? String(p.GIS_SYMBOL_DESCRIPTION).trim() : "";
  const wellStatus = resolveWellStatus(symnum, symbolDescription);
  const api = p.API != null ? String(p.API).trim() : null;
  const bbox = bboxFromPoint(lng, lat);
  return {
    well_row_id: `rrc:${objectId}`,
    uniqid: p.UNIQID != null ? Number(p.UNIQID) : null,
    api,
    gis_api5: p.GIS_API5 != null ? String(p.GIS_API5).trim() : null,
    gis_well_number:
      p.GIS_WELL_NUMBER != null ? String(p.GIS_WELL_NUMBER).trim() : null,
    symnum: Number.isFinite(symnum) ? symnum : null,
    gis_symbol_description: symbolDescription || null,
    reliab: p.RELIAB != null ? String(p.RELIAB).trim() : null,
    gis_location_source:
      p.GIS_LOCATION_SOURCE != null ? String(p.GIS_LOCATION_SOURCE) : null,
    lng,
    lat,
    geometry: geom,
    ...bbox,
    county_fips: null,
    is_orphan: Boolean(api && orphanApis.has(api)),
    well_status: wellStatus,
    source: SOURCE,
    source_vintage: SOURCE_VINTAGE,
    source_citation: WELLS_LAYER,
  };
}

function normalizePipelineFeature(feature) {
  const p = feature.properties ?? {};
  const geom = feature.geometry;
  if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) {
    return null;
  }
  const bbox = bboxFromLineCoordinates(geom.coordinates);
  if (!bbox) return null;
  const objectId = Number(p.OBJECTID);
  if (!Number.isFinite(objectId)) return null;
  const countyFips = rrcCountyFips(p.COUNTY_FIPS);
  if (!countyFips) return null;
  return {
    pipeline_row_id: `rrc:${objectId}`,
    p5_num: p.P5_NUM != null ? String(p.P5_NUM).trim() : null,
    t4permit: p.T4PERMIT != null ? String(p.T4PERMIT).trim() : null,
    operator: p.OPERATOR != null ? String(p.OPERATOR).trim() : null,
    system_name: p.SYSTEM_NAME != null ? String(p.SYSTEM_NAME).trim() : null,
    commodity: p.COMMODITY != null ? String(p.COMMODITY).trim() : null,
    commodity_description:
      p.COMMODITY_DESCRIPTION != null ? String(p.COMMODITY_DESCRIPTION).trim() : null,
    system_type: p.SYSTEM_TYPE != null ? String(p.SYSTEM_TYPE).trim() : null,
    status: p.STATUS != null ? String(p.STATUS).trim() : null,
    diameter: p.DIAMETER != null ? Number(p.DIAMETER) : null,
    interstate: p.INTERSTATE != null ? String(p.INTERSTATE).trim() : null,
    county_fips: countyFips,
    county_name: p.COUNTY_NAME != null ? String(p.COUNTY_NAME).trim() : null,
    geometry: geom,
    ...bbox,
    source: SOURCE,
    source_vintage: SOURCE_VINTAGE,
    source_citation: PIPELINES_LAYER,
  };
}

async function fetchLayerCount(layerUrl) {
  const params = new URLSearchParams({
    where: "1=1",
    returnCountOnly: "true",
    f: "json",
  });
  const res = await fetch(`${layerUrl}/query?${params}`);
  if (!res.ok) throw new Error(`count HTTP ${res.status} ${layerUrl}`);
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return Number(body.count ?? 0);
}

async function fetchGeoJsonPage(layerUrl, offset, outFields) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    orderByFields: "OBJECTID",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: "geojson",
  });
  const res = await fetch(`${layerUrl}/query?${params}`);
  if (!res.ok) throw new Error(`query HTTP ${res.status} offset=${offset}`);
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.features ?? [];
}

async function loadOrphanApiSet(apply) {
  const apis = new Set();
  let offset = 0;
  let pageNum = 0;
  const maxPages = apply ? Infinity : 1;
  while (pageNum < maxPages) {
    const page = await fetchGeoJsonPage(ORPHAN_LAYER, offset, "OBJECTID,API");
    if (page.length === 0) break;
    for (const feature of page) {
      const api = feature.properties?.API;
      if (api != null && String(api).trim()) apis.add(String(api).trim());
    }
    offset += page.length;
    pageNum += 1;
    if (page.length < PAGE_SIZE) break;
  }
  return apis;
}

async function insertWellBatch(sql, batch) {
  if (batch.length === 0) return;
  const rows = batch.map((r) => ({
    well_row_id: r.well_row_id,
    uniqid: r.uniqid,
    api: r.api,
    gis_api5: r.gis_api5,
    gis_well_number: r.gis_well_number,
    symnum: r.symnum,
    gis_symbol_description: r.gis_symbol_description,
    reliab: r.reliab,
    gis_location_source: r.gis_location_source,
    lng: r.lng,
    lat: r.lat,
    geometry: sql.json(r.geometry),
    west_lng: r.westLng,
    south_lat: r.southLat,
    east_lng: r.eastLng,
    north_lat: r.northLat,
    county_fips: r.county_fips,
    is_orphan: r.is_orphan,
    well_status: r.well_status,
    source: r.source,
    source_vintage: r.source_vintage,
    source_citation: r.source_citation,
  }));
  await sql`
    INSERT INTO tx_rrc_well ${sql(
      rows,
      "well_row_id",
      "uniqid",
      "api",
      "gis_api5",
      "gis_well_number",
      "symnum",
      "gis_symbol_description",
      "reliab",
      "gis_location_source",
      "lng",
      "lat",
      "geometry",
      "west_lng",
      "south_lat",
      "east_lng",
      "north_lat",
      "county_fips",
      "is_orphan",
      "well_status",
      "source",
      "source_vintage",
      "source_citation",
    )}
    ON CONFLICT (well_row_id) DO UPDATE SET
      uniqid = EXCLUDED.uniqid,
      api = EXCLUDED.api,
      gis_api5 = EXCLUDED.gis_api5,
      gis_well_number = EXCLUDED.gis_well_number,
      symnum = EXCLUDED.symnum,
      gis_symbol_description = EXCLUDED.gis_symbol_description,
      reliab = EXCLUDED.reliab,
      gis_location_source = EXCLUDED.gis_location_source,
      lng = EXCLUDED.lng,
      lat = EXCLUDED.lat,
      geometry = EXCLUDED.geometry,
      west_lng = EXCLUDED.west_lng,
      south_lat = EXCLUDED.south_lat,
      east_lng = EXCLUDED.east_lng,
      north_lat = EXCLUDED.north_lat,
      county_fips = EXCLUDED.county_fips,
      is_orphan = EXCLUDED.is_orphan,
      well_status = EXCLUDED.well_status,
      source = EXCLUDED.source,
      source_vintage = EXCLUDED.source_vintage,
      source_citation = EXCLUDED.source_citation,
      ingested_at = now()
  `;
}

async function insertPipelineBatch(sql, batch) {
  if (batch.length === 0) return;
  const rows = batch.map((r) => ({
    pipeline_row_id: r.pipeline_row_id,
    p5_num: r.p5_num,
    t4permit: r.t4permit,
    operator: r.operator,
    system_name: r.system_name,
    commodity: r.commodity,
    commodity_description: r.commodity_description,
    system_type: r.system_type,
    status: r.status,
    diameter: r.diameter,
    interstate: r.interstate,
    county_fips: r.county_fips,
    county_name: r.county_name,
    geometry: sql.json(r.geometry),
    west_lng: r.westLng,
    south_lat: r.southLat,
    east_lng: r.eastLng,
    north_lat: r.northLat,
    source: r.source,
    source_vintage: r.source_vintage,
    source_citation: r.source_citation,
  }));
  await sql`
    INSERT INTO tx_rrc_pipeline ${sql(
      rows,
      "pipeline_row_id",
      "p5_num",
      "t4permit",
      "operator",
      "system_name",
      "commodity",
      "commodity_description",
      "system_type",
      "status",
      "diameter",
      "interstate",
      "county_fips",
      "county_name",
      "geometry",
      "west_lng",
      "south_lat",
      "east_lng",
      "north_lat",
      "source",
      "source_vintage",
      "source_citation",
    )}
    ON CONFLICT (pipeline_row_id) DO UPDATE SET
      p5_num = EXCLUDED.p5_num,
      t4permit = EXCLUDED.t4permit,
      operator = EXCLUDED.operator,
      system_name = EXCLUDED.system_name,
      commodity = EXCLUDED.commodity,
      commodity_description = EXCLUDED.commodity_description,
      system_type = EXCLUDED.system_type,
      status = EXCLUDED.status,
      diameter = EXCLUDED.diameter,
      interstate = EXCLUDED.interstate,
      county_fips = EXCLUDED.county_fips,
      county_name = EXCLUDED.county_name,
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

async function streamInsertWells(sql, orphanApis, apply) {
  let offset = 0;
  let pageNum = 0;
  let loaded = 0;
  let skipped = 0;
  let pending = [];
  const maxPages = apply ? Infinity : 1;

  if (apply) await sql`DELETE FROM tx_rrc_well`;

  while (pageNum < maxPages) {
    const page = await fetchGeoJsonPage(WELLS_LAYER, offset, WELL_OUT_FIELDS);
    if (page.length === 0) break;

    if (pageNum === 0 || (pageNum + 1) % LOG_EVERY_PAGES === 0) {
      console.error(
        JSON.stringify({
          event: "tx-rrc-staging.wells-page",
          page: pageNum + 1,
          offset,
          features: page.length,
          loaded,
        }),
      );
    }

    for (const feature of page) {
      const rec = normalizeWellFeature(feature, orphanApis);
      if (!rec) {
        skipped += 1;
        continue;
      }
      pending.push(rec);
      loaded += 1;
      if (apply && pending.length >= INSERT_BATCH) {
        await insertWellBatch(sql, pending);
        pending = [];
      }
    }

    offset += page.length;
    pageNum += 1;
    if (page.length < PAGE_SIZE) break;
  }

  if (apply && pending.length > 0) await insertWellBatch(sql, pending);
  return { loaded, skipped, pages: pageNum };
}

async function streamInsertPipelines(sql, apply) {
  let offset = 0;
  let pageNum = 0;
  let loaded = 0;
  let skipped = 0;
  let pending = [];
  const maxPages = apply ? Infinity : 1;

  if (apply) await sql`DELETE FROM tx_rrc_pipeline`;

  while (pageNum < maxPages) {
    const page = await fetchGeoJsonPage(PIPELINES_LAYER, offset, PIPELINE_OUT_FIELDS);
    if (page.length === 0) break;

    if (pageNum === 0 || (pageNum + 1) % LOG_EVERY_PAGES === 0) {
      console.error(
        JSON.stringify({
          event: "tx-rrc-staging.pipelines-page",
          page: pageNum + 1,
          offset,
          features: page.length,
          loaded,
        }),
      );
    }

    for (const feature of page) {
      const rec = normalizePipelineFeature(feature);
      if (!rec) {
        skipped += 1;
        continue;
      }
      pending.push(rec);
      loaded += 1;
      if (apply && pending.length >= INSERT_BATCH) {
        await insertPipelineBatch(sql, pending);
        pending = [];
      }
    }

    offset += page.length;
    pageNum += 1;
    if (page.length < PAGE_SIZE) break;
  }

  if (apply && pending.length > 0) await insertPipelineBatch(sql, pending);
  return { loaded, skipped, pages: pageNum };
}

/**
 * ONE-TIME county join via batched SQL: txgio_parcel bbox overlap, smallest
 * parcel wins (approximate point-in-county for staging partition). Wells
 * outside parcel coverage remain null.
 */
async function joinWellCountiesBatched(sql) {
  let totalUpdated = 0;
  let batches = 0;

  while (true) {
    const updated = await sql`
      WITH batch AS (
        SELECT well_row_id, lng, lat
        FROM tx_rrc_well
        WHERE county_fips IS NULL
        ORDER BY well_row_id
        LIMIT 5000
      ),
      picked AS (
        SELECT DISTINCT ON (b.well_row_id)
          b.well_row_id,
          p.county_fips
        FROM batch b
        INNER JOIN txgio_parcel p ON
          b.lng >= p.west_lng AND b.lng <= p.east_lng
          AND b.lat >= p.south_lat AND b.lat <= p.north_lat
        ORDER BY
          b.well_row_id,
          (p.east_lng - p.west_lng) * (p.north_lat - p.south_lat)
      )
      UPDATE tx_rrc_well w
      SET county_fips = p.county_fips
      FROM picked p
      WHERE w.well_row_id = p.well_row_id
      RETURNING w.well_row_id
    `;
    if (updated.length === 0) break;
    batches += 1;
    totalUpdated += updated.length;
    if (batches % 10 === 0) {
      console.error(
        JSON.stringify({
          event: "tx-rrc-staging.county-join",
          batches,
          totalUpdated,
        }),
      );
    }
  }

  const nullRow = await sql`
    SELECT count(*)::int AS n FROM tx_rrc_well WHERE county_fips IS NULL
  `;

  return {
    method:
      "batched SQL join txgio_parcel on bbox overlap; smallest parcel wins (approximate point-in-county)",
    totalUpdated,
    nullRemaining: nullRow[0]?.n ?? 0,
    batches,
  };
}

const t0 = performance.now();
const report = {
  event: args.apply ? "tx-rrc-staging.ingest-apply" : "tx-rrc-staging.ingest-dry-run",
  observedAt,
  loadWells,
  loadPipelines,
  expectedWellCount: null,
  expectedPipelineCount: null,
  expectedOrphanCount: null,
  wellsLoaded: 0,
  wellsSkipped: 0,
  pipelinesLoaded: 0,
  pipelinesSkipped: 0,
  orphanApisLoaded: 0,
  countyJoin: null,
  wellsInTable: null,
  pipelinesInTable: null,
  elapsedMs: 0,
};

if (loadWells) {
  report.expectedWellCount = await fetchLayerCount(WELLS_LAYER);
  report.expectedOrphanCount = await fetchLayerCount(ORPHAN_LAYER);
}
if (loadPipelines) {
  report.expectedPipelineCount = await fetchLayerCount(PIPELINES_LAYER);
}

const sql = args.apply
  ? postgres(poolUrl, { max: 4, ssl: "require", prepare: false })
  : null;

try {
  const orphanApis = loadWells ? await loadOrphanApiSet(args.apply) : new Set();
  report.orphanApisLoaded = orphanApis.size;

  if (loadWells) {
    if (args.apply) {
      const reg = await sql`SELECT to_regclass('public.tx_rrc_well') AS reg`;
      if (reg[0]?.reg == null) {
        throw new Error("tx_rrc_well missing — run apply-tx-rrc-staging-migration first");
      }
    }
    const wellResult = await streamInsertWells(sql, orphanApis, args.apply);
    report.wellsLoaded = wellResult.loaded;
    report.wellsSkipped = wellResult.skipped;
    report.wellPages = wellResult.pages;

    if (args.apply && !args.skipCountyJoin) {
      report.countyJoin = await joinWellCountiesBatched(sql);
      const countRow = await sql`SELECT count(*)::int AS n FROM tx_rrc_well`;
      report.wellsInTable = countRow[0]?.n ?? 0;
    }
  }

  if (loadPipelines) {
    if (args.apply) {
      const reg = await sql`SELECT to_regclass('public.tx_rrc_pipeline') AS reg`;
      if (reg[0]?.reg == null) {
        throw new Error("tx_rrc_pipeline missing — run apply-tx-rrc-staging-migration first");
      }
    }
    const pipeResult = await streamInsertPipelines(sql, args.apply);
    report.pipelinesLoaded = pipeResult.loaded;
    report.pipelinesSkipped = pipeResult.skipped;
    report.pipelinePages = pipeResult.pages;

    if (args.apply) {
      const countRow = await sql`SELECT count(*)::int AS n FROM tx_rrc_pipeline`;
      report.pipelinesInTable = countRow[0]?.n ?? 0;
    }
  }
} finally {
  if (sql) await sql.end({ timeout: 10 });
}

report.elapsedMs = Math.round(performance.now() - t0);
console.log(JSON.stringify(report));
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
