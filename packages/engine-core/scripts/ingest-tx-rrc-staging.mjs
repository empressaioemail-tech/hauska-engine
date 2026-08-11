#!/usr/bin/env node
/**
 * ingest-tx-rrc-staging.mjs — statewide RRC well + pipeline staging load (P2-3).
 *
 * Wells layer 1, pipelines layer 13, orphan API set from layer 2. Paginated REST
 * with orderByFields=OBJECTID (1,000 cap/page). County assignment for wells is a
 * ONE-TIME post-load join against txgio_parcel bboxes + point-in-polygon.
 *
 * PostGIS is NOT used — geometry stored as jsonb + bbox btree indexes only.
 *
 *   RRC_STAGING_INGEST_PATH=1 \
 *   DEPLOYMENT_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run ingest-tx-rrc-staging [--apply]
 *
 * Flags: --wells-only, --pipelines-only. Dry-run (default) streams first page only.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

import { bboxContainsPoint } from "../src/well-fact/geo.ts";
import { resolveWellStatus } from "../src/well-fact/symnum.ts";

const RRC_ROOT =
  "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";
const WELLS_LAYER = `${RRC_ROOT}/1`;
const ORPHAN_LAYER = `${RRC_ROOT}/2`;
const PIPELINES_LAYER = `${RRC_ROOT}/13`;

const SOURCE = "rrc-public-viewer-v1";
const SOURCE_VINTAGE = "2026-08-11";
const PAGE_SIZE = 1000;
const BATCH_SIZE = 200;
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
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--wells-only") out.wellsOnly = true;
    else if (a === "--pipelines-only") out.pipelinesOnly = true;
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

const args = parseArgs(process.argv.slice(2));
const loadWells = !args.pipelinesOnly;
const loadPipelines = !args.wellsOnly;

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
  return {
    westLng: lng,
    southLat: lat,
    eastLng: lng,
    northLat: lat,
  };
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

function normalizeWellFeature(feature) {
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
  const bbox = bboxFromPoint(lng, lat);
  return {
    well_row_id: `rrc:${objectId}`,
    uniqid: p.UNIQID != null ? Number(p.UNIQID) : null,
    api: p.API != null ? String(p.API).trim() : null,
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
    is_orphan: false,
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

async function fetchGeoJsonPage(layerUrl, offset, outFields, maxPages) {
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
  const features = body.features ?? [];
  const pageIndex = Math.floor(offset / PAGE_SIZE) + 1;
  if (pageIndex % LOG_EVERY_PAGES === 0 || pageIndex === 1) {
    console.error(
      JSON.stringify({
        event: "tx-rrc-staging.page",
        layer: layerUrl,
        page: pageIndex,
        offset,
        features: features.length,
        maxPages: maxPages ?? null,
      }),
    );
  }
  return features;
}

async function* streamLayer(layerUrl, outFields, { apply, maxPages }) {
  let offset = 0;
  let pageNum = 0;
  while (true) {
    if (maxPages != null && pageNum >= maxPages) break;
    const page = await fetchGeoJsonPage(layerUrl, offset, outFields, maxPages);
    if (page.length === 0) break;
    for (const f of page) yield f;
    offset += page.length;
    pageNum += 1;
    if (page.length < PAGE_SIZE) break;
  }
}

async function loadOrphanApiSet(apply) {
  const apis = new Set();
  const maxPages = apply ? null : 1;
  for await (const feature of streamLayer(ORPHAN_LAYER, "OBJECTID,API", {
    apply,
    maxPages,
  })) {
    const api = feature.properties?.API;
    if (api != null && String(api).trim()) apis.add(String(api).trim());
  }
  return apis;
}

async function streamWells(apply) {
  const maxPages = apply ? null : 1;
  const wells = [];
  let skipped = 0;
  for await (const feature of streamLayer(WELLS_LAYER, WELL_OUT_FIELDS, {
    apply,
    maxPages,
  })) {
    const rec = normalizeWellFeature(feature);
    if (!rec) {
      skipped += 1;
      continue;
    }
    wells.push(rec);
  }
  return { wells, skipped };
}

async function streamPipelines(apply) {
  const maxPages = apply ? null : 1;
  const pipelines = [];
  let skipped = 0;
  for await (const feature of streamLayer(PIPELINES_LAYER, PIPELINE_OUT_FIELDS, {
    apply,
    maxPages,
  })) {
    const rec = normalizePipelineFeature(feature);
    if (!rec) {
      skipped += 1;
      continue;
    }
    pipelines.push(rec);
  }
  return { pipelines, skipped };
}

async function loadCountyBboxes(sql) {
  const rows = await sql`
    SELECT county_fips,
           min(west_lng)::float8 AS west_lng,
           min(south_lat)::float8 AS south_lat,
           max(east_lng)::float8 AS east_lng,
           max(north_lat)::float8 AS north_lat
    FROM txgio_parcel
    GROUP BY county_fips
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

function assignCountyFromBboxes(lng, lat, countyBboxes) {
  const matches = countyBboxes.filter((c) =>
    bboxContainsPoint(c, lng, lat),
  );
  if (matches.length === 1) return matches[0].countyFips;
  return null;
}

async function resolveAmbiguousCounty(sql, well, countyBboxes) {
  const candidates = countyBboxes.filter((c) =>
    bboxContainsPoint(c, well.lng, well.lat),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].countyFips;

  const fipsList = candidates.map((c) => c.countyFips);
  const pad = 0.002;
  const rows = await sql`
    SELECT county_fips, geometry
    FROM txgio_parcel
    WHERE county_fips = ANY(${fipsList})
      AND west_lng <= ${well.lng + pad}
      AND east_lng >= ${well.lng - pad}
      AND south_lat <= ${well.lat + pad}
      AND north_lat >= ${well.lat - pad}
    LIMIT 500
  `;
  const { pointInGeoJson } = await import("../src/well-fact/geo.ts");
  const hits = new Set();
  for (const row of rows) {
    if (pointInGeoJson(well.lng, well.lat, row.geometry)) {
      hits.add(row.county_fips);
    }
  }
  if (hits.size === 1) return [...hits][0];
  return null;
}

async function assignWellCounties(sql, wells) {
  const countyBboxes = await loadCountyBboxes(sql);
  let direct = 0;
  let resolved = 0;
  let unresolved = 0;

  for (const well of wells) {
    const directFips = assignCountyFromBboxes(well.lng, well.lat, countyBboxes);
    if (directFips) {
      well.county_fips = directFips;
      direct += 1;
      continue;
    }
    const ambiguousFips = await resolveAmbiguousCounty(sql, well, countyBboxes);
    if (ambiguousFips) {
      well.county_fips = ambiguousFips;
      resolved += 1;
    } else {
      unresolved += 1;
    }
  }

  return { direct, resolved, unresolved, countyBboxesLoaded: countyBboxes.length };
}

async function insertWells(sql, wells) {
  await sql`DELETE FROM tx_rrc_well`;
  for (let i = 0; i < wells.length; i += BATCH_SIZE) {
    const batch = wells.slice(i, i + BATCH_SIZE);
    for (const r of batch) {
      await sql`
        INSERT INTO tx_rrc_well (
          well_row_id, uniqid, api, gis_api5, gis_well_number,
          symnum, gis_symbol_description, reliab, gis_location_source,
          lng, lat, geometry, west_lng, south_lat, east_lng, north_lat,
          county_fips, is_orphan, well_status,
          source, source_vintage, source_citation
        ) VALUES (
          ${r.well_row_id}, ${r.uniqid}, ${r.api}, ${r.gis_api5}, ${r.gis_well_number},
          ${r.symnum}, ${r.gis_symbol_description}, ${r.reliab}, ${r.gis_location_source},
          ${r.lng}, ${r.lat}, ${sql.json(r.geometry)},
          ${r.westLng}, ${r.southLat}, ${r.eastLng}, ${r.northLat},
          ${r.county_fips}, ${r.is_orphan}, ${r.well_status},
          ${r.source}, ${r.source_vintage}, ${r.source_citation}
        )
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
  }
}

async function insertPipelines(sql, pipelines) {
  await sql`DELETE FROM tx_rrc_pipeline`;
  for (let i = 0; i < pipelines.length; i += BATCH_SIZE) {
    const batch = pipelines.slice(i, i + BATCH_SIZE);
    for (const r of batch) {
      await sql`
        INSERT INTO tx_rrc_pipeline (
          pipeline_row_id, p5_num, t4permit, operator, system_name,
          commodity, commodity_description, system_type, status,
          diameter, interstate, county_fips, county_name,
          geometry, west_lng, south_lat, east_lng, north_lat,
          source, source_vintage, source_citation
        ) VALUES (
          ${r.pipeline_row_id}, ${r.p5_num}, ${r.t4permit}, ${r.operator}, ${r.system_name},
          ${r.commodity}, ${r.commodity_description}, ${r.system_type}, ${r.status},
          ${r.diameter}, ${r.interstate}, ${r.county_fips}, ${r.county_name},
          ${sql.json(r.geometry)},
          ${r.westLng}, ${r.southLat}, ${r.eastLng}, ${r.northLat},
          ${r.source}, ${r.source_vintage}, ${r.source_citation}
        )
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
  }
}

const t0 = performance.now();
const report = {
  event: args.apply ? "tx-rrc-staging.ingest-apply" : "tx-rrc-staging.ingest-dry-run",
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

let wells = [];
let pipelines = [];

if (loadWells) {
  const orphanApis = await loadOrphanApiSet(args.apply);
  report.orphanApisLoaded = orphanApis.size;
  const streamed = await streamWells(args.apply);
  wells = streamed.wells;
  report.wellsSkipped = streamed.skipped;
  for (const w of wells) {
    if (w.api && orphanApis.has(w.api)) w.is_orphan = true;
  }
  report.wellsLoaded = wells.length;
}

if (loadPipelines) {
  const streamed = await streamPipelines(args.apply);
  pipelines = streamed.pipelines;
  report.pipelinesSkipped = streamed.skipped;
  report.pipelinesLoaded = pipelines.length;
}

if (!args.apply) {
  report.elapsedMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  process.exit(0);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });
try {
  if (loadWells) {
    const reg = await sql`SELECT to_regclass('public.tx_rrc_well') AS reg`;
    if (reg[0]?.reg == null) {
      throw new Error("tx_rrc_well missing — run apply-tx-rrc-staging-migration first");
    }
    report.countyJoin = await assignWellCounties(sql, wells);
    await insertWells(sql, wells);
    const countRow = await sql`SELECT count(*)::int AS n FROM tx_rrc_well`;
    report.wellsInTable = countRow[0]?.n ?? 0;
  }

  if (loadPipelines) {
    const reg = await sql`SELECT to_regclass('public.tx_rrc_pipeline') AS reg`;
    if (reg[0]?.reg == null) {
      throw new Error("tx_rrc_pipeline missing — run apply-tx-rrc-staging-migration first");
    }
    await insertPipelines(sql, pipelines);
    const countRow = await sql`SELECT count(*)::int AS n FROM tx_rrc_pipeline`;
    report.pipelinesInTable = countRow[0]?.n ?? 0;
  }
} finally {
  await sql.end({ timeout: 10 });
}

report.elapsedMs = Math.round(performance.now() - t0);
console.log(JSON.stringify(report));
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
