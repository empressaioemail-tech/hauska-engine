#!/usr/bin/env node
/**
 * stage-tx-zoning-district.mjs — Factory 1.5 ArcGIS → tx_zoning_district_staging.
 *
 * Fetches public zoning polygons (outSR=4326), normalises per city registry,
 * REPLACE semantics per city_key. Does NOT write atoms / hauska_mcp.
 *
 *   ZONING_STAGING_PATH=1 \
 *   CORTEX_DATABASE_URL=... (direct, no -pooler) \
 *     pnpm --filter @hauska-engine/engine-core run stage-tx-zoning-district -- \
 *       --city=elgin-tx [--dry-run] [--apply]
 *
 * Default is dry-run. Pass --apply to write.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

import {
  listZoningStagingCityKeys,
  normalizeZoningFeature,
  resolveZoningStagingCity,
} from "../src/zoning-staging/index.ts";

const PAGE_SIZE = 500;

function parseArgs(argv) {
  const out = {
    city: null,
    apply: false,
    dryRun: true,
    out: null,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--city") out.city = String(argv[++i] || "").trim();
    else if (a.startsWith("--city=")) out.city = a.slice("--city=".length).trim();
    else if (a === "--apply") {
      out.apply = true;
      out.dryRun = false;
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--list") out.list = true;
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
  }
  return out;
}

function stripPooler(url) {
  return String(url).replace(/-pooler/g, "");
}

function hostFingerprint(url) {
  try {
    const u = new URL(url);
    return `${u.hostname} (direct, pooler=${u.hostname.includes("-pooler")})`;
  } catch {
    return "(unparseable)";
  }
}

if (process.env.ZONING_STAGING_PATH !== "1") {
  console.error("FATAL: ZONING_STAGING_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  console.log(
    JSON.stringify({
      event: "tx-zoning-district-staging.list",
      cities: listZoningStagingCityKeys(),
    }),
  );
  process.exit(0);
}

if (!args.city) {
  console.error("FATAL: --city=<cityKey> required (e.g. elgin-tx, smithville-tx).");
  process.exit(1);
}

const entry = resolveZoningStagingCity(args.city);
const fetchedAt = new Date().toISOString();
const sourceTierSatisfied = [...entry.sourceTier];

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: entry.layerWhere || "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: "json",
  });
  const res = await fetch(`${entry.layerUrl}/query?${params}`);
  if (!res.ok) throw new Error(`ArcGIS query HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.features ?? [];
}

async function* streamAllFeatures() {
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    for (const f of page) yield f;
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }
}

const t0 = performance.now();
const records = [];
let skipped = 0;
let codeDomainMapAppliedCount = 0;
const fieldUnion = new Set();
const sampleDistrictCodes = new Set();

for await (const feature of streamAllFeatures()) {
  const attrs = feature.attributes ?? {};
  for (const k of Object.keys(attrs)) fieldUnion.add(k);
  try {
    const rec = normalizeZoningFeature(feature, entry, {
      fetchedAt,
      sourceTierSatisfied,
      sourceVintage: `arcgis-live:${entry.cityKey}:${fetchedAt.slice(0, 10)}`,
    });
    if (!rec) {
      skipped += 1;
      continue;
    }
    records.push(rec);
    sampleDistrictCodes.add(rec.districtCode);
    if (rec.codeDomainMapApplied) codeDomainMapAppliedCount += 1;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "tx-zoning-district-staging.feature-error",
        cityKey: entry.cityKey,
        error: String(err?.message || err),
      }),
    );
    process.exit(2);
  }
}

const report = {
  event: args.apply
    ? "tx-zoning-district-staging.stage-apply"
    : "tx-zoning-district-staging.stage-dry-run",
  cityKey: entry.cityKey,
  cityGeoId: entry.cityGeoId,
  parentCountyFips: entry.parentCountyFips,
  layerRole: entry.layerRole,
  geometryGrain: entry.geometryGrain,
  sourceTierSatisfied,
  featuresFetched: records.length + skipped,
  featuresStaged: records.length,
  skipped,
  codeDomainMapAppliedCount,
  fieldUnion: [...fieldUnion].sort(),
  sampleDistrictCodes: [...sampleDistrictCodes].sort().slice(0, 40),
  elapsedMs: Math.round(performance.now() - t0),
};

if (!args.apply || args.dryRun) {
  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  process.exit(0);
}

const raw =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("FATAL: CORTEX_DATABASE_URL required for --apply.");
  process.exit(1);
}
const poolUrl = stripPooler(raw);
if (poolUrl.includes("-pooler")) {
  console.error("FATAL: connection still contains -pooler.");
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });
try {
  const reg = await sql`SELECT to_regclass('public.tx_zoning_district_staging') AS reg`;
  if (reg[0]?.reg == null) {
    throw new Error(
      "tx_zoning_district_staging missing — run apply-tx-zoning-district-staging-migration.mjs",
    );
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM tx_zoning_district_staging WHERE city_key = ${entry.cityKey}`;
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      for (const r of batch) {
        await tx`
          INSERT INTO tx_zoning_district_staging (
            staging_row_id, city_key, city_geo_id, city_name, parent_county_fips,
            district_code, district_name, geometry, geometry_crs,
            is_overlay, is_base_district, layer_role, geometry_grain,
            source_url, source_layer_id, fetched_at,
            source_tiers, source_tier_satisfied, source_vintage, source_citation,
            passthrough_attributes,
            west_lng, south_lat, east_lng, north_lat,
            code_field_raw, code_domain_map_applied, layer_where, object_id
          ) VALUES (
            ${r.stagingRowId}, ${r.cityKey}, ${r.cityGeoId}, ${r.cityName}, ${r.parentCountyFips},
            ${r.districtCode}, ${r.districtName}, ${tx.json(r.geometry)}, ${r.geometryCrs},
            ${r.isOverlay}, ${r.isBaseDistrict}, ${r.layerRole}, ${r.geometryGrain},
            ${r.sourceUrl}, ${r.sourceLayerId}, ${r.fetchedAt},
            ${tx.json(r.sourceTier)}, ${tx.json(r.sourceTierSatisfied)},
            ${r.sourceVintage}, ${r.sourceCitation},
            ${tx.json(r.passthroughAttributes)},
            ${r.westLng}, ${r.southLat}, ${r.eastLng}, ${r.northLat},
            ${r.codeFieldRaw}, ${r.codeDomainMapApplied}, ${r.layerWhere}, ${r.objectId}
          )
        `;
      }
    }
  });

  const verify = await sql`
    SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE source_tier_satisfied IS NULL)::int AS null_tier,
      count(DISTINCT district_code)::int AS distinct_codes,
      min(geometry_crs) AS geometry_crs,
      min(city_geo_id) AS city_geo_id
    FROM tx_zoning_district_staging
    WHERE city_key = ${entry.cityKey}
  `;
  const sample = await sql`
    SELECT district_code, jsonb_object_keys(passthrough_attributes) AS pk
    FROM tx_zoning_district_staging
    WHERE city_key = ${entry.cityKey}
    LIMIT 1
  `;
  const passthroughKeys = await sql`
    SELECT DISTINCT jsonb_object_keys(passthrough_attributes) AS k
    FROM tx_zoning_district_staging
    WHERE city_key = ${entry.cityKey}
    ORDER BY 1
  `;

  report.hostFingerprint = hostFingerprint(poolUrl);
  report.storeVerify = verify[0];
  report.passthroughKeysSample = passthroughKeys.map((r) => r.k);
  report.sampleRow = sample[0] ?? null;
  console.log(JSON.stringify(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
