/**
 * Adversarial point-in-polygon cases for the flood plan backends.
 *
 * The JS half runs everywhere and pins the incumbent semantics — every flood
 * atom written to date was planned with `pointInGeoJson`, so those verdicts are
 * the thing a PostGIS backend has to be graded against, not a fresh intuition
 * about what containment ought to mean.
 *
 * The PostGIS half needs a live PostGIS database; set FLOOD_POSTGIS_TEST_URL to
 * run it. It builds a fixture zone table shaped like `tx_fema_nfhl_flood_zone`
 * and runs the SAME SQL the county writer runs.
 *
 * WHERE THE BACKENDS DIVERGE, AND WHY IT IS NOT A DEFECT:
 *   ST_Contains(polygon, point) is FALSE for a point exactly on the boundary —
 *   PostGIS defines containment on the interior. The JS crossing-number test
 *   has no such rule: it counts ray crossings, so a boundary point lands inside
 *   or outside depending on which edge it sits on (fixture P02 is inside to JS
 *   and outside to PostGIS; the corner P03 is outside to both). The `hybrid`
 *   backend exists for exactly this: ST_Intersects proposes candidates
 *   boundary-inclusive and the JS predicate arbitrates, so hybrid reproduces
 *   the JS verdict at the cost of shipping candidate geometry to the client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { findZoneAtPoint } from "../flood-hazard-fact/geo.js";
import {
  buildFloodZoneGrid,
  findZoneAtPointWithGrid,
} from "../flood-hazard-fact/flood-zone-grid.js";
import {
  planCountyFloodHazardPostgis,
  probeFloodZoneGeomReadiness,
} from "../flood-hazard-fact/postgis-flood-plan.js";
import {
  PIP_CASES,
  PIP_EXPECTED_DIVERGENCES,
  PIP_FIXTURE_BBOX,
  PIP_FIXTURE_COUNTY,
  PIP_FIXTURE_TABLE,
  PIP_JS_ZONES,
  PIP_PARCELS,
  PIP_ZONE_FIXTURES,
} from "./fixtures/flood-pip-cases.js";

const TEST_URL = process.env.FLOOD_POSTGIS_TEST_URL?.trim();

describe("incumbent JS point-in-polygon semantics", () => {
  it("linear scan produces the documented verdict on every adversarial case", () => {
    for (const c of PIP_CASES) {
      const hit = findZoneAtPoint(c.point[0], c.point[1], PIP_JS_ZONES);
      expect(hit?.fldZone ?? null, c.name).toBe(c.js);
    }
  });

  it("grid path agrees with the linear scan on every adversarial case", () => {
    const grid = buildFloodZoneGrid(PIP_JS_ZONES, PIP_FIXTURE_BBOX)!;
    for (const c of PIP_CASES) {
      const hit = findZoneAtPointWithGrid(c.point[0], c.point[1], grid, PIP_JS_ZONES);
      expect(hit?.fldZone ?? null, c.name).toBe(c.js);
    }
  });

  it("boundary incidence is the only place the two predicates are expected to part", () => {
    expect(PIP_EXPECTED_DIVERGENCES).toEqual(["exactly on a zone boundary edge"]);
  });
});

describe.skipIf(!TEST_URL)("PostGIS flood PIP — adversarial cases", () => {
  const sql = postgres(TEST_URL ?? "", { max: 2, prepare: false });

  beforeAll(async () => {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${PIP_FIXTURE_TABLE}`);
    await sql.unsafe(`
      CREATE TABLE ${PIP_FIXTURE_TABLE} (
        zone_row_id text PRIMARY KEY,
        fld_zone text,
        zone_subty text,
        sfha_tf text,
        static_bfe double precision,
        geometry jsonb NOT NULL,
        west_lng double precision,
        south_lat double precision,
        east_lng double precision,
        north_lat double precision,
        source_vintage text,
        source_citation text,
        geom geometry(Geometry, 4326)
      )`);
    for (const z of PIP_JS_ZONES) {
      await sql.unsafe(
        `INSERT INTO ${PIP_FIXTURE_TABLE}
           (zone_row_id, fld_zone, zone_subty, sfha_tf, static_bfe, geometry,
            west_lng, south_lat, east_lng, north_lat, source_vintage)
         VALUES ($1, $2, NULL, $3, NULL, $4::text::jsonb, $5, $6, $7, $8, 'fixture')`,
        [
          z.zoneRowId,
          z.fldZone,
          z.sfhaTf,
          JSON.stringify(z.geometry),
          z.westLng,
          z.southLat,
          z.eastLng,
          z.northLat,
        ],
      );
    }
    await sql.unsafe(
      `UPDATE ${PIP_FIXTURE_TABLE}
         SET geom = ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)`,
    );
    await sql.unsafe(
      `CREATE INDEX ${PIP_FIXTURE_TABLE}_geom_gist_idx
         ON ${PIP_FIXTURE_TABLE} USING GIST (geom)`,
    );
    await sql.unsafe(`ANALYZE ${PIP_FIXTURE_TABLE}`);
  }, 120_000);

  afterAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${PIP_FIXTURE_TABLE}`);
    await sql.end({ timeout: 5 });
  });

  it("reports the fixture table as ready", async () => {
    const readiness = await probeFloodZoneGeomReadiness(sql, PIP_FIXTURE_TABLE);
    expect(readiness.geomColumnPresent).toBe(true);
    expect(readiness.gistIndexPresent).toBe(true);
    expect(readiness.geomPopulated).toBe(PIP_ZONE_FIXTURES.length);
    expect(readiness.ready).toBe(true);
  }, 60_000);

  it("fails closed when a single row is missing geom", async () => {
    await sql.unsafe(
      `UPDATE ${PIP_FIXTURE_TABLE} SET geom = NULL WHERE zone_row_id = 'z10-boundary'`,
    );
    try {
      const readiness = await probeFloodZoneGeomReadiness(sql, PIP_FIXTURE_TABLE);
      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toMatch(/geom populated/);
    } finally {
      await sql.unsafe(
        `UPDATE ${PIP_FIXTURE_TABLE}
           SET geom = ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)
         WHERE zone_row_id = 'z10-boundary'`,
      );
    }
  }, 60_000);

  it("pure PostGIS matches the documented ST_Contains verdicts", async () => {
    const result = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis",
      table: PIP_FIXTURE_TABLE,
    });
    const byKey = new Map(
      result.plan.planned.map((p) => [
        p.parcelKey,
        p.outcome === "present" ? p.floodZone : "ABSENT",
      ]),
    );
    for (const c of PIP_CASES) {
      expect(byKey.get(c.key), c.name).toBe(c.postgis);
    }
  }, 60_000);

  it("point-major and zone-major agree on every case", async () => {
    const zoneMajor = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis",
      table: PIP_FIXTURE_TABLE,
    });
    const pointMajor = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis-point",
      table: PIP_FIXTURE_TABLE,
    });
    expect(zoneMajor.plan.planned).toEqual(pointMajor.plan.planned);
  }, 60_000);

  it("hybrid reproduces the JS verdict on every case, boundary included", async () => {
    const result = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "hybrid",
      table: PIP_FIXTURE_TABLE,
    });
    const byKey = new Map(
      result.plan.planned.map((p) => [
        p.parcelKey,
        p.outcome === "present" ? p.floodZone : "ABSENT",
      ]),
    );
    for (const c of PIP_CASES) {
      expect(byKey.get(c.key), c.name).toBe(c.js);
    }
    expect(result.candidateLimitHits).toBe(0);
  }, 60_000);

  it("pure PostGIS differs from JS ONLY on the boundary-incident point", async () => {
    const result = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis",
      table: PIP_FIXTURE_TABLE,
    });
    const disagreements: string[] = [];
    for (const planned of result.plan.planned) {
      const c = PIP_CASES.find((x) => x.key === planned.parcelKey)!;
      const zone = planned.outcome === "present" ? planned.floodZone : "ABSENT";
      if (zone !== c.js) disagreements.push(c.name);
    }
    expect(disagreements).toEqual(PIP_EXPECTED_DIVERGENCES);
  }, 60_000);

  it("keeps the SFHA-then-zone_row_id tie-break stable across repeats", async () => {
    for (let i = 0; i < 3; i++) {
      const run = await planCountyFloodHazardPostgis(
        sql,
        [{ parcelKey: "P08", centroid: [8, 8] }],
        {
          countyFips: PIP_FIXTURE_COUNTY,
          bbox: PIP_FIXTURE_BBOX,
          backend: "postgis",
          table: PIP_FIXTURE_TABLE,
        },
      );
      const planned = run.plan.planned[0]!;
      expect(planned.outcome).toBe("present");
      expect(planned.outcome === "present" && planned.floodZone).toBe("AE");
    }
  }, 60_000);

  it("batching does not change the plan", async () => {
    const one = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis",
      table: PIP_FIXTURE_TABLE,
      batchSize: 1,
    });
    const all = await planCountyFloodHazardPostgis(sql, PIP_PARCELS, {
      countyFips: PIP_FIXTURE_COUNTY,
      bbox: PIP_FIXTURE_BBOX,
      backend: "postgis",
      table: PIP_FIXTURE_TABLE,
      batchSize: 1000,
    });
    expect(one.plan.planned).toEqual(all.plan.planned);
    expect(one.batches).toBe(PIP_PARCELS.length);
    expect(all.batches).toBe(1);
  }, 120_000);
});
