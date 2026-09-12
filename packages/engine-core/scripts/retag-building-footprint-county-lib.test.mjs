import { describe, expect, it } from "vitest";
import {
  BOUNDARY_TABLE,
  RESIDUAL_UNRESOLVED_ROWS_SQL,
  RESIDUAL_UNRESOLVED_SQL,
  TABLE,
  TARGET_ENV_MISSING,
  TARGET_UNKNOWN,
  fallbackLargestOverlapSql,
  parseCountyList,
  primaryCountSql,
  primaryRetagSql,
  resolveRetagSourceUrl,
} from "./retag-building-footprint-county-lib.mjs";

describe("retag-building-footprint-county (P-158 phase 3)", () => {
  it("parses a comma-separated county list, trimming and dropping empties", () => {
    expect(parseCountyList("48021, 48453")).toEqual(["48021", "48453"]);
    expect(parseCountyList("48021,,48453,")).toEqual(["48021", "48453"]);
  });

  it("an absent/blank county list means unscoped (statewide) -- never an empty array", () => {
    expect(parseCountyList(undefined)).toBeNull();
    expect(parseCountyList("")).toBeNull();
    expect(parseCountyList("   ")).toBeNull();
  });

  it("the primary retag UPDATE is idempotent by construction: it only touches rows whose tag differs from the target county", () => {
    const { text, values } = primaryRetagSql("48021");
    expect(values).toEqual(["48021"]);
    expect(text).toMatch(/UPDATE\s+tx_building_footprint/i);
    expect(text).toMatch(/SET county_fips = \$1/);
    expect(text).toMatch(/ST_Contains\(cb\.geom, ST_Centroid\(fp\.geom\)\)/);
    expect(text).toMatch(/IS DISTINCT FROM \$1/);
    // The GiST-indexed bbox prefilter must run before the exact containment
    // test, never a bare full-table ST_Contains (falsifier: dropping the
    // `&&` prefilter still returns the same rows, just far slower on 10.6M).
    expect(text).toMatch(/fp\.geom && cb\.geom/);
    // Falsifier this test guards: a plain `WITH cb AS (...)` (no
    // MATERIALIZED) let Postgres re-parse the county's GeoJSON per
    // candidate row and hung a scoped 2-county dry run past 170s live
    // against the staging store -- MATERIALIZED is load-bearing, not decor.
    expect(text).toMatch(/WITH cb AS MATERIALIZED/);
  });

  it("the primary count query reports true-geometric, already-correct, and currently-tagged as three distinct counted classes, never one derived by subtraction (DEV_PROCESS 1.3)", () => {
    const { text, values } = primaryCountSql("48453");
    expect(values).toEqual(["48453"]);
    expect(text).toMatch(/true_count/);
    expect(text).toMatch(/already_correct/);
    expect(text).toMatch(/currently_tagged/);
  });

  it("the residual-unresolved query is a real anti-join (NOT EXISTS), never a subtraction from the primary pass's own count, and reuses one materialized county-geometry CTE rather than re-parsing GeoJSON per candidate row", () => {
    expect(RESIDUAL_UNRESOLVED_SQL).toMatch(/NOT EXISTS/);
    expect(RESIDUAL_UNRESOLVED_SQL).toMatch(new RegExp(TABLE));
    expect(RESIDUAL_UNRESOLVED_SQL).toMatch(new RegExp(BOUNDARY_TABLE));
    expect(RESIDUAL_UNRESOLVED_SQL).toMatch(/MATERIALIZED/);
    expect(RESIDUAL_UNRESOLVED_ROWS_SQL).toMatch(/NOT EXISTS/);
    expect(RESIDUAL_UNRESOLVED_ROWS_SQL).toMatch(/MATERIALIZED/);
  });

  it("resolveRetagSourceUrl reads ONLY the cortex/neondb source pair, never the atoms pair (falsifier: this job's Cloud Run execution refused TARGET_ENV_MISSING naming STAGING_HAUSKA_MCP_URL, a secret this job's spec never grants and should not need, before this fix)", () => {
    expect(resolveRetagSourceUrl({ STAGING_NEONDB_URL: "postgres://staging-source/db" }, "staging")).toBe(
      "postgres://staging-source/db",
    );
    expect(
      resolveRetagSourceUrl({ PRODUCTION_NEONDB_URL: "postgres://prod-source/db" }, "production"),
    ).toBe("postgres://prod-source/db");
  });

  it("resolveRetagSourceUrl refuses a missing variable by naming it, never falling back across targets", () => {
    try {
      resolveRetagSourceUrl({ PRODUCTION_NEONDB_URL: "x" }, "staging");
      expect.fail("expected TARGET_ENV_MISSING");
    } catch (err) {
      expect(err.code).toBe(TARGET_ENV_MISSING);
      expect(err.missing).toEqual(["STAGING_NEONDB_URL"]);
    }
  });

  it("resolveRetagSourceUrl refuses an unknown target", () => {
    try {
      resolveRetagSourceUrl({}, "prod");
      expect.fail("expected TARGET_UNKNOWN");
    } catch (err) {
      expect(err.code).toBe(TARGET_UNKNOWN);
    }
  });

  it("the fallback picks the LARGEST overlap area among bbox-adjacent counties, never the first match", () => {
    const { text, values } = fallbackLargestOverlapSql("ml:ml-123");
    expect(values).toEqual(["ml:ml-123"]);
    expect(text).toMatch(/ST_Area\(ST_Intersection\(/);
    expect(text).toMatch(/ORDER BY overlap_deg2 DESC/);
    expect(text).toMatch(/LIMIT 1/);
  });
});
