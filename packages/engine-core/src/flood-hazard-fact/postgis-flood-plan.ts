/**
 * PostGIS-backed `flood-hazard-fact` plan phase.
 *
 * D1 measured the JS plan phase at 99.4% of county wall time on zone-dense
 * counties (48099: 1,818,708 ms of 1,904,918 ms) because point-in-polygon is
 * O(parcels x zone vertices) in process. PR #313's JS grid did not help — the
 * mega-zones register in most cells, so vertex volume still dominates. This
 * module pushes the predicate into PostGIS, where a GiST index on the zone
 * geometry answers each centroid with a bounded index probe.
 *
 * Two backends, identical plan-record assembly:
 *   `postgis` — ST_Contains resolves the winning zone entirely in SQL.
 *   `hybrid`  — ST_Intersects returns ordered candidates and the JS ray cast in
 *               `pointInGeoJson` arbitrates. Slower, but it is the JS predicate
 *               to the bit, so it is the fallback if pure PostGIS loses parity.
 *
 * SEMANTIC DIFFERENCE, load-bearing: ST_Contains is false for a point exactly
 * on the polygon boundary; the JS crossing-number test classifies boundary
 * points by ray direction and will call some of them inside. `hybrid`
 * reproduces the JS answer because ST_Intersects includes the boundary and JS
 * remains the arbiter.
 */

import type { Sql } from "postgres";

import { pointInGeoJson, type BBox } from "./geo.js";
import {
  assembleCountyFloodHazardPlan,
  hasUsableCentroid,
  selectPlannableParcels,
  type CountyFloodHazardPlan,
  type FloodParcelInput,
  type ResolvedFloodZone,
} from "./plan-county-flood-hazard.js";

export const FLOOD_ZONE_TABLE = "tx_fema_nfhl_flood_zone";

/**
 * The zone table is injectable so the adversarial suite can run the SAME SQL
 * against a fixture table. Interpolated as an identifier, hence the whitelist.
 */
function assertTableIdent(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`unsafe flood zone table identifier: ${table}`);
  }
  return table;
}

/**
 * SFHA truthiness, expressed for SQL exactly as `isSfhaFlag` expresses it for
 * JS. Deliberately case-sensitive and deliberately not `lower(sfha_tf)`: a
 * looser SQL predicate would classify 'TRUE' as SFHA where JS does not.
 */
const SFHA_SQL_PREDICATE = "z.sfha_tf IN ('T','t','true')";

/** Zone ordering shared by both backends: SFHA first, then a stable id. */
const ZONE_ORDER_SQL = `ORDER BY CASE WHEN ${SFHA_SQL_PREDICATE} THEN 0 ELSE 1 END, z.zone_row_id`;

/** Candidate cap for the hybrid backend. Overlapping NFHL zones run 1-3 deep. */
const HYBRID_CANDIDATE_LIMIT = 16;

/**
 * `postgis`       — zone-major ST_Contains. The production path.
 * `postgis-point` — point-major LATERAL, one GiST probe per centroid. Same
 *                   verdicts, ~26x slower on zone-dense counties; kept as a
 *                   differential oracle, not as a fallback.
 * `hybrid`        — ST_Intersects candidates arbitrated by the JS ray cast.
 *                   The only path that reproduces JS boundary semantics.
 */
export type FloodPlanBackend = "postgis" | "postgis-point" | "hybrid";

/** Batch defaults differ because the two shapes pay different fixed costs. */
export function defaultPlanBatchSize(backend: FloodPlanBackend): number {
  return backend === "postgis" ? 25_000 : 2_000;
}

export interface FloodZoneGeomReadiness {
  geomColumnPresent: boolean;
  geomColumnType: string | null;
  geomColumnSrid: number | null;
  gistIndexPresent: boolean;
  gistIndexName: string | null;
  rowsTotal: number;
  geomPopulated: number;
  /** True only when every row carries geom — a NULL geom is a silent miss. */
  ready: boolean;
  reason: string | null;
}

/**
 * Probe whether the PostGIS plan path can run. Fails closed: a partially
 * populated geom column would emit "outside every zone" verdicts for the rows
 * it cannot see, which is indistinguishable from a real Zone X answer.
 */
export async function probeFloodZoneGeomReadiness(
  sql: Sql,
  table: string = FLOOD_ZONE_TABLE,
): Promise<FloodZoneGeomReadiness> {
  assertTableIdent(table);

  const [geomCol] = await sql<Array<{ udt_name: string }>>`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = 'geom'
  `;

  if (!geomCol) {
    return {
      geomColumnPresent: false,
      geomColumnType: null,
      geomColumnSrid: null,
      gistIndexPresent: false,
      gistIndexName: null,
      rowsTotal: 0,
      geomPopulated: 0,
      ready: false,
      reason: `${table}.geom column absent`,
    };
  }

  const [geomType] = await sql<Array<{ type: string; srid: number }>>`
    SELECT type, srid
    FROM geometry_columns
    WHERE f_table_schema = 'public'
      AND f_table_name = ${table}
      AND f_geometry_column = 'geom'
  `;

  const [gist] = await sql<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = ${table}
      AND indexdef ILIKE '%USING gist%'
      AND indexdef ILIKE '%(geom)%'
    ORDER BY indexname
    LIMIT 1
  `;

  const [counts] = await sql<
    Array<{ rows_total: number; geom_populated: number }>
  >`
    SELECT count(*)::int AS rows_total, count(geom)::int AS geom_populated
    FROM ${sql(table)}
  `;

  const rowsTotal = counts?.rows_total ?? 0;
  const geomPopulated = counts?.geom_populated ?? 0;
  const gistIndexPresent = gist != null;

  let reason: string | null = null;
  if (!gistIndexPresent) reason = "no GiST index on geom";
  else if (geomPopulated === 0) reason = "geom column present but unpopulated";
  else if (geomPopulated !== rowsTotal) {
    reason = `geom populated on ${geomPopulated}/${rowsTotal} rows — a NULL geom is an invisible zone`;
  }

  return {
    geomColumnPresent: true,
    geomColumnType: geomType?.type ?? null,
    geomColumnSrid: geomType?.srid ?? null,
    gistIndexPresent,
    gistIndexName: gist?.indexname ?? null,
    rowsTotal,
    geomPopulated,
    ready: reason === null,
    reason,
  };
}

/**
 * Count zones whose stored bbox intersects the query bbox — the same predicate
 * `filterZonesByBBox` applies in the JS path, so `zonesIndexed` and the
 * empty-zone-index absence rule stay identical across backends.
 */
export async function countZonesInBBox(
  sql: Sql,
  bbox: BBox,
  table: string = FLOOD_ZONE_TABLE,
): Promise<number> {
  assertTableIdent(table);
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM ${sql(table)}
    WHERE west_lng <= ${bbox.eastLng}
      AND east_lng >= ${bbox.westLng}
      AND south_lat <= ${bbox.northLat}
      AND north_lat >= ${bbox.southLat}
  `;
  return row?.n ?? 0;
}

/** Deterministic representative vintage for run provenance. */
export async function firstZoneVintageInBBox(
  sql: Sql,
  bbox: BBox,
  table: string = FLOOD_ZONE_TABLE,
): Promise<string | null> {
  assertTableIdent(table);
  const [row] = await sql<Array<{ source_vintage: string | null }>>`
    SELECT source_vintage
    FROM ${sql(table)}
    WHERE west_lng <= ${bbox.eastLng}
      AND east_lng >= ${bbox.westLng}
      AND south_lat <= ${bbox.northLat}
      AND north_lat >= ${bbox.southLat}
    ORDER BY zone_row_id
    LIMIT 1
  `;
  return row?.source_vintage ?? null;
}

interface ContainsRow {
  ord: number;
  zone_row_id: string | null;
  fld_zone: string | null;
  zone_subty: string | null;
  sfha_tf: string | null;
  static_bfe: number | string | null;
  source_vintage: string | null;
}

interface CandidateRow extends ContainsRow {
  geometry: unknown;
}

export function containsSql(table: string = FLOOD_ZONE_TABLE): string {
  assertTableIdent(table);
  return `
  SELECT p.ord::int AS ord,
         z.zone_row_id,
         z.fld_zone,
         z.zone_subty,
         z.sfha_tf,
         z.static_bfe,
         z.source_vintage
  FROM unnest($1::int[], $2::float8[], $3::float8[]) AS p(ord, lng, lat)
  LEFT JOIN LATERAL (
    SELECT z.zone_row_id, z.fld_zone, z.zone_subty, z.sfha_tf,
           z.static_bfe, z.source_vintage
    FROM ${table} z
    WHERE z.geom IS NOT NULL
      AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
    ${ZONE_ORDER_SQL}
    LIMIT 1
  ) z ON true
`;
}

/**
 * Zone-major containment: drive the loop from the zone side so each NFHL
 * polygon is detoasted and GEOS-prepared ONCE per batch.
 *
 * The point-major LATERAL above is index-correct and still measured 44 ms per
 * centroid on 48099 — EXPLAIN showed the GiST scan returning ~5 candidates and
 * then 305,201 shared-buffer touches for 100 points, i.e. the cost is
 * detoasting the same handful of county-spanning mega-polygons over and over.
 * Flipping the loop turns that into one detoast per zone plus a bbox
 * comparison and a prepared-geometry hit per point.
 *
 * Verdicts are identical by construction: same containment predicate, same
 * SFHA-then-zone_row_id tie-break, and the bbox guard is exactly the
 * `bboxContainsPoint` prefilter the JS path already applies.
 *
 * BOTH `MATERIALIZED` fences are load-bearing, not decoration. Inlining the
 * zone CTE (the default for a CTE referenced once) measured 48 ms per point on
 * 48099 — 180x worse — because the county bbox restriction stopped being
 * applied before the lateral. Inlining `pts` would re-evaluate `unnest` once
 * per zone. If either fence is removed, the query still returns the right
 * answer and quietly stops being fast.
 *
 * Params: $1 ords, $2 lngs, $3 lats, $4 west, $5 south, $6 east, $7 north.
 */
export function zoneMajorContainsSql(table: string = FLOOD_ZONE_TABLE): string {
  assertTableIdent(table);
  return `
  WITH pts AS MATERIALIZED (
    SELECT ord, lng, lat
    FROM unnest($1::int[], $2::float8[], $3::float8[]) AS t(ord, lng, lat)
  ),
  zones AS MATERIALIZED (
    SELECT z.zone_row_id, z.fld_zone, z.zone_subty, z.sfha_tf, z.static_bfe,
           z.source_vintage, z.geom,
           z.west_lng, z.south_lat, z.east_lng, z.north_lat
    FROM ${table} z
    WHERE z.geom IS NOT NULL
      AND z.west_lng <= $6 AND z.east_lng >= $4
      AND z.south_lat <= $7 AND z.north_lat >= $5
  ),
  hits AS (
    SELECT h.ord, z.zone_row_id, z.fld_zone, z.zone_subty, z.sfha_tf,
           z.static_bfe, z.source_vintage
    FROM zones z
    CROSS JOIN LATERAL (
      SELECT p.ord
      FROM pts p
      WHERE p.lng >= z.west_lng AND p.lng <= z.east_lng
        AND p.lat >= z.south_lat AND p.lat <= z.north_lat
        AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
    ) h
  )
  SELECT DISTINCT ON (ord)
         ord, zone_row_id, fld_zone, zone_subty, sfha_tf, static_bfe, source_vintage
  FROM hits
  ORDER BY ord,
           CASE WHEN sfha_tf IN ('T','t','true') THEN 0 ELSE 1 END,
           zone_row_id
`;
}

export function candidatesSql(table: string = FLOOD_ZONE_TABLE): string {
  assertTableIdent(table);
  return `
  SELECT p.ord::int AS ord,
         z.zone_row_id,
         z.fld_zone,
         z.zone_subty,
         z.sfha_tf,
         z.static_bfe,
         z.source_vintage,
         z.geometry
  FROM unnest($1::int[], $2::float8[], $3::float8[]) AS p(ord, lng, lat)
  JOIN LATERAL (
    SELECT z.zone_row_id, z.fld_zone, z.zone_subty, z.sfha_tf,
           z.static_bfe, z.source_vintage, z.geometry,
           row_number() OVER (
             ${ZONE_ORDER_SQL}
           ) AS rn
    FROM ${table} z
    WHERE z.geom IS NOT NULL
      AND ST_Intersects(z.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
    ${ZONE_ORDER_SQL}
    LIMIT ${HYBRID_CANDIDATE_LIMIT}
  ) z ON true
  ORDER BY p.ord, z.rn
`;
}

function toResolved(row: ContainsRow): ResolvedFloodZone {
  return {
    fldZone: row.fld_zone,
    zoneSubty: row.zone_subty,
    sfhaTf: row.sfha_tf,
    staticBfe: row.static_bfe == null ? null : Number(row.static_bfe),
    sourceVintage: row.source_vintage,
  };
}

export interface PostgisPlanOptions {
  countyFips: string;
  /** Padded county extent; drives `zonesIndexed` parity with the JS path. */
  bbox: BBox;
  backend?: FloodPlanBackend;
  /** Centroids per SQL round trip. */
  batchSize?: number;
  /** Pre-counted zone total; skips the count query when the caller has it. */
  zonesIndexed?: number;
  /** Zone table override — the adversarial suite points this at a fixture. */
  table?: string;
  onBatch?: (info: {
    batchIndex: number;
    batches: number;
    pointsResolved: number;
    pointsTotal: number;
    batchMs: number;
  }) => void;
}

export interface PostgisPlanResult {
  plan: CountyFloodHazardPlan;
  backend: FloodPlanBackend;
  zonesIndexed: number;
  pointsQueried: number;
  batches: number;
  batchSize: number;
  sqlMs: number;
  /** Hybrid only: candidates fetched, and how many the JS arbiter rejected. */
  candidatesFetched: number;
  candidatesRejectedByJs: number;
  /** Hybrid only: points that hit the candidate cap (a parity risk if nonzero). */
  candidateLimitHits: number;
}

export async function planCountyFloodHazardPostgis(
  sql: Sql,
  parcels: ReadonlyArray<FloodParcelInput>,
  opts: PostgisPlanOptions,
): Promise<PostgisPlanResult> {
  const backend = opts.backend ?? "postgis";
  const table = assertTableIdent(opts.table ?? FLOOD_ZONE_TABLE);
  const batchSize = Math.max(
    1,
    opts.batchSize ?? defaultPlanBatchSize(backend),
  );
  const selection = selectPlannableParcels(parcels);
  const zonesIndexed =
    opts.zonesIndexed ?? (await countZonesInBBox(sql, opts.bbox, table));
  const zoneMajorText = zoneMajorContainsSql(table);
  const containsText = containsSql(table);
  const candidatesText = candidatesSql(table);

  const resolved: Array<ResolvedFloodZone | null> = new Array(
    selection.items.length,
  ).fill(null);

  const queryable: number[] = [];
  if (zonesIndexed > 0) {
    for (let i = 0; i < selection.items.length; i++) {
      if (hasUsableCentroid(selection.items[i]!)) queryable.push(i);
    }
  }

  let sqlMs = 0;
  let candidatesFetched = 0;
  let candidatesRejectedByJs = 0;
  let candidateLimitHits = 0;
  const batches = Math.ceil(queryable.length / batchSize);

  for (let b = 0; b < batches; b++) {
    const slice = queryable.slice(b * batchSize, (b + 1) * batchSize);
    const ords = slice;
    const lngs = slice.map((i) => selection.items[i]!.centroid![0]);
    const lats = slice.map((i) => selection.items[i]!.centroid![1]);

    const t0 = Date.now();
    if (backend === "postgis") {
      const rows = await sql.unsafe<ContainsRow[]>(zoneMajorText, [
        ords,
        lngs,
        lats,
        opts.bbox.westLng,
        opts.bbox.southLat,
        opts.bbox.eastLng,
        opts.bbox.northLat,
      ]);
      for (const row of rows) {
        if (row.zone_row_id == null) continue;
        resolved[row.ord] = toResolved(row);
      }
    } else if (backend === "postgis-point") {
      const rows = await sql.unsafe<ContainsRow[]>(containsText, [
        ords,
        lngs,
        lats,
      ]);
      for (const row of rows) {
        if (row.zone_row_id == null) continue;
        resolved[row.ord] = toResolved(row);
      }
    } else {
      const rows = await sql.unsafe<CandidateRow[]>(candidatesText, [
        ords,
        lngs,
        lats,
      ]);
      candidatesFetched += rows.length;
      const perPoint = new Map<number, CandidateRow[]>();
      for (const row of rows) {
        const bucket = perPoint.get(row.ord);
        if (bucket) bucket.push(row);
        else perPoint.set(row.ord, [row]);
      }
      for (const [ord, candidates] of perPoint) {
        if (candidates.length >= HYBRID_CANDIDATE_LIMIT) candidateLimitHits += 1;
        const lng = selection.items[ord]!.centroid![0];
        const lat = selection.items[ord]!.centroid![1];
        let hit: CandidateRow | null = null;
        for (const candidate of candidates) {
          if (pointInGeoJson(lng, lat, candidate.geometry)) {
            hit = candidate;
            break;
          }
          candidatesRejectedByJs += 1;
        }
        if (hit) resolved[ord] = toResolved(hit);
      }
    }
    const batchMs = Date.now() - t0;
    sqlMs += batchMs;

    opts.onBatch?.({
      batchIndex: b,
      batches,
      pointsResolved: Math.min((b + 1) * batchSize, queryable.length),
      pointsTotal: queryable.length,
      batchMs,
    });
  }

  const plan = assembleCountyFloodHazardPlan(selection, resolved, {
    countyFips: opts.countyFips,
    zonesIndexed,
  });

  return {
    plan,
    backend,
    zonesIndexed,
    pointsQueried: queryable.length,
    batches,
    batchSize,
    sqlMs: Math.round(sqlMs),
    candidatesFetched,
    candidatesRejectedByJs,
    candidateLimitHits,
  };
}
