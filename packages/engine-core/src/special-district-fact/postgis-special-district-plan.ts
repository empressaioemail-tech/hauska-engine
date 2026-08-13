/**
 * PostGIS true-geometry plan for `special-district-fact` (CP1 / SF-6).
 *
 * Metro path (Harris-shaped): once-detoast parcels into a TEMP table + GiST,
 * then district-major ST_Intersects (flood #315 shape). EXPLAIN on the old
 * keyset path showed Parallel Seq Scan + external sort of all ~1.6M county
 * parcels EVERY batch (cost 10^8+ nested loop) — a shape defect, not "Harris
 * is slow."
 *
 * Small-county path keeps keyset parcel batches with MATERIALIZED CTEs.
 *
 * Both `tx_special_district.geometry` and `txgio_parcel.geometry` are JSONB
 * only — no persistent geom/GiST on source tables.
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

/** Parcel rows per SQL round-trip on the small-county keyset path. */
export const DEFAULT_TRUE_GEOM_PARCEL_BATCH = 15_000;

/** Above this usable-parcel count, use TEMP+GiST district-major. */
export const METRO_TEMP_GIST_PARCEL_THRESHOLD = 50_000;

/** Districts per metro join batch (bounds work_mem / hash). */
export const DEFAULT_DISTRICT_BATCH = 40;

export interface PostgisSpecialDistrictPlanOptions {
  countyFips: string;
  /** Optional parcel row cap across all batches. */
  limit?: number;
  /** Parcel rows per keyset batch (small-county path). */
  parcelBatchSize?: number;
  /** Districts per TEMP+GiST join batch. */
  districtBatchSize?: number;
}

export interface PostgisSpecialDistrictPlanMeta {
  membershipMethodId: typeof TRUE_GEOM_MEMBERSHIP_METHOD;
  plannedAt: string;
  absenceReasoningRuleId:
    | typeof OUTSIDE_TRUE_GEOM_ABSENCE_RULE
    | typeof EMPTY_COUNTY_DISTRICT_ABSENCE_RULE;
  skippedNullGeometry: number;
  sqlMs: number;
  planShape?: "keyset-parcel-batch" | "temp-gist-district-major";
}

export interface PostgisSpecialDistrictPlanResult {
  plan: CountySpecialDistrictPlan;
  meta: PostgisSpecialDistrictPlanMeta;
}

interface HitRow {
  feature_index?: number;
  parcel_key: string;
  parcel_ctid?: string;
  district_id: string | null;
  district_name: string | null;
  district_type: string | null;
  county_fips: string | null;
}

function tempParcelTableName(countyFips: string): string {
  // Unquoted ident; county FIPS is digits-only.
  return `l1_sd_parcels_${countyFips}`;
}

/**
 * Small-county path. Params: $1 county, $2 last_fi, $3 last_key, $4 last_ctid, $5 limit.
 */
function trueGeomPlanBatchSql(): string {
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
           trim(prop_id) AS parcel_key,
           ctid AS parcel_ctid,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom,
           west_lng, south_lat, east_lng, north_lat
    FROM txgio_parcel
    WHERE county_fips = $1
      AND geometry IS NOT NULL
      AND prop_id IS NOT NULL
      AND trim(prop_id) <> ''
      AND trim(prop_id) !~ '^0+$'
      AND trim(prop_id) ~ '^[A-Za-z0-9.-]+$'
      AND (
        COALESCE(feature_index, -1) > $2::bigint
        OR (
          COALESCE(feature_index, -1) = $2::bigint
          AND trim(prop_id) > $3::text
        )
        OR (
          COALESCE(feature_index, -1) = $2::bigint
          AND trim(prop_id) = $3::text
          AND ctid > $4::tid
        )
      )
    ORDER BY COALESCE(feature_index, -1), trim(prop_id), ctid
    LIMIT $5
  ),
  hits AS (
    SELECT h.parcel_key, h.parcel_ctid, d.district_id, d.district_name, d.district_type, d.county_fips
    FROM districts d
    CROSS JOIN LATERAL (
      SELECT p.parcel_key, p.parcel_ctid
      FROM parcels p
      WHERE p.west_lng <= d.east_lng AND p.east_lng >= d.west_lng
        AND p.south_lat <= d.north_lat AND p.north_lat >= d.south_lat
        AND ST_Intersects(d.geom, p.geom)
    ) h
  )
  SELECT p.feature_index,
         p.parcel_key,
         p.parcel_ctid::text AS parcel_ctid,
         h.district_id,
         h.district_name,
         h.district_type,
         h.county_fips
  FROM parcels p
  LEFT JOIN hits h
    ON h.parcel_key = p.parcel_key AND h.parcel_ctid = p.parcel_ctid
  ORDER BY COALESCE(p.feature_index, -1), p.parcel_key, p.parcel_ctid, h.district_id
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

  type Acc = {
    parcelKey: string;
    present: PlannedSpecialDistrict[];
    sawPresent: boolean;
  };
  const byParcel = new Map<string, Acc>();
  let skippedUnusableKey = 0;

  for (const row of rows) {
    const key = String(row.parcel_key ?? "").trim();
    if (!key || key === "0" || /^0+$/.test(key) || !/^[A-Za-z0-9.-]+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    const mapKey = row.parcel_ctid ? `${key}@@${row.parcel_ctid}` : key;
    let acc = byParcel.get(mapKey);
    if (!acc) {
      acc = { parcelKey: key, present: [], sawPresent: false };
      byParcel.set(mapKey, acc);
    }
    if (row.district_id != null && String(row.district_id).length > 0) {
      acc.sawPresent = true;
      acc.present.push({
        outcome: "present",
        parcelKey: key,
        districtId: String(row.district_id),
        districtName:
          row.district_name != null ? String(row.district_name) : undefined,
        districtType:
          row.district_type != null ? String(row.district_type) : undefined,
      });
    }
  }

  const planned: PlannedSpecialDistrict[] = [];
  let presentMemberships = 0;
  let parcelsInDistrict = 0;
  let parcelsOutside = 0;
  let absentOutside = 0;
  for (const acc of byParcel.values()) {
    if (acc.sawPresent) {
      parcelsInDistrict += 1;
      for (const entry of acc.present) {
        planned.push(entry);
        presentMemberships += 1;
      }
    } else {
      parcelsOutside += 1;
      absentOutside += 1;
      planned.push({
        outcome: "absent",
        parcelKey: acc.parcelKey,
        absenceKind: "outside-tceq-source-boundaries",
        reason: absenceReason,
      });
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

async function planViaTempGist(
  sql: Sql,
  countyFips: string,
  opts: {
    limit?: number;
    districtBatchSize: number;
    districtsIndexed: number;
  },
): Promise<{ rows: HitRow[]; sqlMs: number }> {
  const temp = tempParcelTableName(countyFips);
  const t0 = Date.now();
  const hardLimit =
    opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : null;

  await sql.unsafe(`DROP TABLE IF EXISTS ${temp}`);
  await sql.unsafe(`
    CREATE TEMP TABLE ${temp} (
      parcel_key text NOT NULL,
      parcel_uid text NOT NULL,
      tile_key text NOT NULL,
      feature_index bigint NOT NULL,
      west_lng float8,
      south_lat float8,
      east_lng float8,
      north_lat float8,
      geom geometry
    ) ON COMMIT PRESERVE ROWS
  `);

  // Load via PK index (county_fips, tile_key, feature_index) — never seq-scan+sort.
  let lastTile = "";
  let lastFi = -1;
  let loaded = 0;
  const loadBatch = 25_000;
  for (;;) {
    if (hardLimit != null && loaded >= hardLimit) break;
    const take =
      hardLimit != null
        ? Math.min(loadBatch, hardLimit - loaded)
        : loadBatch;
    const inserted = await sql.unsafe<
      Array<{ tile_key: string; feature_index: number }>
    >(
      `
      WITH batch AS (
        SELECT trim(p.prop_id) AS parcel_key,
               (p.tile_key || ':' || p.feature_index::text) AS parcel_uid,
               p.tile_key,
               p.feature_index,
               p.west_lng, p.south_lat, p.east_lng, p.north_lat,
               ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p.geometry::text), 4326)) AS geom
        FROM txgio_parcel p
        WHERE p.county_fips = $1
          AND p.geometry IS NOT NULL
          AND p.prop_id IS NOT NULL
          AND trim(p.prop_id) <> ''
          AND trim(p.prop_id) !~ '^0+$'
          AND trim(p.prop_id) ~ '^[A-Za-z0-9.-]+$'
          AND (p.tile_key, p.feature_index) > ($2::text, $3::bigint)
        ORDER BY p.tile_key, p.feature_index
        LIMIT $4
      )
      INSERT INTO ${temp} (
        parcel_key, parcel_uid, tile_key, feature_index,
        west_lng, south_lat, east_lng, north_lat, geom
      )
      SELECT parcel_key, parcel_uid, tile_key, feature_index,
             west_lng, south_lat, east_lng, north_lat, geom
      FROM batch
      RETURNING tile_key, feature_index
      `,
      [countyFips, lastTile, lastFi, take],
    );
    const n = Array.isArray(inserted) ? inserted.length : 0;
    if (n === 0) break;
    loaded += n;
    const last = inserted[n - 1]!;
    lastTile = String(last.tile_key);
    lastFi = Number(last.feature_index);
    if (n < take) break;
  }

  await sql.unsafe(
    `CREATE INDEX ${temp}_gist ON ${temp} USING GIST (geom)`,
  );

  const districtIds = await sql<
    Array<{ district_id: string }>
  >`
    SELECT district_id
    FROM tx_special_district
    WHERE county_fips = ${countyFips}
      AND geometry IS NOT NULL
    ORDER BY district_id
  `;

  const rows: HitRow[] = [];
  const batchD = Math.max(1, opts.districtBatchSize);
  const seenPresent = new Set<string>();

  for (let i = 0; i < districtIds.length; i += batchD) {
    const slice = districtIds.slice(i, i + batchD).map((d) => d.district_id);
    const hits = await sql.unsafe<HitRow[]>(
      `
      WITH districts AS MATERIALIZED (
        SELECT district_id, district_name, district_type, county_fips,
               ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom,
               west_lng, south_lat, east_lng, north_lat
        FROM tx_special_district
        WHERE county_fips = $1
          AND geometry IS NOT NULL
          AND district_id = ANY($2::text[])
      )
      SELECT p.feature_index,
             p.parcel_key,
             p.parcel_uid AS parcel_ctid,
             d.district_id,
             d.district_name,
             d.district_type,
             d.county_fips
      FROM districts d
      CROSS JOIN LATERAL (
        SELECT p2.parcel_key, p2.parcel_uid, p2.feature_index
        FROM ${temp} p2
        WHERE p2.geom && d.geom
          AND p2.west_lng <= d.east_lng AND p2.east_lng >= d.west_lng
          AND p2.south_lat <= d.north_lat AND p2.north_lat >= d.south_lat
          AND ST_Intersects(d.geom, p2.geom)
      ) h
      JOIN ${temp} p ON p.parcel_uid = h.parcel_uid
      `,
      [countyFips, slice],
    );
    for (const r of hits) {
      rows.push(r);
      if (r.parcel_ctid) seenPresent.add(String(r.parcel_ctid));
    }
  }

  // Absences: parcels with no district hit (universe from TEMP, not a second full geom pass).
  const universe = await sql.unsafe<
    Array<{ feature_index: number; parcel_key: string; parcel_uid: string }>
  >(`SELECT feature_index, parcel_key, parcel_uid FROM ${temp}`);
  for (const p of universe) {
    if (seenPresent.has(String(p.parcel_uid))) continue;
    rows.push({
      feature_index: p.feature_index,
      parcel_key: p.parcel_key,
      parcel_ctid: p.parcel_uid,
      district_id: null,
      district_name: null,
      district_type: null,
      county_fips: null,
    });
  }

  await sql.unsafe(`DROP TABLE IF EXISTS ${temp}`);
  return { rows, sqlMs: Date.now() - t0 };
}

async function planViaKeyset(
  sql: Sql,
  countyFips: string,
  opts: { limit?: number; parcelBatchSize: number; districtsIndexed: number },
): Promise<{ rows: HitRow[]; sqlMs: number }> {
  const batchSize = opts.parcelBatchSize;
  const hardLimit =
    opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const queryText = trueGeomPlanBatchSql();
  const t0 = Date.now();
  const rows: HitRow[] = [];
  let parcelsFetched = 0;
  let cursorFeatureIndex = -1;
  let cursorParcelKey = "";
  let cursorCtid = "(0,0)";
  while (parcelsFetched < hardLimit) {
    const take = Math.min(batchSize, hardLimit - parcelsFetched);
    const batch = await sql.unsafe<HitRow[]>(queryText, [
      countyFips,
      cursorFeatureIndex,
      cursorParcelKey,
      cursorCtid,
      take,
    ]);
    if (batch.length === 0) break;
    for (const r of batch) rows.push(r);
    const parcelCtids = new Set<string>();
    let last: HitRow | undefined;
    for (const r of batch) {
      if (r.parcel_ctid) parcelCtids.add(String(r.parcel_ctid));
      last = r;
    }
    const parcelRows = parcelCtids.size;
    parcelsFetched += parcelRows;
    if (last?.parcel_ctid) {
      cursorFeatureIndex = Number(last.feature_index ?? -1);
      cursorParcelKey = String(last.parcel_key ?? "");
      cursorCtid = String(last.parcel_ctid);
    }
    if (parcelRows < take) break;
  }
  return { rows, sqlMs: Date.now() - t0 };
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

  const [usableRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND geometry IS NOT NULL
      AND prop_id IS NOT NULL
      AND trim(prop_id) <> ''
      AND trim(prop_id) !~ '^0+$'
      AND trim(prop_id) ~ '^[A-Za-z0-9.-]+$'
  `;
  const usable = usableRow?.n ?? 0;

  const batchSize = Math.max(
    1,
    Math.floor(opts.parcelBatchSize ?? DEFAULT_TRUE_GEOM_PARCEL_BATCH),
  );
  const districtBatchSize = Math.max(
    1,
    Math.floor(opts.districtBatchSize ?? DEFAULT_DISTRICT_BATCH),
  );

  const useTempGist =
    usable >= METRO_TEMP_GIST_PARCEL_THRESHOLD &&
    (opts.limit == null || opts.limit <= 0 || opts.limit >= METRO_TEMP_GIST_PARCEL_THRESHOLD);

  let rows: HitRow[];
  let sqlMs: number;
  let planShape: PostgisSpecialDistrictPlanMeta["planShape"];

  try {
    if (useTempGist) {
      planShape = "temp-gist-district-major";
      const out = await planViaTempGist(sql, countyFips, {
        limit: opts.limit,
        districtBatchSize,
        districtsIndexed,
      });
      rows = out.rows;
      sqlMs = out.sqlMs;
    } else {
      planShape = "keyset-parcel-batch";
      const out = await planViaKeyset(sql, countyFips, {
        limit: opts.limit,
        parcelBatchSize: batchSize,
        districtsIndexed,
      });
      rows = out.rows;
      sqlMs = out.sqlMs;
    }
  } catch (err) {
    throw new Error(
      `special-district-fact true-geom plan FAILED for county ${countyFips}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Bad-geometry policy: NULL geometry rows are skipped; ST_GeomFromGeoJSON ` +
        `throws abort the county plan (no silent empty membership).`,
    );
  }

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
      planShape,
    },
  };
}
