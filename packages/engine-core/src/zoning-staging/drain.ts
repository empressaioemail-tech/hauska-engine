/**
 * Drain interface for tx_zoning_district_staging.
 *
 * READ-ONLY shape for a future Factory 2 zoning writer. Does NOT mint
 * atoms, does NOT stamp parcels, does NOT live-fetch ArcGIS.
 *
 * Modeled on write-special-district-fact-county.mjs reading
 * tx_special_district — DB rows in, normalised payloads out.
 *
 * CP1-F2: refuses layer_role=overlay; refuses layer_role=unknown when
 * baseOnly=true (default).
 * CP1-F5: cityKey is the primary drain key; countyFips is a secondary filter.
 */

import {
  assertPayloadContract,
  ZoningStagingContractError,
  type GeometryGrain,
  type LayerRole,
  type ZoningStagingPayload,
} from "./payload-contract.js";

/** Row shape as stored in / selected from tx_zoning_district_staging. */
export type ZoningStagingDbRow = {
  staging_row_id: string;
  city_key: string;
  city_geo_id: string;
  city_name: string;
  parent_county_fips: string;
  district_code: string;
  district_name: string | null;
  geometry: unknown;
  geometry_crs: string;
  is_overlay: boolean;
  is_base_district: boolean;
  layer_role: string;
  geometry_grain: string;
  source_url: string;
  source_layer_id: string;
  fetched_at: string | Date;
  source_tiers: unknown;
  source_tier_satisfied: unknown;
  source_vintage: string;
  source_citation: string;
  passthrough_attributes: unknown;
  west_lng: number;
  south_lat: number;
  east_lng: number;
  north_lat: number;
  code_field_raw: string | null;
  code_domain_map_applied: boolean;
  layer_where: string;
  object_id: string;
};

export type DrainOptions = {
  /** Default true — refuse overlay and unknown roles. */
  baseOnly?: boolean;
  cityKey?: string | null;
  countyFips?: string | null;
  /**
   * Opt-in only. County-only drain mixes cities (Elgin C-3 ≠ Smithville C-3).
   * Without this flag, countyFips alone is refused so a writer cannot silently
   * treat colliding district codes as one ordinance token (CP2-F1).
   */
  allowMultiCity?: boolean;
};

export type DrainResult = {
  rows: ZoningStagingPayload[];
  refused: Array<{ stagingRowId: string; reason: string }>;
  /** Primary key identity for drain consumers (CP1-F5). */
  primaryKey: "cityKey";
};

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      /* fall through */
    }
    return v ? [v] : [];
  }
  return [];
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function dbRowToPayload(row: ZoningStagingDbRow): ZoningStagingPayload {
  const fetchedAt =
    row.fetched_at instanceof Date
      ? row.fetched_at.toISOString()
      : String(row.fetched_at);

  const payload: ZoningStagingPayload = {
    stagingRowId: row.staging_row_id,
    cityKey: row.city_key,
    cityGeoId: row.city_geo_id,
    cityName: row.city_name,
    parentCountyFips: row.parent_county_fips,
    districtCode: row.district_code,
    districtName: row.district_name,
    geometry: row.geometry as ZoningStagingPayload["geometry"],
    geometryCrs: row.geometry_crs,
    isOverlay: Boolean(row.is_overlay),
    isBaseDistrict: Boolean(row.is_base_district),
    layerRole: row.layer_role as LayerRole,
    geometryGrain: row.geometry_grain as GeometryGrain,
    sourceUrl: row.source_url,
    sourceLayerId: row.source_layer_id,
    fetchedAt,
    sourceTier: asStringArray(row.source_tiers),
    sourceTierSatisfied: asStringArray(row.source_tier_satisfied),
    sourceVintage: row.source_vintage,
    sourceCitation: row.source_citation,
    passthroughAttributes: asObject(row.passthrough_attributes),
    westLng: Number(row.west_lng),
    southLat: Number(row.south_lat),
    eastLng: Number(row.east_lng),
    northLat: Number(row.north_lat),
    codeFieldRaw: row.code_field_raw,
    codeDomainMapApplied: Boolean(row.code_domain_map_applied),
    layerWhere: row.layer_where,
    objectId: row.object_id,
  };
  assertPayloadContract(payload, `drain:${row.staging_row_id}`);
  return payload;
}

/**
 * Filter staged rows for a consumer that wants base districts only.
 * CityKey is primary; countyFips is optional secondary filter.
 */
export function drainZoningStagingRows(
  rows: ZoningStagingDbRow[],
  opts: DrainOptions = {},
): DrainResult {
  const baseOnly = opts.baseOnly !== false;
  const cityKey = opts.cityKey?.trim().toLowerCase() || null;
  const countyFips = opts.countyFips?.trim() || null;
  const allowMultiCity = opts.allowMultiCity === true;

  if (!cityKey && !countyFips) {
    throw new ZoningStagingContractError(
      "drain requires cityKey and/or countyFips",
    );
  }
  // CP2-F1: district codes collide across cities (live: C-3 in both Elgin and
  // Smithville). County-only drain without an explicit opt-in would let a
  // future writer mint wrong zoning answers from mixed ordinance tokens.
  if (!cityKey && countyFips && !allowMultiCity) {
    throw new ZoningStagingContractError(
      `drain by countyFips=${countyFips} without cityKey mixes cities; ` +
        `pass cityKey (preferred) or allowMultiCity=true (explicit multi-city)`,
    );
  }

  const out: ZoningStagingPayload[] = [];
  const refused: Array<{ stagingRowId: string; reason: string }> = [];

  for (const row of rows) {
    if (cityKey && row.city_key.toLowerCase() !== cityKey) continue;
    if (countyFips && row.parent_county_fips !== countyFips) continue;

    const role = String(row.layer_role ?? "unknown").toLowerCase();

    if (role === "overlay") {
      refused.push({
        stagingRowId: row.staging_row_id,
        reason: "layer_role=overlay refused by drain (CP1-F2)",
      });
      continue;
    }
    if (baseOnly && role === "unknown") {
      refused.push({
        stagingRowId: row.staging_row_id,
        reason: "layer_role=unknown refused when baseOnly=true (CP1-F2)",
      });
      continue;
    }
    if (baseOnly && role !== "base") {
      refused.push({
        stagingRowId: row.staging_row_id,
        reason: `layer_role=${role} refused when baseOnly=true`,
      });
      continue;
    }

    out.push(dbRowToPayload(row));
  }

  return { rows: out, refused, primaryKey: "cityKey" };
}
