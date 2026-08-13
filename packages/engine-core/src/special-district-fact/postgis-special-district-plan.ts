/**
 * PostGIS true-geometry plan for `special-district-fact` (CP1 / SF-6).
 *
 * District-major ST_Intersects against parcel polygons. Both
 * `tx_special_district.geometry` and `txgio_parcel.geometry` are JSONB only —
 * there is no geom column and no GiST. Geometry is parsed inside MATERIALIZED
 * CTEs via ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326).
 *
 * BOTH MATERIALIZED fences are load-bearing (flood #315 lesson): without them
 * the planner may inline the CTEs and re-parse / re-evaluate geometries
 * per lateral probe, quietly destroying throughput while still returning
 * correct rows.
 *
 * Bad-geometry policy: rows with NULL geometry are excluded
 * (`WHERE geometry IS NOT NULL`) and counted as skippedNullGeometry. Parsed
 * geometries are passed through ST_MakeValid before ST_Intersects — TCEQ and
 * parcel JSONB rings are not always GEOS-valid, and bare Intersects throws
 * TopologyException (side location conflict) on those counties. If
 * ST_GeomFromGeoJSON itself throws for a non-null but unparseable payload,
 * the plan FAILS LOUD for the county (no silent empty membership).
 */

import type { Sql } from "postgres";

import {
  buildEmptyCountyDistrictAbsenceReason,
  buildOutsideSourceAbsenceReason,
  EMPTY_COUNTY_DISTRICT_ABSENCE_RULE,
  OUTSIDE_TRUE_GEOM_ABSENCE_RULE,
} from "./honesty.js";
import { TRUE_GEOM_MEMBERSHIP_METHOD } from "./membership-method.js";
import type {
  CountySpecialDistrictPlan,
  PlannedSpecialDistrict,
} from "./plan-county-special-districts.js";

export interface PostgisSpecialDistrictPlanOptions {
  countyFips: string;
  /** Optional parcel row cap (feature_index order is not guaranteed here). */
  limit?: number;
}

export interface PostgisSpecialDistrictPlanMeta {
  membershipMethodId: typeof TRUE_GEOM_MEMBERSHIP_METHOD;
  plannedAt: string;
  absenceReasoningRuleId:
    | typeof OUTSIDE_TRUE_GEOM_ABSENCE_RULE
    | typeof EMPTY_COUNTY_DISTRICT_ABSENCE_RULE;
  skippedNullGeometry: number;
  sqlMs: number;
}

export interface PostgisSpecialDistrictPlanResult {
  plan: CountySpecialDistrictPlan;
  meta: PostgisSpecialDistrictPlanMeta;
}

interface HitRow {
  parcel_key: string;
  district_id: string | null;
  district_name: string | null;
  district_type: string | null;
  county_fips: string | null;
}

function trueGeomPlanSql(limit: number | undefined): string {
  const limitClause =
    limit != null && limit > 0 ? `\n       LIMIT ${Math.floor(limit)}` : "";
  return `
  WITH districts AS MATERIALIZED (
    SELECT district_id, district_name, district_type, county_fips,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom,
           west_lng, south_lat, east_lng, north_lat
    FROM tx_special_district
    WHERE county_fips = $1
      AND geometry IS NOT NULL
  ),
  parcels AS MATERIALIZED (
    SELECT feature_index,
           COALESCE(NULLIF(trim(prop_id), ''), '_feature-' || feature_index::text) AS parcel_key,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom,
           west_lng, south_lat, east_lng, north_lat
    FROM txgio_parcel
    WHERE county_fips = $1
      AND geometry IS NOT NULL${limitClause}
  ),
  hits AS (
    SELECT h.parcel_key, d.district_id, d.district_name, d.district_type, d.county_fips
    FROM districts d
    CROSS JOIN LATERAL (
      SELECT p.parcel_key
      FROM parcels p
      WHERE p.west_lng <= d.east_lng AND p.east_lng >= d.west_lng
        AND p.south_lat <= d.north_lat AND p.north_lat >= d.south_lat
        AND ST_Intersects(d.geom, p.geom)
    ) h
  )
  SELECT p.parcel_key,
         h.district_id,
         h.district_name,
         h.district_type,
         h.county_fips
  FROM parcels p
  LEFT JOIN hits h ON h.parcel_key = p.parcel_key
  ORDER BY p.parcel_key, h.district_id
`;
}

function assemblePlanFromRows(
  countyFips: string,
  districtsIndexed: number,
  rows: ReadonlyArray<HitRow>,
): CountySpecialDistrictPlan {
  const emptyDistrictIndex = districtsIndexed === 0;
  const absenceReason = emptyDistrictIndex
    ? buildEmptyCountyDistrictAbsenceReason(countyFips)
    : buildOutsideSourceAbsenceReason(countyFips);

  const planned: PlannedSpecialDistrict[] = [];
  let presentMemberships = 0;
  let parcelsInDistrict = 0;
  let parcelsOutside = 0;
  let absentOutside = 0;
  let skippedUnusableKey = 0;

  const byParcel = new Map<string, HitRow[]>();
  for (const row of rows) {
    const key = row.parcel_key?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    const bucket = byParcel.get(key);
    if (bucket) bucket.push(row);
    else byParcel.set(key, [row]);
  }

  for (const [parcelKey, parcelRows] of byParcel) {
    const hits = parcelRows.filter((r) => r.district_id != null);
    if (hits.length === 0) {
      planned.push({
        outcome: "absent",
        parcelKey,
        absenceKind: "outside-tceq-source-boundaries",
        reason: absenceReason,
      });
      parcelsOutside += 1;
      absentOutside += 1;
      continue;
    }

    parcelsInDistrict += 1;
    const seenDistrict = new Set<string>();
    for (const hit of hits) {
      const districtId = String(hit.district_id);
      if (seenDistrict.has(districtId)) continue;
      seenDistrict.add(districtId);
      planned.push({
        outcome: "present",
        parcelKey,
        districtId,
        districtName: String(hit.district_name ?? ""),
        districtType: String(hit.district_type ?? ""),
        countyFips: String(hit.county_fips ?? countyFips),
      });
      presentMemberships += 1;
    }
  }

  return {
    countyFips,
    districtsIndexed,
    parcelsRead: byParcel.size,
    emptyDistrictIndex,
    planned,
    counts: {
      presentMemberships,
      absentOutside,
      parcelsInDistrict,
      parcelsOutside,
      skippedUnusableKey,
      rateEnrichedCount: 0,
    },
  };
}

export async function planCountySpecialDistrictsPostgis(
  sql: Sql,
  opts: PostgisSpecialDistrictPlanOptions,
): Promise<PostgisSpecialDistrictPlanResult> {
  const countyFips = opts.countyFips;
  if (!/^\d{5}$/.test(countyFips)) {
    throw new Error(`invalid countyFips: ${countyFips}`);
  }

  const plannedAt = new Date().toISOString();

  const [districtCountRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM tx_special_district
    WHERE county_fips = ${countyFips}
  `;
  const districtsIndexed = districtCountRow?.n ?? 0;

  const [nullGeomRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND geometry IS NULL
  `;
  const skippedNullGeometry = nullGeomRow?.n ?? 0;

  const queryText = trueGeomPlanSql(opts.limit);
  const t0 = Date.now();
  let rows: HitRow[];
  try {
    rows = await sql.unsafe<HitRow[]>(queryText, [countyFips]);
  } catch (err) {
    // Fail loud: unparseable GeoJSON must not become silent empty membership.
    throw new Error(
      `special-district-fact true-geom plan FAILED for county ${countyFips}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Bad-geometry policy: NULL geometry rows are skipped; ST_GeomFromGeoJSON ` +
        `throws abort the county plan (no silent empty membership).`,
    );
  }
  const sqlMs = Date.now() - t0;

  const plan = assemblePlanFromRows(countyFips, districtsIndexed, rows);
  const absenceReasoningRuleId = plan.emptyDistrictIndex
    ? EMPTY_COUNTY_DISTRICT_ABSENCE_RULE
    : OUTSIDE_TRUE_GEOM_ABSENCE_RULE;

  return {
    plan,
    meta: {
      membershipMethodId: TRUE_GEOM_MEMBERSHIP_METHOD,
      plannedAt,
      absenceReasoningRuleId,
      skippedNullGeometry,
      sqlMs,
    },
  };
}
