/**
 * Stage LAYER-FOUND discovery into tx_zoning_district_staging via H1 normalize seam.
 * Builds ZoningCityRegistryEntry in memory — does not edit registry.ts.
 */

import postgres from "postgres";

import { normalizeZoningFeature, type ArcGisFeature } from "../zoning-staging/normalize.js";
import type { ZoningStagingPayload } from "../zoning-staging/payload-contract.js";
import type { ZoningCityRegistryEntry } from "../zoning-staging/registry.js";
import { fetchJsonResilient } from "./fetch-json.js";
import type { ClassifiedVerdict, LayerProbeMeta, QueueItem } from "./types.js";

const PAGE_SIZE = 500;
const INSERT_BATCH = 100;
/** Hard ceiling so mega inventories (Austin) cannot stall the production fan. */
const STAGE_FEATURE_CAP = 20_000;

export type StageDiscoveredOptions = {
  apply?: boolean;
  dryRun?: boolean;
  fetchedAt?: string;
  probeEvidencePath?: string;
};

export type StageDiscoveredReport = {
  event: string;
  cityKey: string;
  cityGeoId: string;
  layerUrl: string;
  featuresFetched: number;
  featuresStaged: number;
  skipped: number;
  elapsedMs: number;
  applied: boolean;
};

function stripPooler(url: string): string {
  return String(url).replace(/-pooler/g, "");
}

export function buildRegistryEntryFromDiscovery(
  item: QueueItem,
  layer: LayerProbeMeta,
  opts: { probeEvidencePath?: string } = {},
): ZoningCityRegistryEntry {
  if (!item.cityGeoId || !/^\d{7}$/.test(item.cityGeoId)) {
    throw new Error(
      `cityKey=${item.cityKey} missing valid cityGeoId — required for LAYER-FOUND staging`,
    );
  }
  if (!layer.codeField) {
    throw new Error(`cityKey=${item.cityKey} layer missing codeField`);
  }
  if (!layer.objectIdField) {
    throw new Error(`cityKey=${item.cityKey} layer missing service-declared objectIdField`);
  }

  const isFeatureServer = /FeatureServer/i.test(layer.layerUrl);
  const sourceTier = isFeatureServer
    ? ["municipal-arcgis-featureserver"]
    : ["municipal-arcgis-mapserver"];

  return {
    cityKey: item.cityKey,
    cityName: item.cityName,
    cityGeoId: item.cityGeoId,
    parentCountyFips: item.parentCountyFips,
    layerUrl: layer.layerUrl,
    layerId: String(layer.layerId),
    objectIdField: layer.objectIdField,
    codeField: layer.codeField,
    descriptionField: layer.descriptionField,
    codeDomainMap: null,
    codeExtractRegex: null,
    nullDistrictCodes: [],
    layerWhere: "1=1",
    sourceTier,
    authPosture: "public-record",
    geometryTypeExpected: "esriGeometryPolygon",
    nativeCrsWkid: 4326,
    layerRole: "base",
    geometryGrain: "district-polygon",
    probeEvidencePath: opts.probeEvidencePath ?? "zoning-discovery",
    verifiedAt: new Date().toISOString(),
    confidence: "medium",
    rosterCitation: `zoning-discovery:${item.cityKey}`,
  };
}

async function fetchPage(layerUrl: string, offset: number): Promise<ArcGisFeature[]> {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: "json",
  });
  const res = await fetchJsonResilient(`${layerUrl}/query?${params}`);
  if (res.transportError) throw new Error(`ArcGIS query transport: ${res.transportError}`);
  if (res.status >= 400) throw new Error(`ArcGIS query HTTP ${res.status}`);
  const body = res.body as { features?: ArcGisFeature[]; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.features ?? [];
}

async function* streamAllFeatures(layerUrl: string): AsyncGenerator<ArcGisFeature> {
  let offset = 0;
  while (true) {
    const page = await fetchPage(layerUrl, offset);
    if (page.length === 0) break;
    for (const f of page) yield f;
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }
}

export async function stageDiscoveredLayer(
  item: QueueItem,
  verdict: ClassifiedVerdict,
  options: StageDiscoveredOptions = {},
): Promise<StageDiscoveredReport> {
  if (verdict.status !== "LAYER-FOUND" || !verdict.layer) {
    throw new Error(`stageDiscoveredLayer requires LAYER-FOUND verdict for ${item.cityKey}`);
  }

  const t0 = performance.now();
  const entry = buildRegistryEntryFromDiscovery(item, verdict.layer, {
    probeEvidencePath: options.probeEvidencePath,
  });
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const sourceTierSatisfied = [...entry.sourceTier];

  const shouldApply = options.apply === true && options.dryRun !== true;
  if (shouldApply) {
    const rawEarly =
      process.env.CORTEX_DATABASE_URL?.trim() ||
      process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
      process.env.DATABASE_URL?.trim();
    if (rawEarly) {
      const earlySql = postgres(stripPooler(rawEarly), {
        max: 1,
        ssl: "require",
        prepare: false,
      });
      try {
        const existing = await earlySql`
          SELECT count(*)::int AS n FROM tx_zoning_district_staging WHERE city_key = ${entry.cityKey}
        `;
        const existingN = Number(existing[0]?.n ?? 0);
        const layerCount = verdict.layer.featureCount ?? 0;
        if (existingN >= 1000 && layerCount >= 5000) {
          return {
            event: "zoning-discovery.stage-apply-preserved",
            cityKey: entry.cityKey,
            cityGeoId: entry.cityGeoId,
            layerUrl: entry.layerUrl,
            featuresFetched: existingN,
            featuresStaged: existingN,
            skipped: 0,
            elapsedMs: Math.round(performance.now() - t0),
            applied: true,
          };
        }
      } finally {
        await earlySql.end({ timeout: 5 });
      }
    }
  }

  const records: ZoningStagingPayload[] = [];
  let skipped = 0;
  let capped = false;

  for await (const feature of streamAllFeatures(entry.layerUrl)) {
    if (records.length >= STAGE_FEATURE_CAP) {
      capped = true;
      break;
    }
    let rec: ZoningStagingPayload | null = null;
    try {
      rec = normalizeZoningFeature(feature, entry, {
        fetchedAt,
        sourceTierSatisfied,
        sourceVintage: `arcgis-live:${entry.cityKey}:${fetchedAt.slice(0, 10)}`,
      });
    } catch {
      // Live municipal layers occasionally emit OID rows without drawable
      // geometry. Skip the row; do not fail the whole city stage.
      skipped += 1;
      continue;
    }
    if (!rec) {
      skipped += 1;
      continue;
    }
    records.push(rec);
  }

  const report: StageDiscoveredReport = {
    event: options.apply ? "zoning-discovery.stage-apply" : "zoning-discovery.stage-dry-run",
    cityKey: entry.cityKey,
    cityGeoId: entry.cityGeoId,
    layerUrl: entry.layerUrl,
    featuresFetched: records.length + skipped,
    featuresStaged: records.length,
    skipped,
    elapsedMs: Math.round(performance.now() - t0),
    applied: false,
  };
  if (capped) {
    (report as StageDiscoveredReport & { cappedAt?: number }).cappedAt = STAGE_FEATURE_CAP;
  }

  if (!shouldApply) return report;

  const raw =
    process.env.CORTEX_DATABASE_URL?.trim() ||
    process.env.DEPLOYMENT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!raw) {
    throw new Error("CORTEX_DATABASE_URL required for stage apply");
  }
  const poolUrl = stripPooler(raw);
  if (poolUrl.includes("-pooler")) {
    throw new Error("connection still contains -pooler");
  }

  const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });
  try {
    const reg = await sql`SELECT to_regclass('public.tx_zoning_district_staging') AS reg`;
    if (reg[0]?.reg == null) {
      throw new Error("tx_zoning_district_staging missing — run migration first");
    }

    // Mega inventories (Austin-class) already staged from prior H1/Z1 work should
    // not be re-fetched feature-by-feature during the production fan.
    const existing = await sql`
      SELECT count(*)::int AS n FROM tx_zoning_district_staging WHERE city_key = ${entry.cityKey}
    `;
    const existingN = Number(existing[0]?.n ?? 0);
    const layerCount = verdict.layer.featureCount ?? records.length;
    if (existingN >= 1000 && layerCount >= 5000) {
      report.applied = true;
      report.event = "zoning-discovery.stage-apply-preserved";
      report.featuresStaged = existingN;
      report.featuresFetched = existingN;
      report.elapsedMs = Math.round(performance.now() - t0);
      (report as StageDiscoveredReport & { preservedExisting?: boolean }).preservedExisting =
        true;
      return report;
    }

    await sql.begin(async (tx) => {
      await tx`DELETE FROM tx_zoning_district_staging WHERE city_key = ${entry.cityKey}`;
      for (let i = 0; i < records.length; i += INSERT_BATCH) {
        const chunk = records.slice(i, i + INSERT_BATCH);
        await Promise.all(
          chunk.map(
            (r) => tx`
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
            ${r.districtCode}, ${r.districtName}, ${tx.json(JSON.parse(JSON.stringify(r.geometry)))}, ${r.geometryCrs},
            ${r.isOverlay}, ${r.isBaseDistrict}, ${r.layerRole}, ${r.geometryGrain},
            ${r.sourceUrl}, ${r.sourceLayerId}, ${r.fetchedAt},
            ${tx.json(r.sourceTier)}, ${tx.json(r.sourceTierSatisfied)},
            ${r.sourceVintage}, ${r.sourceCitation},
            ${tx.json(JSON.parse(JSON.stringify(r.passthroughAttributes)))},
            ${r.westLng}, ${r.southLat}, ${r.eastLng}, ${r.northLat},
            ${r.codeFieldRaw}, ${r.codeDomainMapApplied}, ${r.layerWhere}, ${r.objectId}
          )
        `,
          ),
        );
      }
    });
    report.applied = true;
    report.event = "zoning-discovery.stage-apply";
    report.elapsedMs = Math.round(performance.now() - t0);
  } finally {
    await sql.end({ timeout: 5 });
  }

  return report;
}
