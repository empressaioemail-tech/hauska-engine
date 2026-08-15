/**
 * PostGIS server-side plan for `rrc-pipeline-fact` (L26 / WDLL item 4).
 *
 * Metro path (Brazoria-shaped): once-detoast parcels into a TEMP table + GiST,
 * then pipeline-major ST_DWithin on geography at RRC_PIPELINE_DEFAULT_BUFFER_METERS.
 * Small-county path keeps keyset parcel batches with MATERIALIZED CTEs.
 *
 * Both `tx_rrc_pipeline.geometry` and `txgio_parcel.geometry` are JSONB only —
 * no persistent geom/GiST on source tables. Plan rows carry parcelKey + outcome +
 * scalars only; no geometry on the wire.
 */

import type { Sql } from "postgres";

import { RRC_PIPELINE_DEFAULT_BUFFER_METERS } from "@empressaio/atom-contract/property";

import {
  countDedupedPipelines,
  pipelineDedupeKey,
  type CountyRrcPipelinePlan,
  type PlannedRrcPipeline,
} from "./plan-county-rrc-pipeline.js";

/** Parcel rows per SQL round-trip on the small-county keyset path. */
export const DEFAULT_RRC_PIPELINE_PARCEL_BATCH = 15_000;

/** Above this usable-parcel count, use TEMP+GiST pipeline-major. */
export const METRO_TEMP_GIST_PARCEL_THRESHOLD = 50_000;

/** Pipelines per metro join batch (bounds work_mem / hash). */
export const DEFAULT_PIPELINE_BATCH = 200;

/** Session statement_timeout for plan connections (ms). Not zero. */
export const PLAN_STATEMENT_TIMEOUT_MS = Number.parseInt(
  process.env.RRC_PIPELINE_PLAN_STATEMENT_TIMEOUT_MS ?? "600000",
  10,
);

/** Session lock_timeout for plan connections (ms). */
export const PLAN_LOCK_TIMEOUT_MS = Number.parseInt(
  process.env.RRC_PIPELINE_PLAN_LOCK_TIMEOUT_MS ?? "30000",
  10,
);

export interface PostgisRrcPipelinePlanOptions {
  countyFips: string;
  bufferMeters?: number;
  /** Optional parcel row cap across all batches. */
  limit?: number;
  parcelBatchSize?: number;
  pipelineBatchSize?: number;
  sourceReadFailed?: boolean;
}

export interface PostgisRrcPipelinePlanMeta {
  membershipMethodId: "postgis-geography-st-dwithin-buffer";
  plannedAt: string;
  bufferMeters: number;
  skippedNullGeometry: number;
  sqlMs: number;
  planShape?: "keyset-parcel-batch" | "temp-gist-pipeline-major";
  pipelinesIndexed: number;
  pipelinesDeduped: number;
  sourceReadFailed: boolean;
}

export interface PostgisRrcPipelinePlanResult {
  plan: CountyRrcPipelinePlan;
  meta: PostgisRrcPipelinePlanMeta;
}

export interface RrcPipelinePostgisReadiness {
  postgisPresent: boolean;
  pipelineTablePresent: boolean;
  parcelTablePresent: boolean;
  ready: boolean;
  reason?: string;
}

interface HitRow {
  feature_index?: number;
  parcel_key: string;
  parcel_uid?: string;
  dist_m?: number | null;
  t4permit?: string | null;
  p5_num?: string | null;
  operator?: string | null;
  system_name?: string | null;
  commodity?: string | null;
  commodity_description?: string | null;
  system_type?: string | null;
  status?: string | null;
  diameter?: number | null;
  interstate?: boolean | string | null;
  has_geometry?: boolean;
}

function tempParcelTableName(countyFips: string): string {
  return `l1_rrc_parcels_${countyFips}`;
}

/** Exported for unit tests — must use geography ST_DWithin, not geometry degrees. */
export function rrcPipelineNearPredicateSql(
  parcelGeomExpr: string,
  pipelineGeomExpr: string,
  bufferParam = "$buffer",
): string {
  return `ST_DWithin(${parcelGeomExpr}::geography, ${pipelineGeomExpr}::geography, ${bufferParam}::double precision)`;
}

function pipelinesCteSql(): string {
  return `
  pipelines AS MATERIALIZED (
    SELECT pipeline_row_id,
           p5_num,
           t4permit,
           operator,
           system_name,
           commodity,
           commodity_description,
           system_type,
           status,
           diameter,
           interstate,
           west_lng,
           south_lat,
           east_lng,
           north_lat,
           COALESCE(t4permit, '') || '|' || COALESCE(p5_num, '') AS dedupe_key,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom
    FROM tx_rrc_pipeline
    WHERE county_fips = $1
      AND geometry IS NOT NULL
  )`;
}

/**
 * Small-county path. Params: $1 county, $2 last_fi, $3 limit, $4 buffer meters.
 */
export function keysetParcelBatchPlanSql(): string {
  const near = rrcPipelineNearPredicateSql("p.geom", "pl.geom", "$4");
  return `
  WITH ${pipelinesCteSql()},
  parcels AS MATERIALIZED (
    SELECT DISTINCT ON (feature_index)
           feature_index,
           trim(prop_id) AS parcel_key,
           (tile_key || ':' || feature_index::text) AS parcel_uid,
           geometry IS NOT NULL AS has_geometry,
           CASE
             WHEN geometry IS NOT NULL THEN
               ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326))
             ELSE NULL
           END AS geom,
           west_lng,
           south_lat,
           east_lng,
           north_lat
    FROM txgio_parcel
    WHERE county_fips = $1
      AND feature_index > $2::bigint
    ORDER BY feature_index
    LIMIT $3
  ),
  candidates AS (
    SELECT p.parcel_key,
           p.parcel_uid,
           p.feature_index,
           p.has_geometry,
           pl.t4permit,
           pl.p5_num,
           pl.operator,
           pl.system_name,
           pl.commodity,
           pl.commodity_description,
           pl.system_type,
           pl.status,
           pl.diameter,
           pl.interstate,
           pl.dedupe_key,
           ST_Distance(p.geom::geography, pl.geom::geography) AS dist_m
    FROM parcels p
    JOIN pipelines pl
      ON p.has_geometry
     AND p.geom IS NOT NULL
     AND pl.west_lng <= p.east_lng
     AND pl.east_lng >= p.west_lng
     AND pl.south_lat <= p.north_lat
     AND pl.north_lat >= p.south_lat
     AND ${near}
  ),
  deduped AS (
    SELECT DISTINCT ON (parcel_uid, dedupe_key)
           parcel_key,
           parcel_uid,
           feature_index,
           has_geometry,
           t4permit,
           p5_num,
           operator,
           system_name,
           commodity,
           commodity_description,
           system_type,
           status,
           diameter,
           interstate,
           dist_m
    FROM candidates
    ORDER BY parcel_uid, dedupe_key, dist_m
  ),
  nearest AS (
    SELECT DISTINCT ON (parcel_uid)
           parcel_key,
           parcel_uid,
           feature_index,
           has_geometry,
           t4permit,
           p5_num,
           operator,
           system_name,
           commodity,
           commodity_description,
           system_type,
           status,
           diameter,
           interstate,
           dist_m
    FROM deduped
    ORDER BY parcel_uid, dist_m
  )
  SELECT p.feature_index,
         p.parcel_key,
         p.parcel_uid,
         p.has_geometry,
         n.dist_m,
         n.t4permit,
         n.p5_num,
         n.operator,
         n.system_name,
         n.commodity,
         n.commodity_description,
         n.system_type,
         n.status,
         n.diameter,
         n.interstate
  FROM parcels p
  LEFT JOIN nearest n ON n.parcel_uid = p.parcel_uid
  ORDER BY p.feature_index
`;
}

function roundDist(m: number): number {
  return Math.round(m * 10) / 10;
}

function assemblePlanFromRows(
  countyFips: string,
  opts: {
    bufferMeters: number;
    pipelinesIndexed: number;
    pipelinesDeduped: number;
    sourceReadFailed: boolean;
    rows: ReadonlyArray<HitRow>;
  },
): CountyRrcPipelinePlan {
  const planned: PlannedRrcPipeline[] = [];
  let skippedUnusableKey = 0;
  let presentNear = 0;
  let presentOutside = 0;
  const seen = new Set<string>();

  for (const row of opts.rows) {
    const key = String(row.parcel_key ?? "").trim();
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    if (row.has_geometry === false) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-parcel-geometry",
        reason: `no usable parcel ring geometry for ${countyFips}:${key}`,
        bufferMeters: opts.bufferMeters,
      });
      continue;
    }

    if (opts.sourceReadFailed) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-pipeline-coverage",
        reason: `tx_rrc_pipeline source read failed for county ${countyFips} — cannot evaluate pipeline proximity`,
        bufferMeters: opts.bufferMeters,
      });
      continue;
    }

    if (opts.pipelinesIndexed === 0) {
      planned.push({
        outcome: "present",
        parcelKey: key,
        nearPipeline: false,
        bufferMeters: opts.bufferMeters,
      });
      presentOutside += 1;
      continue;
    }

    const dist = row.dist_m;
    if (
      dist == null ||
      !Number.isFinite(Number(dist)) ||
      Number(dist) > opts.bufferMeters
    ) {
      planned.push({
        outcome: "present",
        parcelKey: key,
        nearPipeline: false,
        bufferMeters: opts.bufferMeters,
      });
      presentOutside += 1;
      continue;
    }

    const nearMeters = roundDist(Number(dist));
    planned.push({
      outcome: "present",
      parcelKey: key,
      nearPipeline: true,
      bufferMeters: opts.bufferMeters,
      nearestPipelineDistanceMeters: nearMeters,
      ...(row.t4permit ? { t4permit: String(row.t4permit) } : {}),
      ...(row.p5_num ? { p5Num: String(row.p5_num) } : {}),
      ...(row.operator ? { operatorName: String(row.operator) } : {}),
      ...(row.system_name ? { systemName: String(row.system_name) } : {}),
      ...(row.commodity ? { commodity: String(row.commodity) } : {}),
      ...(row.commodity_description
        ? { commodityDescription: String(row.commodity_description) }
        : {}),
      ...(row.system_type ? { systemType: String(row.system_type) } : {}),
      ...(row.status ? { status: String(row.status) } : {}),
      ...(row.diameter != null && Number.isFinite(Number(row.diameter))
        ? { diameter: Number(row.diameter) }
        : {}),
      ...(row.interstate !== null && row.interstate !== undefined
        ? {
            interstate:
              typeof row.interstate === "boolean"
                ? row.interstate
                : String(row.interstate),
          }
        : {}),
    });
    presentNear += 1;
  }

  return {
    countyFips,
    bufferMeters: opts.bufferMeters,
    pipelinesIndexed: opts.pipelinesIndexed,
    pipelinesDeduped: opts.pipelinesDeduped,
    sourceReadFailed: opts.sourceReadFailed,
    parcelsRead: opts.rows.length,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentNear,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
    },
  };
}

async function planViaTempGist(
  sql: Sql,
  countyFips: string,
  opts: {
    limit?: number;
    pipelineBatchSize: number;
    bufferMeters: number;
    pipelinesIndexed: number;
    pipelinesDeduped: number;
    sourceReadFailed: boolean;
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
      feature_index bigint NOT NULL,
      has_geometry boolean NOT NULL,
      west_lng float8,
      south_lat float8,
      east_lng float8,
      north_lat float8,
      geom geometry
    ) ON COMMIT PRESERVE ROWS
  `);

  let lastTile = "";
  let lastFi = -1;
  let loaded = 0;
  const loadBatch = 25_000;
  for (;;) {
    if (hardLimit != null && loaded >= hardLimit) break;
    const take =
      hardLimit != null ? Math.min(loadBatch, hardLimit - loaded) : loadBatch;
    const inserted = await sql.unsafe<
      Array<{ tile_key: string; feature_index: number }>
    >(
      `
      WITH batch AS (
        SELECT trim(p.prop_id) AS parcel_key,
               (p.tile_key || ':' || p.feature_index::text) AS parcel_uid,
               p.tile_key,
               p.feature_index,
               p.geometry IS NOT NULL AS has_geometry,
               p.west_lng,
               p.south_lat,
               p.east_lng,
               p.north_lat,
               CASE
                 WHEN p.geometry IS NOT NULL THEN
                   ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p.geometry::text), 4326))
                 ELSE NULL
               END AS geom
        FROM txgio_parcel p
        WHERE p.county_fips = $1
          AND (p.tile_key, p.feature_index) > ($2::text, $3::bigint)
        ORDER BY p.tile_key, p.feature_index
        LIMIT $4
      )
      INSERT INTO ${temp} (
        parcel_key, parcel_uid, feature_index, has_geometry,
        west_lng, south_lat, east_lng, north_lat, geom
      )
      SELECT parcel_key, parcel_uid, feature_index, has_geometry,
             west_lng, south_lat, east_lng, north_lat, geom
      FROM batch
      RETURNING split_part(parcel_uid, ':', 1) AS tile_key, feature_index
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

  await sql.unsafe(`CREATE INDEX ${temp}_gist ON ${temp} USING GIST (geom)`);

  const pipelineIds = await sql<Array<{ pipeline_row_id: string }>>`
    SELECT pipeline_row_id
    FROM tx_rrc_pipeline
    WHERE county_fips = ${countyFips}
      AND geometry IS NOT NULL
    ORDER BY pipeline_row_id
  `;

  const hitsByUid = new Map<string, HitRow[]>();
  const batchP = Math.max(1, opts.pipelineBatchSize);
  const nearInner = rrcPipelineNearPredicateSql("p2.geom", "pl.geom", "$3");

  for (let i = 0; i < pipelineIds.length; i += batchP) {
    const slice = pipelineIds.slice(i, i + batchP).map((d) => d.pipeline_row_id);
    const hits = await sql.unsafe<HitRow[]>(
      `
      WITH pipelines AS MATERIALIZED (
        SELECT pipeline_row_id, p5_num, t4permit, operator, system_name,
               commodity, commodity_description, system_type, status, diameter,
               interstate,
               COALESCE(t4permit, '') || '|' || COALESCE(p5_num, '') AS dedupe_key,
               ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom,
               west_lng, south_lat, east_lng, north_lat
        FROM tx_rrc_pipeline
        WHERE county_fips = $1
          AND geometry IS NOT NULL
          AND pipeline_row_id = ANY($2::text[])
      )
      SELECT p.parcel_uid,
             p.parcel_key,
             p.feature_index,
             pl.t4permit,
             pl.p5_num,
             pl.operator,
             pl.system_name,
             pl.commodity,
             pl.commodity_description,
             pl.system_type,
             pl.status,
             pl.diameter,
             pl.interstate,
             ST_Distance(p.geom::geography, pl.geom::geography) AS dist_m,
             pl.dedupe_key
      FROM pipelines pl
      CROSS JOIN LATERAL (
        SELECT p2.parcel_uid, p2.parcel_key, p2.feature_index, p2.geom
        FROM ${temp} p2
        WHERE p2.has_geometry
          AND p2.geom IS NOT NULL
          AND p2.geom && pl.geom
          AND p2.west_lng <= pl.east_lng
          AND p2.east_lng >= pl.west_lng
          AND p2.south_lat <= pl.north_lat
          AND p2.north_lat >= pl.south_lat
          AND ${nearInner}
      ) p
      `,
      [countyFips, slice, opts.bufferMeters],
    );

    for (const h of hits) {
      const uid = String(h.parcel_uid ?? "");
      if (!uid) continue;
      const list = hitsByUid.get(uid) ?? [];
      list.push(h);
      hitsByUid.set(uid, list);
    }
  }

  function pickNearestHit(hitList: HitRow[]): HitRow | undefined {
    const byKey = new Map<string, HitRow>();
    for (const h of hitList) {
      const key = pipelineDedupeKey({
        t4permit: h.t4permit != null ? String(h.t4permit) : null,
        p5Num: h.p5_num != null ? String(h.p5_num) : null,
      });
      const dist = Number(h.dist_m);
      const prev = byKey.get(key);
      if (!prev || dist < Number(prev.dist_m)) byKey.set(key, h);
    }
    let nearest: HitRow | undefined;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (const entry of byKey.values()) {
      const dist = Number(entry.dist_m);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = entry;
      }
    }
    return nearest;
  }

  const universe = await sql.unsafe<
    Array<{
      feature_index: number;
      parcel_key: string;
      parcel_uid: string;
      has_geometry: boolean;
    }>
  >(
    `SELECT DISTINCT ON (feature_index)
            feature_index, parcel_key, parcel_uid, has_geometry
     FROM ${temp}
     ORDER BY feature_index, parcel_uid`,
  );

  const rows: HitRow[] = [];
  for (const p of universe) {
    const hit = pickNearestHit(hitsByUid.get(String(p.parcel_uid)) ?? []);
    rows.push({
      feature_index: p.feature_index,
      parcel_key: p.parcel_key,
      parcel_uid: p.parcel_uid,
      has_geometry: p.has_geometry,
      ...(hit
        ? {
            dist_m: hit.dist_m,
            t4permit: hit.t4permit,
            p5_num: hit.p5_num,
            operator: hit.operator,
            system_name: hit.system_name,
            commodity: hit.commodity,
            commodity_description: hit.commodity_description,
            system_type: hit.system_type,
            status: hit.status,
            diameter: hit.diameter,
            interstate: hit.interstate,
          }
        : {}),
    });
  }

  await sql.unsafe(`DROP TABLE IF EXISTS ${temp}`);
  return { rows, sqlMs: Date.now() - t0 };
}

async function planViaKeyset(
  sql: Sql,
  countyFips: string,
  opts: {
    limit?: number;
    parcelBatchSize: number;
    bufferMeters: number;
    pipelinesIndexed: number;
    pipelinesDeduped: number;
    sourceReadFailed: boolean;
  },
): Promise<{ rows: HitRow[]; sqlMs: number }> {
  const batchSize = opts.parcelBatchSize;
  const hardLimit =
    opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const queryText = keysetParcelBatchPlanSql();
  const t0 = Date.now();
  const rows: HitRow[] = [];
  let parcelsFetched = 0;
  let cursorFeatureIndex = -1;
  while (parcelsFetched < hardLimit) {
    const take = Math.min(batchSize, hardLimit - parcelsFetched);
    const batch = await sql.unsafe<HitRow[]>(queryText, [
      countyFips,
      cursorFeatureIndex,
      take,
      opts.bufferMeters,
    ]);
    if (batch.length === 0) break;
    for (const r of batch) rows.push(r);
    parcelsFetched += batch.length;
    cursorFeatureIndex = Number(batch[batch.length - 1]?.feature_index ?? cursorFeatureIndex);
    if (batch.length < take) break;
  }
  return { rows, sqlMs: Date.now() - t0 };
}

export async function probeRrcPipelinePostgisReadiness(
  sql: Sql,
): Promise<RrcPipelinePostgisReadiness> {
  const [extRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM pg_extension
    WHERE extname = 'postgis'
  `;
  const postgisPresent = (extRow?.n ?? 0) > 0;

  const [pipeReg] = await sql<Array<{ reg: string | null }>>`
    SELECT to_regclass('public.tx_rrc_pipeline') AS reg
  `;
  const pipelineTablePresent = pipeReg?.reg != null;

  const [parcelReg] = await sql<Array<{ reg: string | null }>>`
    SELECT to_regclass('public.txgio_parcel') AS reg
  `;
  const parcelTablePresent = parcelReg?.reg != null;

  if (!postgisPresent) {
    return {
      postgisPresent,
      pipelineTablePresent,
      parcelTablePresent,
      ready: false,
      reason: "postgis extension not installed",
    };
  }
  if (!pipelineTablePresent) {
    return {
      postgisPresent,
      pipelineTablePresent,
      parcelTablePresent,
      ready: false,
      reason: "tx_rrc_pipeline table missing",
    };
  }
  if (!parcelTablePresent) {
    return {
      postgisPresent,
      pipelineTablePresent,
      parcelTablePresent,
      ready: false,
      reason: "txgio_parcel table missing",
    };
  }

  return {
    postgisPresent,
    pipelineTablePresent,
    parcelTablePresent,
    ready: true,
  };
}

export async function configureRrcPipelinePlanSession(sql: Sql): Promise<void> {
  await sql.unsafe(
    `SET statement_timeout = ${PLAN_STATEMENT_TIMEOUT_MS}`,
  );
  await sql.unsafe(`SET lock_timeout = ${PLAN_LOCK_TIMEOUT_MS}`);
}

export async function planCountyRrcPipelinePostgis(
  sql: Sql,
  opts: PostgisRrcPipelinePlanOptions,
): Promise<PostgisRrcPipelinePlanResult> {
  const countyFips = opts.countyFips;
  if (!/^\d{5}$/.test(countyFips)) {
    throw new Error(`invalid countyFips: ${countyFips}`);
  }

  const bufferMeters = opts.bufferMeters ?? RRC_PIPELINE_DEFAULT_BUFFER_METERS;
  const sourceReadFailed = opts.sourceReadFailed === true;
  const plannedAt = new Date().toISOString();

  await configureRrcPipelinePlanSession(sql);

  let pipelinesIndexed = 0;
  let pipelinesDeduped = 0;
  if (!sourceReadFailed) {
    const [pipeCount] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM tx_rrc_pipeline
      WHERE county_fips = ${countyFips}
    `;
    pipelinesIndexed = pipeCount?.n ?? 0;
    if (pipelinesIndexed > 0) {
      const [dedupeCount] = await sql<Array<{ n: number }>>`
        SELECT count(DISTINCT COALESCE(t4permit, '') || '|' || COALESCE(p5_num, ''))::int AS n
        FROM tx_rrc_pipeline
        WHERE county_fips = ${countyFips}
      `;
      pipelinesDeduped = dedupeCount?.n ?? 0;
    }
  }

  const [nullGeomRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND geometry IS NULL
  `;
  const skippedNullGeometry = nullGeomRow?.n ?? 0;

  const [featureRow] = await sql<Array<{ n: number }>>`
    SELECT count(DISTINCT feature_index)::int AS n
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
  `;
  const usable = featureRow?.n ?? 0;

  const batchSize = Math.max(
    1,
    Math.floor(opts.parcelBatchSize ?? DEFAULT_RRC_PIPELINE_PARCEL_BATCH),
  );
  const pipelineBatchSize = Math.max(
    1,
    Math.floor(opts.pipelineBatchSize ?? DEFAULT_PIPELINE_BATCH),
  );

  const useTempGist =
    usable >= METRO_TEMP_GIST_PARCEL_THRESHOLD &&
    (opts.limit == null || opts.limit <= 0 || opts.limit >= METRO_TEMP_GIST_PARCEL_THRESHOLD);

  let rows: HitRow[];
  let sqlMs: number;
  let planShape: PostgisRrcPipelinePlanMeta["planShape"];

  try {
    if (useTempGist) {
      planShape = "temp-gist-pipeline-major";
      const out = await planViaTempGist(sql, countyFips, {
        limit: opts.limit,
        pipelineBatchSize,
        bufferMeters,
        pipelinesIndexed,
        pipelinesDeduped,
        sourceReadFailed,
      });
      rows = out.rows;
      sqlMs = out.sqlMs;
    } else {
      planShape = "keyset-parcel-batch";
      const out = await planViaKeyset(sql, countyFips, {
        limit: opts.limit,
        parcelBatchSize: batchSize,
        bufferMeters,
        pipelinesIndexed,
        pipelinesDeduped,
        sourceReadFailed,
      });
      rows = out.rows;
      sqlMs = out.sqlMs;
    }
  } catch (err) {
    throw new Error(
      `rrc-pipeline-fact PostGIS plan FAILED for county ${countyFips}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Bad-geometry policy: NULL geometry rows are absent; ST_GeomFromGeoJSON ` +
        `throws abort the county plan (no silent empty membership).`,
    );
  }

  const plan = assemblePlanFromRows(countyFips, {
    bufferMeters,
    pipelinesIndexed,
    pipelinesDeduped,
    sourceReadFailed,
    rows,
  });

  return {
    plan,
    meta: {
      membershipMethodId: "postgis-geography-st-dwithin-buffer",
      plannedAt,
      bufferMeters,
      skippedNullGeometry,
      sqlMs,
      planShape,
      pipelinesIndexed,
      pipelinesDeduped,
      sourceReadFailed,
    },
  };
}

export interface RrcPipelinePlanParityDelta {
  parcelsCompared: number;
  nearFarFlips: number;
  flipRate: number;
  /** Parcel keys where nearPipeline differed. */
  flippedParcelKeys: string[];
}

/** Compare JS vs PostGIS plans on the same parcel keys (WDLL item 5 harness). */
export function compareRrcPipelinePlanParity(
  jsPlan: CountyRrcPipelinePlan,
  postgisPlan: CountyRrcPipelinePlan,
): RrcPipelinePlanParityDelta {
  const jsByKey = new Map(
    jsPlan.planned.map((p) => [p.parcelKey, p] as const),
  );
  const pgByKey = new Map(
    postgisPlan.planned.map((p) => [p.parcelKey, p] as const),
  );
  const keys = new Set([...jsByKey.keys(), ...pgByKey.keys()]);
  const flippedParcelKeys: string[] = [];

  for (const key of keys) {
    const js = jsByKey.get(key);
    const pg = pgByKey.get(key);
    const jsNear =
      js?.outcome === "present" ? js.nearPipeline === true : false;
    const pgNear =
      pg?.outcome === "present" ? pg.nearPipeline === true : false;
    if (jsNear !== pgNear) flippedParcelKeys.push(key);
  }

  const parcelsCompared = keys.size;
  const nearFarFlips = flippedParcelKeys.length;
  return {
    parcelsCompared,
    nearFarFlips,
    flipRate: parcelsCompared > 0 ? nearFarFlips / parcelsCompared : 0,
    flippedParcelKeys,
  };
}
