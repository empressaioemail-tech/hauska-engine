/**
 * retag-building-footprint-county-lib.mjs — pure helpers for the P-158
 * phase 3 county_fips retag job (OPS-23).
 *
 * Split out of retag-building-footprint-county.mjs deliberately: that
 * script imports `postgres` and executes a top-level `main()` as a module
 * side effect (the same shape every county writer script in this directory
 * uses -- see write-building-footprint-county.mjs, write-road-node-county.mjs).
 * This codebase's own convention is that such scripts are exercised via
 * spawnSync as a child process (writer-apply-lease.test.mjs), never
 * imported directly into the test runner's process -- direct import
 * dragged `postgres`'s module resolution into vitest's SSR/esbuild
 * pipeline and produced a misattributed "SyntaxError: Invalid or
 * unexpected token" at the IMPORTING test file's own import statement
 * (reproduced on a byte-identical copy under a different filename, and
 * confirmed NOT a real syntax error by both `node --check` and direct
 * esbuild 0.21.5/0.28.0 transformSync calls on the file in isolation).
 * This module has no side effects and no `postgres` import, so it is safe
 * to import directly, exactly like writer-target-env.mjs.
 */

export const TARGET_ENV_MISSING = "TARGET_ENV_MISSING";
export const TARGET_UNKNOWN = "TARGET_UNKNOWN";

export const TABLE = "tx_building_footprint";
export const BOUNDARY_TABLE = "tx_county_boundary";

// This job only ever reads the cortex/neondb SOURCE store (it corrects a
// staging-table tag, never mints an atom), so it deliberately does NOT reuse
// writer-target-env.mjs's resolveWriterTargetStores -- that helper requires
// BOTH the atoms pair (STAGING_HAUSKA_MCP_URL/PRODUCTION_HAUSKA_MCP_URL) and
// the source pair present for a target to resolve at all (proven live: the
// Cloud Run job refused TARGET_ENV_MISSING naming STAGING_HAUSKA_MCP_URL --
// a secret this job's own spec never grants and should not need to). Naming
// only the variable this job actually reads keeps its credential footprint
// to the one store it touches.
const SOURCE_VAR = Object.freeze({
  staging: "STAGING_NEONDB_URL",
  production: "PRODUCTION_NEONDB_URL",
});

export function resolveRetagSourceUrl(env, target) {
  if (!(target in SOURCE_VAR)) {
    const err = new Error(`unknown target: ${String(target)}`);
    err.code = TARGET_UNKNOWN;
    throw err;
  }
  const varName = SOURCE_VAR[target];
  const value = env?.[varName];
  if (typeof value !== "string" || value.trim() === "") {
    const err = new Error(`target ${target} is missing ${varName}`);
    err.code = TARGET_ENV_MISSING;
    err.target = target;
    err.missing = [varName];
    throw err;
  }
  return value;
}

export function parseCountyList(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Candidate rows: county polygons GiST-prefiltered against fp.geom's bbox, exact test via ST_Contains(centroid). */
export function primaryRetagSql(countyFips) {
  return {
    // MATERIALIZED is not optional: cb is a single row, but without it
    // Postgres 12+ may inline the ST_GeomFromGeoJSON/ST_MakeValid
    // expression into the join and re-parse the county's ~50-80KB GeoJSON
    // once per CANDIDATE ROW instead of once total -- proven live (this
    // job hung past 170s on a 2-county scoped run without MATERIALIZED,
    // and the same shape is exactly what p2-juris-store.mjs's own
    // `WITH county AS MATERIALIZED` comment already warns about on the
    // parcel side of this program).
    text: `
      WITH cb AS MATERIALIZED (
        SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom
        FROM ${BOUNDARY_TABLE}
        WHERE county_fips = $1
      )
      UPDATE ${TABLE} fp
      SET county_fips = $1
      FROM cb
      WHERE fp.geom && cb.geom
        AND ST_Contains(cb.geom, ST_Centroid(fp.geom))
        AND fp.county_fips IS DISTINCT FROM $1
      RETURNING fp.footprint_row_id
    `,
    values: [countyFips],
  };
}

export function primaryCountSql(countyFips) {
  return {
    // The containment test lives in the JOIN's own WHERE, never inside an
    // aggregate FILTER (falsifier: a FILTER-based cross join over 10.6M
    // rows cannot push `&&` down to the GiST index and times out; the
    // WHERE-clause join below is the one proven fast against production
    // by hand -- single-digit milliseconds to a few seconds per county).
    text: `
      WITH cb AS MATERIALIZED (
        SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom
        FROM ${BOUNDARY_TABLE}
        WHERE county_fips = $1
      ),
      true_rows AS MATERIALIZED (
        SELECT fp.footprint_row_id, fp.county_fips
        FROM ${TABLE} fp, cb
        WHERE fp.geom && cb.geom
          AND ST_Contains(cb.geom, ST_Centroid(fp.geom))
      )
      SELECT
        (SELECT count(*) FROM true_rows) AS true_count,
        (SELECT count(*) FROM true_rows WHERE county_fips = $1) AS already_correct,
        (SELECT count(*) FROM ${TABLE} WHERE county_fips = $1) AS currently_tagged
    `,
    values: [countyFips],
  };
}

/** All 254 county polygons, parsed once. Every fallback/residual query reuses this instead of re-parsing GeoJSON per candidate row. */
const COUNTIES_GEOM_CTE = `
  counties_geom AS MATERIALIZED (
    SELECT county_fips,
           ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)) AS geom
    FROM ${BOUNDARY_TABLE}
    WHERE state_fips = '48'
  )
`;

/** Residual rows whose centroid is inside NO county polygon at all -- fallback candidates. */
export const RESIDUAL_UNRESOLVED_SQL = `
  WITH ${COUNTIES_GEOM_CTE}
  SELECT count(*)::bigint AS n
  FROM ${TABLE} fp
  WHERE NOT EXISTS (
    SELECT 1 FROM counties_geom cb
    WHERE fp.geom && cb.geom
      AND ST_Contains(cb.geom, ST_Centroid(fp.geom))
  )
`;

export const RESIDUAL_UNRESOLVED_ROWS_SQL = `
  WITH ${COUNTIES_GEOM_CTE}
  SELECT fp.footprint_row_id
  FROM ${TABLE} fp
  WHERE NOT EXISTS (
    SELECT 1 FROM counties_geom cb
    WHERE fp.geom && cb.geom
      AND ST_Contains(cb.geom, ST_Centroid(fp.geom))
  )
`;

/** Largest-overlap-area fallback for one residual row's footprint_row_id. */
export function fallbackLargestOverlapSql(footprintRowId) {
  return {
    text: `
      WITH ${COUNTIES_GEOM_CTE}
      SELECT cb.county_fips,
             ST_Area(ST_Intersection(fp.geom, cb.geom)) AS overlap_deg2
      FROM ${TABLE} fp
      JOIN counties_geom cb
        ON fp.geom && cb.geom
      WHERE fp.footprint_row_id = $1
      ORDER BY overlap_deg2 DESC
      LIMIT 1
    `,
    values: [footprintRowId],
  };
}
